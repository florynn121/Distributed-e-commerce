import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createAuth, digest, matchesSecret } from './auth.js';
import { readConfig } from './config.js';
import catalog from './catalog.json' with { type: 'json' };

const publicPath = fileURLToPath(new URL('./public/', import.meta.url));
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const requestIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const contentSecurityPolicy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
].join('; ');

function problem(res, status, title, detail) {
    return res.status(status).type('application/problem+json').json({
        title,
        status,
        detail,
        requestId: res.get('x-request-id')
    });
}

function requireJson(req, res, next) {
    if (!req.is('application/json')) {
        return problem(res, 415, 'Unsupported media type', 'Send application/json.');
    }
    next();
}

function checkoutSelection(body) {
    if (!body || Array.isArray(body) || typeof body !== 'object') return null;
    if (typeof body.sku === 'string' && Object.keys(body).length === 1) {
        return catalog.products.find((product) => product.sku === body.sku);
    }
    if (typeof body.product === 'string' && Object.keys(body).length === 2) {
        return catalog.products.find((product) =>
            product.name === body.product && product.priceCents / 100 === body.price
        );
    }
    return null;
}

export function createApp(config, { fetchOrder = fetch, accessKeySet } = {}) {
    const auth = createAuth(config, accessKeySet);
    const edgeTokenDigest = config.mode === 'access' ? digest(config.edgeOriginToken) : null;
    const readJson = express.json({ limit: '8kb', inflate: false });

    const app = express();
    app.disable('x-powered-by');
    app.disable('etag');
    app.enable('case sensitive routing');
    app.enable('strict routing');
    app.locals.draining = false;

    app.use((req, res, next) => {
        res.set({
            'Cache-Control': 'no-store',
            'Content-Security-Policy': contentSecurityPolicy,
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-Request-Id': randomUUID()
        });
        next();
    });

    app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
    app.get('/health/ready', async (_req, res) => {
        if (app.locals.draining) return res.status(503).json({ status: 'draining' });
        try {
            const response = await fetchOrder(new URL('/actuator/health/readiness', config.orderOrigin), {
                signal: AbortSignal.timeout(Math.min(config.orderTimeoutMs, 2000)),
                redirect: 'error'
            });
            await response.body?.cancel();
            if (response.ok) return res.json({ status: 'ok' });
        } catch {
            // The order service is unreachable. Readiness remains false.
        }
        return res.status(503).json({ status: 'unavailable' });
    });

    if (config.mode === 'access') {
        app.use((req, res, next) => {
            if (!matchesSecret(req.get('x-edge-origin-token'), edgeTokenDigest)) {
                return problem(res, 403, 'Forbidden', 'Use the storefront URL.');
            }
            const inboundRequestId = req.get('x-request-id');
            if (requestIdPattern.test(inboundRequestId ?? '')) {
                res.set('X-Request-Id', inboundRequestId);
            }
            next();
        });
    }

    const requireSameOrigin = (req, res, next) => {
        const submittedOrigin = req.get('origin');
        const expectedOrigin = config.publicOrigin ?? `${req.protocol}://${req.get('host')}`;
        if ((submittedOrigin && submittedOrigin !== expectedOrigin) || req.get('sec-fetch-site') === 'cross-site') {
            return problem(res, 403, 'Forbidden', 'Submit checkout requests from the storefront.');
        }
        next();
    };

    const requireShopper = async (req, res, next) => {
        try {
            const shopper = await auth.verify(req);
            if (shopper) {
                req.shopper = shopper;
                return next();
            }
        } catch (error) {
            if (auth.unavailable(error)) {
                return problem(res, 503, 'Authentication unavailable', 'Try again shortly.');
            }
        }
        if (config.mode === 'local') res.set('WWW-Authenticate', 'Bearer');
        return problem(res, 401, 'Sign-in required', 'Sign in and try again.');
    };

    if (config.mode === 'local') {
        const limitLogin = rateLimit({
            windowMs: 60_000,
            limit: 10,
            skipSuccessfulRequests: true,
            standardHeaders: 'draft-8',
            legacyHeaders: false,
            handler: (_req, res) => problem(res, 429, 'Too many attempts', 'Wait a minute and try again.')
        });
        app.post('/login', requireSameOrigin, limitLogin, requireJson, readJson, async (req, res) => {
            const token = await auth.login(req.body?.password);
            if (!token) return problem(res, 401, 'Sign-in failed', 'Check the local storefront password.');
            return res.json({ token });
        });

        app.get('/api/session', (_req, res) => res.json({ mode: config.mode }));
    } else {
        app.get('/api/session', requireShopper, (_req, res) => res.json({ mode: config.mode }));
    }
    app.get('/api/catalog', (_req, res) => res.json(catalog));

    const logCheckout = (_req, res, next) => {
        const startedAt = performance.now();
        res.on('finish', () => console.log(JSON.stringify({
            event: 'checkout_response',
            requestId: res.get('x-request-id'),
            status: res.statusCode,
            durationMs: Math.round(performance.now() - startedAt)
        })));
        next();
    };

    app.post('/api/orders/checkout', logCheckout, requireSameOrigin, requireShopper, requireJson, readJson, async (req, res) => {
        const key = req.get('idempotency-key');
        if (!idempotencyKeyPattern.test(key ?? '')) {
            return problem(res, 400, 'Invalid idempotency key', 'Provide an Idempotency-Key for each order.');
        }
        const product = checkoutSelection(req.body);
        if (!product) {
            return problem(res, 400, 'Invalid product selection', 'Select a product from the current catalog.');
        }

        // A single client key can be used by different shoppers without linking their orders.
        const orderKey = digest(JSON.stringify([req.shopper.iss, req.shopper.sub, key])).toString('hex');
        const signal = AbortSignal.timeout(config.orderTimeoutMs);
        let upstream;
        let responseBody;
        try {
            upstream = await fetchOrder(new URL('/api/orders/checkout', config.orderOrigin), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': orderKey,
                    'X-Checkout-Service-Token': config.checkoutServiceToken,
                    'X-Request-Id': res.get('x-request-id')
                },
                body: JSON.stringify({ product: product.name, price: product.priceCents / 100 }),
                redirect: 'error',
                signal
            });
            if (upstream.status === 200 || upstream.status === 201) {
                responseBody = await upstream.json();
            } else {
                await upstream.body?.cancel();
            }
        } catch (error) {
            if (signal.aborted) {
                return problem(res, 504, 'Checkout timed out', 'Retry with the same idempotency key.');
            }
            console.error(JSON.stringify({
                event: 'checkout_upstream_error',
                requestId: res.get('x-request-id'),
                error: error.name
            }));
            return problem(res, 502, 'Checkout unavailable', 'Retry with the same idempotency key.');
        }

        if (upstream.status === 200 || upstream.status === 201) {
            return res.status(upstream.status).json(responseBody);
        }
        if (upstream.status === 409) {
            return problem(res, 409, 'Order conflict', 'This idempotency key belongs to a different order.');
        }
        if (upstream.status === 400 || upstream.status === 422) {
            return problem(res, upstream.status, 'Order rejected', 'Check the product selection and try again.');
        }
        console.error(JSON.stringify({
            event: 'checkout_upstream_status',
            requestId: res.get('x-request-id'),
            status: upstream.status
        }));
        return problem(res, 502, 'Checkout unavailable', 'Retry with the same idempotency key.');
    });

    app.use(express.static(publicPath, {
        dotfiles: 'deny',
        etag: false,
        lastModified: false,
        redirect: false
    }));
    app.use((_req, res) => problem(res, 404, 'Not found', 'This route does not exist.'));
    app.use((error, _req, res, next) => {
        if (res.headersSent) return next(error);
        if (error.type === 'entity.too.large') {
            return problem(res, 413, 'Request too large', 'Limit request bodies to 8 KB.');
        }
        if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') {
            return problem(res, 415, 'Unsupported media type', 'Send uncompressed UTF-8 JSON.');
        }
        if (error.type === 'entity.parse.failed' || error.status === 400) {
            return problem(res, 400, 'Invalid request', 'Check the request format.');
        }
        if (error.status === 403 || error.status === 404) {
            return problem(res, 404, 'Not found', 'This route does not exist.');
        }
        console.error(JSON.stringify({
            event: 'gateway_error',
            requestId: res.get('x-request-id'),
            error: error.name
        }));
        return problem(res, 500, 'Server error', 'Try again shortly.');
    });
    return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const config = readConfig();
    const app = createApp(config);
    const server = app.listen(config.port, '0.0.0.0', () => {
        console.log(JSON.stringify({ event: 'gateway_started', mode: config.mode, port: config.port }));
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 5_000;

    function stop() {
        app.locals.draining = true;
        server.close();
        setTimeout(() => server.closeAllConnections(), 10_000).unref();
    }
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}

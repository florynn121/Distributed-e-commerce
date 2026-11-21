import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { readConfig } from '../config.js';
import { createApp } from '../index.js';

const common = {
    CHECKOUT_SERVICE_TOKEN: 'checkout-service-secret-for-tests',
    ORDER_SERVICE_URL: 'http://orders.internal:8080',
    ORDER_TIMEOUT_MS: '100'
};
const password = 'local-store-password';
const originToken = 'edge-origin-secret-for-gateway-tests';
const local = readConfig({
    ...common,
    AUTH_MODE: 'local',
    JWT_SECRET: 'local-signing-secret-for-gateway-tests',
    GATEWAY_LOGIN_PASSWORD: password
});
const access = readConfig({
    ...common,
    AUTH_MODE: 'access',
    EDGE_ORIGIN_TOKEN: originToken,
    CLOUDFLARE_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    CLOUDFLARE_ACCESS_AUDIENCE: 'checkout-access-audience',
    PUBLIC_ORIGIN: 'https://store.example.com'
});

async function serverFor(t, config, dependencies) {
    const app = createApp(config, dependencies);
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
}

function json(body, headers = {}) {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
    };
}

async function signIn(request) {
    const response = await request('/login', json({ password }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return `Bearer ${(await response.json()).token}`;
}

test('configuration fails closed and accepts deployable mode-specific URLs', () => {
    assert.throws(() => readConfig(common), /AUTH_MODE/);
    assert.throws(() => readConfig({ ...common, AUTH_MODE: 'local' }), /GATEWAY_LOGIN_PASSWORD/);
    assert.throws(() => readConfig({ ...common, AUTH_MODE: 'access' }), /CLOUDFLARE_ACCESS_ISSUER/);
    assert.equal(access.publicOrigin, 'https://store.example.com');
    assert.equal(local.orderOrigin, 'http://orders.internal:8080');
});

test('local checkout enforces sign-in and uses catalog price, stable shopper key, and upstream status', async (t) => {
    const orders = [];
    const request = await serverFor(t, local, {
        fetchOrder: async (url, options) => {
            orders.push(options.headers['Idempotency-Key']);
            assert.equal(url.href, 'http://orders.internal:8080/api/orders/checkout');
            assert.equal(options.headers['X-Checkout-Service-Token'], common.CHECKOUT_SERVICE_TOKEN);
            assert.deepEqual(JSON.parse(options.body), { product: 'Studio Laptop', price: 1499.99 });
            assert.equal(options.redirect, 'error');
            return Response.json({ id: 17, product: 'Studio Laptop', price: 1499.99 }, {
                status: orders.length === 1 ? 201 : 200
            });
        }
    });
    assert.equal((await request('/api/catalog')).status, 200);
    assert.equal((await request('/login', json({ password: 'wrong' }))).status, 401);
    assert.equal((await request('/api/orders/checkout', json({ sku: 'studio-laptop' }))).status, 401);
    const Authorization = await signIn(request);
    const headers = { Authorization, 'Idempotency-Key': 'local-order-key' };
    assert.equal((await request('/api/orders/checkout', json({ sku: 'studio-laptop' }, { Authorization }))).status, 400);
    assert.equal((await request('/api/orders/checkout', json({ product: 'Studio Laptop', price: 1 }, headers))).status, 400);
    const first = await request('/api/orders/checkout', json({ sku: 'studio-laptop' }, headers));
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('Cache-Control'), 'no-store');
    assert.equal((await first.json()).id, 17);
    const replay = await request('/api/orders/checkout', json({ product: 'Studio Laptop', price: 1499.99 }, headers));
    assert.equal(replay.status, 200);
    assert.deepEqual(orders, [orders[0], orders[0]]);
    assert.match(orders[0], /^[a-f0-9]{64}$/);
});

test('checkout maps conflict and timeout without exposing the upstream response', async (t) => {
    const request = await serverFor(t, local, {
        fetchOrder: (_url, options) => {
            if (JSON.parse(options.body).product === 'Studio Laptop') {
                return Promise.resolve(new Response('private details', { status: 409 }));
            }
            return new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            });
        }
    });
    const headers = { Authorization: await signIn(request), 'Idempotency-Key': 'retry-same-key' };
    const conflict = await request('/api/orders/checkout', json({ sku: 'studio-laptop' }, headers));
    assert.equal(conflict.status, 409);
    assert.match(conflict.headers.get('Content-Type'), /^application\/problem\+json/);
    assert.equal((await conflict.json()).title, 'Order conflict');
    const timeout = await request('/api/orders/checkout', json({ sku: 'usb-c-hub' }, headers));
    assert.equal(timeout.status, 504);
    assert.match((await timeout.json()).detail, /same idempotency key/);
});

test('Access mode requires origin authentication and signed shopper claims for checkout', async (t) => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    function sign({ subject = 'shopper-one', audience = access.accessAudience, human = true } = {}) {
        return new SignJWT(human ? { email: 'shopper@example.com' } : {})
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(access.accessIssuer)
            .setAudience(audience)
            .setSubject(subject)
            .setIssuedAt()
            .setExpirationTime('10m')
            .sign(privateKey);
    }
    const orders = [];
    const request = await serverFor(t, access, {
        accessKeySet: publicKey,
        fetchOrder: async (_url, options) => {
            orders.push(options.headers['Idempotency-Key']);
            return Response.json({ id: 17 }, { status: 201 });
        }
    });

    assert.equal((await request('/api/session')).status, 403);
    assert.equal((await request('/api/catalog')).status, 403);
    const edgeHeaders = { 'X-Edge-Origin-Token': originToken };
    const requestId = randomUUID();
    const headers = {
        ...edgeHeaders,
        'X-Request-Id': requestId,
        'Idempotency-Key': 'shared-request-key',
        'X-Shopper-Access-JWT': await sign()
    };
    assert.equal((await request('/api/session', { headers: edgeHeaders })).status, 401);
    assert.equal((await request('/api/catalog', { headers: edgeHeaders })).status, 200);
    assert.equal((await request('/api/session', { headers })).status, 200);
    assert.equal((await request('/login', json({ password }, headers))).status, 404);
    const first = await request('/api/orders/checkout', json({ sku: 'usb-c-hub' }, headers));
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('X-Request-Id'), requestId);

    headers['X-Shopper-Access-JWT'] = await sign({ subject: 'shopper-two' });
    assert.equal((await request('/api/orders/checkout', json({ sku: 'usb-c-hub' }, headers))).status, 201);
    assert.notEqual(orders[0], orders[1]);
    assert.equal((await request('/api/orders/checkout', json({ sku: 'usb-c-hub' }, {
        ...headers, Origin: 'https://other.example.com'
    }))).status, 403);
    headers['X-Shopper-Access-JWT'] = await sign({ audience: 'wrong-audience' });
    assert.equal((await request('/api/orders/checkout', json({ sku: 'usb-c-hub' }, headers))).status, 401);
    headers['X-Shopper-Access-JWT'] = await sign({ human: false });
    assert.equal((await request('/api/orders/checkout', json({ sku: 'usb-c-hub' }, headers))).status, 401);
});

test('health separates a running gateway from its upstream readiness', async (t) => {
    let ready = true;
    const request = await serverFor(t, access, {
        fetchOrder: async (url) => {
            assert.equal(url.pathname, '/actuator/health/readiness');
            return Response.json({ status: ready ? 'UP' : 'DOWN' }, { status: ready ? 200 : 503 });
        }
    });
    for (const path of ['/health/live', '/health/ready']) {
        const response = await request(path);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    ready = false;
    assert.equal((await request('/health/live')).status, 200);
    assert.equal((await request('/health/ready')).status, 503);
});

const assetPaths = new Set(['/', '/app.js', '/styles.css']);
const apiPaths = new Map([
  ['/api/session', { method: 'GET', requiresShopper: true }],
  ['/api/catalog', { method: 'GET', requiresShopper: false }],
  ['/api/orders/checkout', { method: 'POST', requiresShopper: true }],
]);
const originTimeoutMs = 8_000;
const securityHeaders = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
};

function errorResponse(status, message, requestId, headers = {}) {
  return Response.json({ error: message }, {
    status,
    headers: { ...securityHeaders, 'X-Request-Id': requestId, ...headers },
  });
}

function readOrigin(env, shopOrigin) {
  const url = URL.parse(env.ORIGIN_URL);
  if (url?.protocol !== 'https:' || url.origin === shopOrigin || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) {
    return null;
  }
  if (!env.ORIGIN_ACCESS_CLIENT_ID || !env.ORIGIN_ACCESS_CLIENT_SECRET ||
    !env.EDGE_ORIGIN_TOKEN || new TextEncoder().encode(env.EDGE_ORIGIN_TOKEN).length < 32) {
    return null;
  }
  return url;
}

function withSecurityHeaders(response, requestId) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  headers.set('X-Request-Id', requestId);
  return new Response(response.body, { status: response.status, headers });
}

function reportOriginFailure(event, requestId, status) {
  console.warn({ event, requestId, status });
}

export function createFetchHandler(fetchOrigin = fetch) {
  return async function handleRequest(request, env) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const api = apiPaths.get(url.pathname);
    const isAsset = assetPaths.has(url.pathname);
    const isSignIn = url.pathname === '/sign-in';
    if (!isAsset && !isSignIn && !api) return errorResponse(404, 'Not found', requestId);

    const allowed = isAsset ? ['GET', 'HEAD'] : [api?.method ?? 'GET'];
    if (!allowed.includes(request.method)) {
      return errorResponse(405, 'Method not allowed', requestId, { Allow: allowed.join(', ') });
    }

    if (isAsset) return withSecurityHeaders(await env.ASSETS.fetch(request), requestId);

    const requiresShopper = isSignIn || api.requiresShopper;
    const shopperJwt = requiresShopper ? request.headers.get('Cf-Access-Jwt-Assertion') : null;
    if (requiresShopper && !shopperJwt) return errorResponse(401, 'Sign-in required', requestId);
    if (isSignIn) {
      return new Response(null, {
        status: 303,
        headers: { ...securityHeaders, 'X-Request-Id': requestId, Location: '/' },
      });
    }

    const origin = readOrigin(env, url.origin);
    if (!origin) {
      reportOriginFailure('origin_configuration_invalid', requestId, 503);
      return errorResponse(503, 'Storefront service unavailable', requestId);
    }

    const headers = new Headers({
      Accept: 'application/json',
      'CF-Access-Client-Id': env.ORIGIN_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.ORIGIN_ACCESS_CLIENT_SECRET,
      'X-Edge-Origin-Token': env.EDGE_ORIGIN_TOKEN,
      'X-Request-Id': requestId,
    });
    if (shopperJwt) headers.set('X-Shopper-Access-JWT', shopperJwt);
    for (const name of ['Content-Type', 'Idempotency-Key', 'Origin']) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }

    const signal = AbortSignal.timeout(originTimeoutMs);
    let response;
    try {
      response = await fetchOrigin(new URL(url.pathname, origin), {
        method: request.method,
        body: request.body,
        duplex: 'half',
        headers,
        redirect: 'manual',
        cache: 'no-store',
        signal,
      });
    } catch {
      const status = signal.aborted ? 504 : 502;
      reportOriginFailure('origin_fetch_failed', requestId, status);
      return errorResponse(status, 'Storefront service unavailable', requestId);
    }

    const mediaType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if ((response.status >= 300 && response.status < 400) ||
      (mediaType !== 'application/json' && mediaType !== 'application/problem+json')) {
      await response.body?.cancel().catch(() => {});
      reportOriginFailure('origin_response_unexpected', requestId, response.status);
      return errorResponse(502, 'Storefront service unavailable', requestId);
    }

    const responseHeaders = new Headers({ ...securityHeaders, 'X-Request-Id': requestId });
    for (const name of ['Content-Type', 'Content-Encoding', 'Retry-After', 'WWW-Authenticate']) {
      const value = response.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  };
}

export default { fetch: createFetchHandler() };

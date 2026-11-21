import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFetchHandler } from '../src/worker.js';

const shop = 'https://shop.example.com';
const secrets = {
  ORIGIN_URL: 'https://shop-origin.example.com',
  ORIGIN_ACCESS_CLIENT_ID: 'test-client-id',
  ORIGIN_ACCESS_CLIENT_SECRET: 'test-client-secret',
  EDGE_ORIGIN_TOKEN: 'test-origin-token'.repeat(3),
};

function storefrontRequest(path, { headers, ...init } = {}) {
  return new Request(shop + path, {
    ...init,
    headers: { 'Cf-Access-Jwt-Assertion': 'shopper-token', ...headers },
  });
}

test('routes only the storefront assets and documented methods', async () => {
  const paths = [];
  const handler = createFetchHandler(() => assert.fail('asset or unsupported path contacted origin'));
  const env = {
    ASSETS: {
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return new Response(request.method === 'HEAD' ? null : 'storefront', {
          headers: { 'Cache-Control': 'public, max-age=600' },
        });
      },
    },
  };

  const html = await handler(new Request(shop), env);
  assert.equal(await html.text(), 'storefront');
  assert.match(html.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.equal(html.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await handler(storefrontRequest('/app.js', { method: 'HEAD' }), env)).status, 200);
  assert.deepEqual(paths, ['/', '/app.js']);

  for (const path of ['/login', '/health/ready', '/api/orders', '//test.example.com']) {
    assert.equal((await handler(storefrontRequest(path), env)).status, 404, path);
  }
  const wrongMethod = await handler(storefrontRequest('/api/orders/checkout'), env);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'POST');
});

test('requires the Access assertion before calling the origin', async () => {
  const handler = createFetchHandler(() => assert.fail('unauthenticated request contacted origin'));
  const request = new Request(`${shop}/api/session`, {
    headers: { Cookie: 'CF_Authorization=cookie-value', 'X-Shopper-Access-JWT': 'client-claim' },
  });

  const response = await handler(request, secrets);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Sign-in required' });
});

test('returns signed-in shoppers to the storefront', async () => {
  const handler = createFetchHandler(() => assert.fail('sign-in contacted origin'));
  assert.equal((await handler(new Request(`${shop}/sign-in`), secrets)).status, 401);

  const response = await handler(storefrontRequest('/sign-in?next=https://untrusted.example.com'), secrets);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('provides the public catalog without passing shopper credentials', async () => {
  const handler = createFetchHandler((url, init) => {
    assert.equal(url.pathname, '/api/catalog');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.get('x-shopper-access-jwt'), null);
    assert.equal(init.headers.get('x-edge-origin-token'), secrets.EDGE_ORIGIN_TOKEN);
    assert.equal(init.headers.get('cf-access-client-secret'), secrets.ORIGIN_ACCESS_CLIENT_SECRET);
    return Response.json({ products: [] });
  });

  for (const request of [new Request(`${shop}/api/catalog`), storefrontRequest('/api/catalog')]) {
    const response = await handler(request, secrets);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { products: [] });
  }
});

test('uses the protected origin and forwards only the checkout contract', async () => {
  const body = JSON.stringify({ sku: 'SKU-01' });
  const key = crypto.randomUUID();
  let requestId;
  const handler = createFetchHandler(async (url, init) => {
    assert.equal(url.href, `${secrets.ORIGIN_URL}/api/orders/checkout`);
    assert.equal(init.method, 'POST');
    assert.equal(await new Response(init.body).text(), body);
    assert.equal(init.headers.get('content-type'), 'application/json');
    assert.equal(init.headers.get('origin'), shop);
    assert.equal(init.headers.get('idempotency-key'), key);
    assert.equal(init.headers.get('x-edge-origin-token'), secrets.EDGE_ORIGIN_TOKEN);
    assert.equal(init.headers.get('x-shopper-access-jwt'), 'shopper-token');
    assert.equal(init.headers.get('cf-access-client-id'), secrets.ORIGIN_ACCESS_CLIENT_ID);
    assert.equal(init.headers.get('cf-access-client-secret'), secrets.ORIGIN_ACCESS_CLIENT_SECRET);
    assert.equal(init.headers.get('authorization'), null);
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.headers.get('cf-access-jwt-assertion'), null);
    assert.equal(init.headers.get('x-forwarded-for'), null);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store');
    requestId = init.headers.get('x-request-id');
    assert.match(requestId, /^[\da-f-]{36}$/);
    assert.notEqual(requestId, 'client-value');

    return Response.json({ orderId: 73 }, {
      status: 201,
      headers: { 'Set-Cookie': 'origin-only=value', 'Access-Control-Allow-Origin': '*' },
    });
  });

  const response = await handler(storefrontRequest('/api/orders/checkout?unused=1', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      Origin: shop,
      'Idempotency-Key': key,
      'X-Shopper-Access-JWT': 'client-value',
      'X-Edge-Origin-Token': 'client-value',
      'X-Request-Id': 'client-value',
      'Cf-Access-Client-Id': 'client-value',
      'Cf-Access-Client-Secret': 'client-value',
      Authorization: 'Bearer client-value',
      Cookie: 'CF_Authorization=cookie-value',
      'X-Forwarded-For': '192.0.2.44',
    },
  }), secrets);

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { orderId: 73 });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('x-request-id'), requestId);
});

test('preserves the gateway problem detail status and retry header', async () => {
  const handler = createFetchHandler((url, init) => {
    assert.equal(url.pathname, '/api/catalog');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, null);
    return Response.json({ detail: 'Rate limit exceeded' }, {
      status: 429,
      headers: { 'Content-Type': 'application/problem+json; charset=utf-8', 'Retry-After': '10' },
    });
  });

  const response = await handler(storefrontRequest('/api/catalog'), secrets);
  assert.equal(response.status, 429);
  assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
  assert.equal(response.headers.get('retry-after'), '10');
  assert.deepEqual(await response.json(), { detail: 'Rate limit exceeded' });
});

test('fails closed for missing or unsafe origin settings', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const handler = createFetchHandler(() => assert.fail('unsafe origin was contacted'));

  for (const origin of [undefined, 'http://insecure.example.com', shop, 'https://owner:secret@remote.example.com',
    'https://remote.example.com/custom', 'https://remote.example.com/?x=y']) {
    const response = await handler(storefrontRequest('/api/session'), { ...secrets, ORIGIN_URL: origin });
    assert.equal(response.status, 503, origin);
  }
  const response = await handler(storefrontRequest('/api/session'), { ...secrets, EDGE_ORIGIN_TOKEN: 'short' });
  assert.equal(response.status, 503);
});

test('hides redirects and non-API origin failures', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const unexpected = [Response.redirect('https://downstream-login.example.com', 302), new Response('Origin error', {
    status: 403,
    headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'origin-only=value' },
  })];

  for (const upstream of unexpected) {
    const response = await createFetchHandler(() => upstream)(storefrontRequest('/api/session'), secrets);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { error: 'Storefront service unavailable' });
  }
});

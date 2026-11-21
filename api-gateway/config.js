function required(env, name, minimumBytes = 1) {
    const value = env[name];
    if (!value || !value.trim() || Buffer.byteLength(value) < minimumBytes) {
        throw new Error(`${name} must contain at least ${minimumBytes} bytes`);
    }
    return value;
}

function origin(name, value, protocols) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${name} must be a valid URL`);
    }
    if (!protocols.includes(url.protocol) || url.href !== `${url.origin}/`) {
        throw new Error(`${name} must be an origin with scheme, hostname, and optional port`);
    }
    return url;
}

function integer(name, value, min, max) {
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return Number(value);
}

export function readConfig(env = process.env) {
    const mode = env.AUTH_MODE;
    if (mode !== 'local' && mode !== 'access') {
        throw new Error('AUTH_MODE must be local or access');
    }

    const common = {
        mode,
        port: integer('PORT', env.PORT ?? '3000', 1, 65535),
        orderTimeoutMs: integer('ORDER_TIMEOUT_MS', env.ORDER_TIMEOUT_MS ?? '5000', 100, 30000),
        orderOrigin: origin(
            'ORDER_SERVICE_URL',
            env.ORDER_SERVICE_URL ?? 'http://order-service:8080',
            ['http:', 'https:']
        ).origin,
        checkoutServiceToken: required(env, 'CHECKOUT_SERVICE_TOKEN', 32)
    };

    if (mode === 'local') {
        return {
            ...common,
            loginPassword: required(env, 'GATEWAY_LOGIN_PASSWORD', 12),
            jwtSecret: required(env, 'JWT_SECRET', 32)
        };
    }

    const accessIssuer = origin(
        'CLOUDFLARE_ACCESS_ISSUER',
        required(env, 'CLOUDFLARE_ACCESS_ISSUER'),
        ['https:']
    );
    if (!accessIssuer.hostname.endsWith('.cloudflareaccess.com') || accessIssuer.port) {
        throw new Error('CLOUDFLARE_ACCESS_ISSUER must use the Cloudflare Access team hostname');
    }

    return {
        ...common,
        accessIssuer: accessIssuer.origin,
        accessAudience: required(env, 'CLOUDFLARE_ACCESS_AUDIENCE'),
        publicOrigin: origin('PUBLIC_ORIGIN', required(env, 'PUBLIC_ORIGIN'), ['https:']).origin,
        edgeOriginToken: required(env, 'EDGE_ORIGIN_TOKEN', 32)
    };
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, errors, jwtVerify, SignJWT } from 'jose';

const LOCAL_AUDIENCE = 'commerce-checkout';
const LOCAL_ISSUER = 'commerce-local-gateway';

export function digest(input) {
    return createHash('sha256').update(input).digest();
}

export function matchesSecret(value, expectedDigest) {
    return typeof value === 'string' && timingSafeEqual(digest(value), expectedDigest);
}

export function createAuth(config, accessKeySet) {
    if (config.mode === 'access') {
        const keys = accessKeySet ?? createRemoteJWKSet(
            new URL('/cdn-cgi/access/certs', config.accessIssuer),
            { timeoutDuration: 2500 }
        );
        return {
            async verify(req) {
                const proof = req.get('x-shopper-access-jwt');
                if (!proof) return null;
                const { payload } = await jwtVerify(proof, keys, {
                    algorithms: ['RS256'],
                    issuer: config.accessIssuer,
                    audience: config.accessAudience,
                    requiredClaims: ['exp', 'iat', 'sub']
                });
                // Access application tokens for service identities do not carry an email claim.
                if (typeof payload.sub !== 'string' || !payload.sub.trim()
                    || typeof payload.email !== 'string' || !payload.email.trim()) {
                    return null;
                }
                return payload;
            },
            unavailable(error) {
                return error instanceof errors.JWKSTimeout
                    || error instanceof errors.JWKSInvalid
                    || error.code === 'ERR_JOSE_GENERIC'
                    || error instanceof TypeError;
            }
        };
    }

    const key = new TextEncoder().encode(config.jwtSecret);
    const passwordDigest = digest(config.loginPassword);
    return {
        async login(password) {
            if (!matchesSecret(password, passwordDigest)) return null;
            return new SignJWT({})
                .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
                .setIssuer(LOCAL_ISSUER)
                .setAudience(LOCAL_AUDIENCE)
                .setSubject('local-demo')
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(key);
        },
        async verify(req) {
            const token = /^Bearer ([^ ]+)$/i.exec(req.get('authorization') ?? '')?.[1];
            if (!token) return null;
            const { payload } = await jwtVerify(token, key, {
                algorithms: ['HS256'],
                issuer: LOCAL_ISSUER,
                audience: LOCAL_AUDIENCE,
                subject: 'local-demo',
                requiredClaims: ['exp', 'iat', 'sub']
            });
            return payload;
        },
        unavailable() {
            return false;
        }
    };
}

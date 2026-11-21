# Deploy the storefront to Cloudflare Workers

Cloudflare serves the public storefront and catalog. Checkout requires Cloudflare Access sign-in. Checkout and asynchronous order processing run on the regional Docker host. Cloudflare Tunnel connects the Worker to the gateway without publishing the gateway's port.

## Configure Cloudflare Access and Tunnel

1. Use a Cloudflare-managed zone and choose two distinct hostnames. This guide uses `shop.example.com` for the storefront and `shop-origin.example.com` for the gateway tunnel.
2. In Zero Trust, create one self-hosted shopper Access application with three public hostname and path entries. Add `shop.example.com/sign-in`, `shop.example.com/api/session`, and `shop.example.com/api/orders/checkout` to that same application. Set an **Allow** policy for the shoppers or testers you intend to admit. Keep **Cookie Path Attribute** off so the session cookie applies to all three paths. Copy the application's audience (AUD) and the Access team URL, for example `https://team.cloudflareaccess.com`, for the gateway settings below. [Self-hosted Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/), [Authorization cookie settings](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)
3. Create a dedicated Access service token for the Worker, then a separate self-hosted Access application for `shop-origin.example.com`. Give this application a **Service Auth** policy that includes only the Worker's service token. [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
4. Create a remotely managed Cloudflare Tunnel and add `shop-origin.example.com` as a published application route for `http://api-gateway:3000`. Under the route's Access origin parameters, enable **Protect with Access** using the team name and the origin application's AUD from step 3. Save the connector's tunnel token in a file readable by the `cloudflared` container. [Tunnel origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)

## Start the regional origin

Use the repository's production Compose overlay as described in the [root README](../README.md). Set these values in the production environment file alongside the database, broker, and service credentials.

| Variable | Value |
| --- | --- |
| `PUBLIC_ORIGIN` | `https://shop.example.com` |
| `CLOUDFLARE_ACCESS_ISSUER` | The Access team URL |
| `CLOUDFLARE_ACCESS_AUDIENCE` | The storefront Access application's AUD from step 2 |
| `EDGE_ORIGIN_TOKEN` | A freshly generated random token at least 32 bytes long |
| `CLOUDFLARE_TUNNEL_TOKEN_FILE` | Path to the file with the tunnel connector token |

From the repository root, assuming the environment file is `.env.production`:

```sh
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml --profile tunnel up --build --wait -d
```

Verify that the tunnel reports **Healthy** in Zero Trust. The gateway independently validates the shopper's Access assertion and the shared edge token. The Worker's service token authenticates the Worker to the origin hostname.

## Deploy the Worker

Put the following values in a private JSON file outside the repository. `EDGE_ORIGIN_TOKEN` must match the gateway environment exactly.

```json
{
  "ORIGIN_URL": "https://shop-origin.example.com",
  "ORIGIN_ACCESS_CLIENT_ID": "replace-with-origin-service-token-client-id",
  "ORIGIN_ACCESS_CLIENT_SECRET": "replace-with-origin-service-token-client-secret",
  "EDGE_ORIGIN_TOKEN": "replace-with-the-same-token-used-by-the-gateway"
}
```

Use Node.js 22 or later and run from the repository root. Wrangler accepts an authenticated Cloudflare CLI session or `CLOUDFLARE_ACCOUNT_ID` and an account-scoped `CLOUDFLARE_API_TOKEN` with Worker deploy permissions. [Wrangler authentication](https://developers.cloudflare.com/workers/authorization/)

```sh
cd edge
npm ci
npm test
npm run check
npm run deploy -- --secrets-file /secure/path/worker-secrets.json
```

In **Workers & Pages → distributed-ecommerce-edge → Settings → Domains & Routes**, add `shop.example.com` as a Custom Domain. The repository leaves domain routing to the dashboard. The `workers.dev` URL and preview URLs are disabled. [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

To run **Deploy Cloudflare Worker** from GitHub Actions on `main`, add `CLOUDFLARE_ACCOUNT_ID` and `ORIGIN_URL` as variables in the GitHub `production` environment. Add `CLOUDFLARE_API_TOKEN`, `ORIGIN_ACCESS_CLIENT_ID`, `ORIGIN_ACCESS_CLIENT_SECRET`, and `EDGE_ORIGIN_TOKEN` as secrets in that environment. The workflow verifies and publishes the Worker. Set up and operate the regional origin separately.

## Verify the deployment

- Open the storefront in a signed-out browser. The catalog should load. Select **Sign in** to go through Access and return to the storefront. Checkout should require a permitted shopper identity.
- Request `https://shop-origin.example.com/api/session` without the Worker service token. Access should deny the request. The storefront should return `404` for `/health/ready` and `/login`.
- Check that storefront API responses have `Cache-Control: private, no-store`. Use the `X-Request-Id` response header to locate a failed forwarded request in Worker and gateway logs.
- Keep response caching disabled for signed-in traffic. To limit abusive traffic, apply a Cloudflare WAF rate limiting rule scoped to `POST /api/orders/checkout` on the storefront hostname.

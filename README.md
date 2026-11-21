# Distributed commerce

A distributed storefront with a public catalog and authenticated checkout. The gateway owns a small USD catalog, Spring Boot records orders in PostgreSQL, and a Python worker consumes order events from RabbitMQ. The optional product search service indexes catalog descriptions in Qdrant with MiniLM embeddings.

The checkout records orders and publishes events. Payments, inventory reservations, shipping, and a customer account lifecycle are outside this release.

## Local setup

Use Docker with a running Linux engine and Docker Compose v2.24.4 or later. On Windows, start Docker Desktop with the WSL 2 backend and wait until it reports that the engine is running. If the CLI reports that the `dockerDesktopLinuxEngine` pipe is missing, check the active context and confirm that the server responds before using Compose.

```powershell
docker context use desktop-linux
docker info --format '{{.OSType}}'
Copy-Item .env.example .env
docker compose up --build --wait
```

Run those commands from the repository root. On macOS or Linux, use `cp .env.example .env` in place of `Copy-Item` and use your existing Linux Docker context. Keep an existing `.env` and add any missing settings from the example.

Open [http://localhost:3000](http://localhost:3000) and sign in with the `GATEWAY_LOGIN_PASSWORD` in `.env`. Select an item and submit checkout. PostgreSQL and RabbitMQ stay on private Docker networks. `docker compose down` stops the stack and keeps named volumes. Adding `--volumes` also deletes the stored orders, queued events, and search data.

To opt into product search, run `docker compose --profile search up --build --wait`. The search service downloads the pinned model on first start and caches it in its named volume. The private service accepts `POST /index-product` with `id`, `name`, and `description`, and `GET /search?query=...`.

## Checkout and event delivery

- `GET /api/catalog` returns SKUs and prices in cents. `POST /api/orders/checkout` accepts `{"sku":"studio-laptop"}` and requires an `Idempotency-Key`. Keep the same key when retrying an order. The gateway scopes keys to the authenticated user. Creation returns `201`, an identical replay returns `200`, and reuse for a different product returns `409`.
- The order service saves the order and its outbox entry in the same PostgreSQL transaction. It removes the entry after confirmation that RabbitMQ accepted and routed the persistent event. Checkout remains available through a broker outage while PostgreSQL is available.
- `order.created.v1` is delivered at least once. Consumers that add business side effects need durable deduplication by `eventId`. The current Python worker validates events, logs receipt, and acknowledges them. It sends malformed events to the dead-letter queue.
- The storefront publishes only the gateway port in local mode. `/health/live` checks the gateway process and `/health/ready` also checks the order service and its database.

## Verify the stack

For an isolated local checkout, run this test from the repository root in a Bash shell after starting Compose. It exercises concurrent retries for one order, key conflicts, recording during a broker outage, and delivery when RabbitMQ returns.

```bash
set -a
source .env
set +a
python3 scripts/checkout-smoke.py --broker-restart
```

GitHub Actions also runs the component tests and a Worker dry-run build.

## Deploy to Cloudflare

Cloudflare Workers serves the storefront and forwards API requests through Cloudflare Tunnel. The Java service, Python worker, PostgreSQL, and RabbitMQ run on a regional Docker host. The production Compose overlay publishes zero host ports and removes local password login. Cloudflare Access authenticates shoppers at checkout and separately authorizes the Worker to reach the origin.

1. Set up the storefront and origin hostnames, Access policies, and Tunnel routing. Follow the [Cloudflare setup](edge/README.md) to obtain the Access settings and configure the Worker.
2. On the Docker host, copy `.env.production.example` to `.env.production` and fill in the settings. Generate separate random secrets for the database, broker, checkout service, and Worker-to-gateway authentication. Set `CLOUDFLARE_TUNNEL_TOKEN_FILE` to the file holding the Tunnel connector token. Keep both files outside source control.
3. Start the regional origin.

   ```bash
   docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml \
     --profile tunnel up -d --build --wait
   ```

4. Deploy the Worker from `edge/` or run the **Deploy Cloudflare Worker** workflow on `main` after configuring the GitHub `production` environment. Confirm the catalog loads signed out and checkout requires sign-in. Submit a test order and verify its receipt in the regional worker logs.

### Operating the regional origin

This Compose layout runs on one regional host. For a production rollout, schedule PostgreSQL backups and restore tests, capture broker and container metrics, and alert on old outbox rows, dead-letter messages, and Tunnel disconnects. Size data storage and memory for the expected load and test recovery before accepting real orders. Use a separately operated highly available data plane if your availability requirements exceed one host.

For upgrades from the previous checkout, take a PostgreSQL backup and restore it into the new volume before starting the new order service. Flyway migrates the original `orders` table and sets up the outbox. Rehearse on a copy before applying the decimal price migration to live data. Changing Compose environment passwords does not update credentials already initialized in named volumes. Rotate them in the database and broker before updating the application settings.

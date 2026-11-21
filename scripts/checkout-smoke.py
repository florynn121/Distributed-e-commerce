"""Check a dedicated local Compose stack using real checkout, PostgreSQL and RabbitMQ."""

import argparse
import concurrent.futures
import getpass
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


def poll(check, description, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(1)
    raise AssertionError(f"Timed out waiting for {description}")


def compose(*args):
    return subprocess.check_output(["docker", "compose", *args], text=True)


def db(sql):
    return compose(
        "exec", "-T", "postgres", "sh", "-ec",
        'exec psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
        "psql", sql,
    ).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:3000")
    parser.add_argument(
        "--broker-restart", action="store_true",
        help="Stop and restart RabbitMQ in this dedicated test project.",
    )
    args = parser.parse_args()
    if not __debug__:
        parser.error("Run without Python optimization so the smoke checks execute.")

    password = os.environ.get("GATEWAY_LOGIN_PASSWORD")
    if not password and sys.stdin.isatty():
        password = getpass.getpass("Local storefront password from .env: ")
    if not password:
        parser.error("Set GATEWAY_LOGIN_PASSWORD or run from an interactive terminal.")

    origin = args.url.rstrip("/")

    def request(path, body=None, token=None, key=None):
        headers = {"Accept": "application/json", "Origin": origin}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        if key is not None:
            headers["Idempotency-Key"] = key
        req = urllib.request.Request(
            origin + path, data=None if body is None else json.dumps(body).encode(),
            headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                status, content = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, content = error.code, error.read()
        try:
            decoded = json.loads(content)
        except json.JSONDecodeError:
            decoded = content.decode("utf-8", errors="replace")
        return status, decoded

    def ready():
        try:
            return request("/health/ready")[0] == 200
        except OSError:
            return False

    poll(ready, "gateway and order service readiness")
    checkout_path = "/api/orders/checkout"
    assert request(checkout_path, {"sku": "studio-laptop"}, key=uuid.uuid4().hex)[0] == 401
    status, login = request("/login", {"password": password})
    assert status == 200, ("Local login failed", status)
    token = login["token"]

    status, catalog = request("/api/catalog")
    assert status == 200 and len(catalog["products"]) >= 2, ("Catalog failed", status)
    product, other = catalog["products"][:2]
    key = uuid.uuid4().hex

    def checkout(item=product, identity=key):
        return request(checkout_path, {"sku": item["sku"]}, token=token, key=identity)

    try:
        if args.broker_restart:
            compose("stop", "rabbitmq")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: checkout(), range(2)))
        assert sorted(status for status, _ in responses) == [200, 201], responses
        order = responses[0][1]
        assert responses[1][1] == order, responses
        assert order["product"] == product["name"] and round(order["price"] * 100) == product["priceCents"], order
        assert checkout(other)[0] == 409, "The same key accepted a different product"
        order_id = order["id"]
        assert type(order_id) is int and order_id > 0, order
        assert db(f"SELECT count(*) FROM orders WHERE id = {order_id}") == "1"
        if args.broker_restart:
            assert db(f"SELECT count(*) FROM order_outbox WHERE order_id = {order_id}") == "1"
    finally:
        if args.broker_restart:
            compose("start", "rabbitmq")

    poll(
        lambda: db(f"SELECT count(*) FROM order_outbox WHERE order_id = {order_id}") == "0",
        "broker confirmation and outbox cleanup",
    )
    poll(
        lambda: any(
            "order_event_received " in line and f"order_id={order_id} " in line
            for line in compose("logs", "--no-color", "ai-service").splitlines()
        ),
        "Python consumer receipt",
    )
    print(f"Checkout smoke passed for order {order_id}", flush=True)


if __name__ == "__main__":
    main()

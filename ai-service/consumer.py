"""Validate and acknowledge order events delivered by RabbitMQ."""

import json
import logging
import os
import random
import signal
import ssl
import sys
import time
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from threading import Event
from uuid import UUID

import pika

ORDER_EXCHANGE = "commerce.orders"
ORDER_QUEUE = "commerce.order-events.v1"
ORDER_CREATED = "order.created.v1"
DEAD_EXCHANGE = "commerce.orders.dlx"
DEAD_QUEUE = "commerce.order-events.dlq.v1"
DEAD_ROUTE = "order.created.v1.dead"
HEALTH_FILE = Path("/tmp/order-worker-health")
PRICE_INCREMENT = Decimal("0.01")
MAX_PRICE = Decimal("9999999999.99")
LOG = logging.getLogger(__name__)


def parse_order_event(body: bytes) -> tuple[UUID, int]:
    if len(body) > 4096:
        raise ValueError("event exceeds the maximum size")

    data = json.loads(body.decode("utf-8"), parse_float=Decimal)
    if not isinstance(data, dict) or data.get("type") != ORDER_CREATED:
        raise ValueError("unexpected event type")

    event_id = data.get("eventId")
    if not isinstance(event_id, str):
        raise ValueError("eventId must be a UUID")
    event_id = UUID(event_id)

    order_id = data.get("orderId")
    if type(order_id) is not int or not 0 < order_id <= 2**63 - 1:
        raise ValueError("orderId must be a positive integer")

    product = data.get("product")
    if not isinstance(product, str) or not 0 < len(product.strip()) <= 255 or "\0" in product:
        raise ValueError("invalid product")

    price = data.get("price")
    if type(price) not in (Decimal, int, str):
        raise ValueError("invalid price")
    price = Decimal(price)
    if not price.is_finite() or not 0 < price <= MAX_PRICE or price != price.quantize(PRICE_INCREMENT):
        raise ValueError("invalid price")

    timestamp = data.get("occurredAt")
    if not isinstance(timestamp, str):
        raise ValueError("invalid UTC timestamp")
    if datetime.fromisoformat(timestamp).utcoffset() != timedelta(0):
        raise ValueError("invalid UTC timestamp")

    return event_id, order_id


def acknowledge_order(channel, method, body: bytes) -> None:
    try:
        event_id, order_id = parse_order_event(body)
    except (ValueError, InvalidOperation, RecursionError):
        LOG.warning("order_event_rejected delivery_tag=%s", method.delivery_tag)
        channel.basic_reject(delivery_tag=method.delivery_tag, requeue=False)
        return

    # Receipt logs can repeat if RabbitMQ redelivers an unacknowledged event.
    LOG.info(
        "order_event_received event_id=%s order_id=%s redelivered=%s",
        event_id,
        order_id,
        method.redelivered,
    )
    channel.basic_ack(delivery_tag=method.delivery_tag)


def connection_parameters() -> pika.ConnectionParameters:
    host = os.environ.get("RABBITMQ_HOST", "rabbitmq")
    tls = os.environ.get("RABBITMQ_TLS", "false").lower()
    if tls not in {"true", "false"}:
        raise ValueError("RABBITMQ_TLS must be true or false")

    user = os.environ.get("RABBITMQ_USER")
    password = os.environ.get("RABBITMQ_PASSWORD")
    if not user or not password:
        raise ValueError("RABBITMQ_USER and RABBITMQ_PASSWORD are required")

    return pika.ConnectionParameters(
        host=host,
        port=int(os.environ.get("RABBITMQ_PORT", "5671" if tls == "true" else "5672")),
        virtual_host=os.environ.get("RABBITMQ_VHOST", "/"),
        credentials=pika.PlainCredentials(user, password),
        ssl_options=pika.SSLOptions(ssl.create_default_context(), host) if tls == "true" else None,
        heartbeat=30,
        socket_timeout=5,
        stack_timeout=10,
        blocked_connection_timeout=15,
    )


def configure_topology(channel) -> None:
    channel.exchange_declare(exchange=ORDER_EXCHANGE, exchange_type="topic", durable=True)
    channel.exchange_declare(exchange=DEAD_EXCHANGE, exchange_type="direct", durable=True)
    channel.queue_declare(queue=DEAD_QUEUE, durable=True)
    channel.queue_bind(queue=DEAD_QUEUE, exchange=DEAD_EXCHANGE, routing_key=DEAD_ROUTE)
    channel.queue_declare(
        queue=ORDER_QUEUE,
        durable=True,
        arguments={
            "x-dead-letter-exchange": DEAD_EXCHANGE,
            "x-dead-letter-routing-key": DEAD_ROUTE,
        },
    )
    channel.queue_bind(queue=ORDER_QUEUE, exchange=ORDER_EXCHANGE, routing_key=ORDER_CREATED)
    channel.basic_qos(prefetch_count=10)


def run(stop: Event) -> None:
    parameters = connection_parameters()
    delay = 1
    HEALTH_FILE.unlink(missing_ok=True)

    while not stop.is_set():
        try:
            with pika.BlockingConnection(parameters) as connection:
                channel = connection.channel()
                configure_topology(channel)
                LOG.info("order_consumer_connected queue=%s", ORDER_QUEUE)
                for method, _, body in channel.consume(ORDER_QUEUE, auto_ack=False, inactivity_timeout=2):
                    if stop.is_set():
                        break
                    if method is not None:
                        acknowledge_order(channel, method, body)
                    HEALTH_FILE.touch()
                    delay = 1
        except (pika.exceptions.AMQPConnectionError, OSError) as error:
            LOG.warning("order_consumer_disconnected error=%s", type(error).__name__)
        finally:
            HEALTH_FILE.unlink(missing_ok=True)

        if not stop.is_set():
            stop.wait(random.uniform(delay / 2, delay))
            delay = min(delay * 2, 30)


def healthcheck() -> int:
    try:
        age = time.time() - HEALTH_FILE.stat().st_mtime
        return 0 if 0 <= age < 15 else 1
    except FileNotFoundError:
        return 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--healthcheck"]:
        sys.exit(healthcheck())

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("pika").setLevel(logging.CRITICAL)
    stopped = Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    run(stopped)

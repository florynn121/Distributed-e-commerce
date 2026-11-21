import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from consumer import ORDER_CREATED, acknowledge_order

EVENT = {
    "eventId": "5a5cf2cf-3027-4a17-bbed-54994c2025d5",
    "type": ORDER_CREATED,
    "orderId": 7,
    "product": "Coffee maker",
    "price": 19.99,
    "occurredAt": "2026-11-21T12:00:00.123456789Z",
}


class ConsumerTests(unittest.TestCase):
    def setUp(self):
        self.channel = Mock()
        self.delivery = SimpleNamespace(delivery_tag=4, redelivered=False)

    def test_valid_order_acks_and_logs_receipt_without_product(self):
        with self.assertLogs("consumer", "INFO") as receipt:
            acknowledge_order(self.channel, self.delivery, json.dumps(EVENT).encode())
        self.channel.basic_ack.assert_called_once_with(delivery_tag=4)
        self.channel.basic_reject.assert_not_called()
        self.assertIn("order_id=7", receipt.output[0])
        self.assertNotIn(EVENT["product"], receipt.output[0])

    def test_invalid_messages_are_dead_lettered_without_requeue(self):
        bodies = [
            b"not json",
            b"x" * 4097,
            json.dumps({**EVENT, "orderId": True}).encode(),
            json.dumps({**EVENT, "price": "NaN"}).encode(),
            json.dumps({**EVENT, "price": "0.001"}).encode(),
            json.dumps({**EVENT, "occurredAt": "2026-11-21T12:00:00"}).encode(),
        ]
        for body in bodies:
            with self.subTest(body=body[:80]):
                self.channel.reset_mock()
                with self.assertLogs("consumer", "WARNING"):
                    acknowledge_order(self.channel, self.delivery, body)
                self.channel.basic_reject.assert_called_once_with(delivery_tag=4, requeue=False)
                self.channel.basic_ack.assert_not_called()

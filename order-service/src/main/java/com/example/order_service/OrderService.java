package com.example.order_service;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import tools.jackson.databind.json.JsonMapper;

@Service
public class OrderService {
    private final JdbcClient database;
    private final JsonMapper json;

    public OrderService(JdbcClient database, JsonMapper json) {
        this.database = database;
        this.json = json;
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public Checkout checkout(String key, String product, BigDecimal price) {
        var created = database.sql("""
                INSERT INTO orders (idempotency_key, product, price)
                VALUES (:key, :product, :price)
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING id
                """)
                .param("key", key)
                .param("product", product)
                .param("price", price)
                .query(Long.class)
                .optional();

        if (created.isEmpty()) {
            // The insert waits for a concurrent writer of this key, so this statement sees the winner.
            Order order = database.sql("SELECT id, product, price FROM orders WHERE idempotency_key = :key")
                    .param("key", key)
                    .query(Order.class)
                    .single();
            if (!order.product().equals(product) || order.price().compareTo(price) != 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Idempotency-Key was used for a different order");
            }
            return new Checkout(order, false);
        }

        long orderId = created.get();
        UUID eventId = UUID.randomUUID();
        var event = new OrderCreated(
                eventId, OrderMessaging.ORDER_CREATED, orderId, product, price, Instant.now().toString());
        database.sql("""
                INSERT INTO order_outbox (event_id, order_id, payload)
                VALUES (:eventId, :orderId, :payload)
                """)
                .param("eventId", eventId)
                .param("orderId", orderId)
                .param("payload", json.writeValueAsString(event))
                .update();
        return new Checkout(new Order(orderId, product, price), true);
    }

    public record Order(long id, String product, BigDecimal price) {}

    public record Checkout(Order order, boolean created) {}

    private record OrderCreated(UUID eventId, String type, long orderId, String product, BigDecimal price,
                                String occurredAt) {}
}

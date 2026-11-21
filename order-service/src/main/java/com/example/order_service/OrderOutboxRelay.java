package com.example.order_service;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.AmqpException;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
class OrderOutboxRelay {
    private static final Logger LOG = LoggerFactory.getLogger(OrderOutboxRelay.class);
    private final JdbcClient database;
    private final RabbitTemplate rabbit;
    private final TransactionTemplate transactions;

    OrderOutboxRelay(JdbcClient database, RabbitTemplate rabbit, TransactionTemplate transactions) {
        this.database = database;
        this.rabbit = rabbit;
        this.transactions = transactions;
    }

    @Scheduled(fixedDelayString = "${checkout.outbox.poll-ms:500}", initialDelayString = "${checkout.outbox.poll-ms:500}")
    void publishPending() {
        // Lock and complete each row in its own transaction so replicas can relay in parallel.
        for (int row = 0; row < 50; row++) {
            if (!Boolean.TRUE.equals(transactions.execute(status -> publishOne()))) {
                return;
            }
        }
    }

    private boolean publishOne() {
        var pending = database.sql("""
                SELECT event_id, payload, attempts
                FROM order_outbox
                WHERE next_attempt_at <= CURRENT_TIMESTAMP
                ORDER BY next_attempt_at, created_at
                LIMIT 1
                FOR UPDATE SKIP LOCKED
                """)
                .query(PendingEvent.class)
                .optional();
        if (pending.isEmpty()) {
            return false;
        }

        PendingEvent event = pending.get();
        try {
            publish(event);
        } catch (AmqpException | ExecutionException | TimeoutException failure) {
            scheduleRetry(event, failure);
            return false;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Order event publishing interrupted", interrupted);
        }

        database.sql("DELETE FROM order_outbox WHERE event_id = :eventId")
                .param("eventId", event.eventId())
                .update();
        return true;
    }

    private void publish(PendingEvent event) throws ExecutionException, TimeoutException, InterruptedException {
        String eventId = event.eventId().toString();
        var properties = new MessageProperties();
        properties.setMessageId(eventId);
        properties.setType(OrderMessaging.ORDER_CREATED);
        properties.setContentType(MessageProperties.CONTENT_TYPE_JSON);
        properties.setContentEncoding(StandardCharsets.UTF_8.name());
        properties.setDeliveryMode(MessageDeliveryMode.PERSISTENT);

        // A fresh correlation ID prevents a late reply from completing a subsequent retry.
        var correlation = new CorrelationData();
        var message = new Message(event.payload().getBytes(StandardCharsets.UTF_8), properties);
        rabbit.send(OrderMessaging.EXCHANGE, OrderMessaging.ORDER_CREATED, message, correlation);
        var confirmation = correlation.getFuture().get(5, TimeUnit.SECONDS);
        if (!confirmation.ack() || correlation.getReturned() != null) {
            throw new AmqpException("Order event was rejected or could not be routed");
        }
    }

    private void scheduleRetry(PendingEvent event, Exception failure) {
        int retrySeconds = Math.min(300, 1 << Math.min(event.attempts(), 9));
        database.sql("""
                UPDATE order_outbox
                SET attempts = attempts + 1,
                    next_attempt_at = CURRENT_TIMESTAMP + (:retrySeconds * INTERVAL '1 second')
                WHERE event_id = :eventId
                """)
                .param("eventId", event.eventId())
                .param("retrySeconds", retrySeconds)
                .update();
        LOG.warn("Retrying order event {} in {} seconds after {}", event.eventId(), retrySeconds,
                failure.getClass().getSimpleName());
    }

    private record PendingEvent(UUID eventId, String payload, int attempts) {}
}

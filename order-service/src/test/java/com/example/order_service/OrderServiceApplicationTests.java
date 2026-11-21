package com.example.order_service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.math.BigDecimal;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.ReturnedMessage;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

@SpringBootTest(properties = {
        "checkout.service-token=integration-test-token-1234567890",
        "checkout.outbox.poll-ms=600000",
        "spring.rabbitmq.dynamic=false",
        "spring.rabbitmq.username=unused",
        "spring.rabbitmq.password=unused"
})
@AutoConfigureMockMvc
@Testcontainers
class OrderServiceApplicationTests {
    private static final String SERVICE_TOKEN = "integration-test-token-1234567890";

    @Container
    @ServiceConnection
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:15-alpine")
            .withInitScript("legacy-orders.sql");

    @Autowired
    private MockMvc http;

    @Autowired
    private JdbcClient database;

    @Autowired
    private OrderService orders;

    @Autowired
    private OrderOutboxRelay relay;

    @MockitoBean
    private RabbitTemplate rabbit;

    @BeforeEach
    void resetCheckoutData() {
        database.sql("DELETE FROM order_outbox").update();
        database.sql("DELETE FROM orders WHERE idempotency_key IS NOT NULL").update();
    }

    @Test
    void migratesExistingOrders() {
        var order = database.sql("SELECT id, product, price FROM orders WHERE product = 'Legacy order'")
                .query(OrderService.Order.class).single();
        assertThat(order.id()).isEqualTo(1L);
        assertThat(order.price()).isEqualByComparingTo("19.875");
    }

    @Test
    void checkoutValidatesAndReusesTheCommittedOrder() throws Exception {
        String input = """
                {"product":" New order ","price":19.75}
                """;

        http.perform(post("/api/orders/checkout").contentType(MediaType.APPLICATION_JSON).content(input))
                .andExpect(status().isUnauthorized());
        http.perform(post("/api/orders/checkout")
                .header("X-Checkout-Service-Token", SERVICE_TOKEN)
                .contentType(MediaType.APPLICATION_JSON).content(input))
                .andExpect(status().isBadRequest());
        http.perform(post("/api/orders/checkout")
                .header("X-Checkout-Service-Token", SERVICE_TOKEN).header("Idempotency-Key", "checkout-key")
                .contentType(MediaType.APPLICATION_JSON).content("{\"product\":\"New order\",\"price\":19.751}"))
                .andExpect(status().isBadRequest());

        http.perform(post("/api/orders/checkout")
                .header("X-Checkout-Service-Token", SERVICE_TOKEN).header("Idempotency-Key", "checkout-key")
                .contentType(MediaType.APPLICATION_JSON).content(input))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.product").value("New order"))
                .andExpect(jsonPath("$.price").value(19.75));

        long orderId = database.sql("SELECT id FROM orders WHERE idempotency_key = 'checkout-key'")
                .query(Long.class).single();
        http.perform(post("/api/orders/checkout")
                .header("X-Checkout-Service-Token", SERVICE_TOKEN).header("Idempotency-Key", "checkout-key")
                .contentType(MediaType.APPLICATION_JSON).content(input))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(orderId));
        http.perform(post("/api/orders/checkout")
                .header("X-Checkout-Service-Token", SERVICE_TOKEN).header("Idempotency-Key", "checkout-key")
                .contentType(MediaType.APPLICATION_JSON).content("{\"product\":\"Different\",\"price\":19.75}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.status").value(409));

        assertThat(database.sql("SELECT order_id FROM order_outbox").query(Long.class).single()).isEqualTo(orderId);
    }

    @Test
    void failureToRecordTheEventRollsBackOrder() {
        database.sql("ALTER TABLE order_outbox ADD CONSTRAINT reject_event CHECK (false)").update();
        try {
            assertThatThrownBy(() -> orders.checkout("rolled-back", "Test", new BigDecimal("15.00")))
                    .isInstanceOf(DataIntegrityViolationException.class);
            assertThat(database.sql("SELECT id FROM orders WHERE idempotency_key = 'rolled-back'")
                    .query(Long.class).optional()).isEmpty();
        } finally {
            database.sql("ALTER TABLE order_outbox DROP CONSTRAINT reject_event").update();
        }
    }

    @Test
    void concurrentRetriesCreateOneOrderAndEvent() throws Exception {
        var start = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> {
                start.await();
                return orders.checkout("concurrent-key", "Test", new BigDecimal("15.00"));
            });
            var second = executor.submit(() -> {
                start.await();
                return orders.checkout("concurrent-key", "Test", new BigDecimal("15.00"));
            });
            start.countDown();

            var results = new OrderService.Checkout[]{first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS)};
            assertThat(results[0].order()).isEqualTo(results[1].order());
            assertThat(results[0].created()).isNotEqualTo(results[1].created());
            assertThat(database.sql("SELECT order_id FROM order_outbox").query(Long.class).single())
                    .isEqualTo(results[0].order().id());
        }
    }

    @Test
    void retainsReturnedEventUntilItIsConfirmedAndRouted() {
        orders.checkout("retry-key", "Test", new BigDecimal("15.00"));
        UUID eventId = database.sql("SELECT event_id FROM order_outbox").query(UUID.class).single();
        doAnswer(invocation -> {
            Message message = invocation.getArgument(2);
            CorrelationData correlation = invocation.getArgument(3);
            assertThat(message.getMessageProperties().getMessageId()).isEqualTo(eventId.toString());
            assertThat(message.getMessageProperties().getDeliveryMode()).isEqualTo(MessageDeliveryMode.PERSISTENT);
            correlation.setReturned(new ReturnedMessage(message, 312, "NO_ROUTE",
                    OrderMessaging.EXCHANGE, OrderMessaging.ORDER_CREATED));
            correlation.getFuture().complete(new CorrelationData.Confirm(true, null));
            return null;
        }).doAnswer(invocation -> {
            Message message = invocation.getArgument(2);
            CorrelationData correlation = invocation.getArgument(3);
            assertThat(message.getMessageProperties().getMessageId()).isEqualTo(eventId.toString());
            correlation.getFuture().complete(new CorrelationData.Confirm(true, null));
            return null;
        }).when(rabbit).send(eq(OrderMessaging.EXCHANGE), eq(OrderMessaging.ORDER_CREATED),
                any(Message.class), any(CorrelationData.class));

        relay.publishPending();
        assertThat(database.sql("SELECT attempts FROM order_outbox").query(Integer.class).single()).isEqualTo(1);
        database.sql("UPDATE order_outbox SET next_attempt_at = CURRENT_TIMESTAMP").update();
        relay.publishPending();
        assertThat(database.sql("SELECT event_id FROM order_outbox").query(UUID.class).list()).isEmpty();
    }
}

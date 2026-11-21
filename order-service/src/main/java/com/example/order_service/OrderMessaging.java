package com.example.order_service;

import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.Declarables;
import org.springframework.amqp.core.DirectExchange;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
class OrderMessaging {
    static final String EXCHANGE = "commerce.orders";
    static final String ORDER_CREATED = "order.created.v1";
    private static final String QUEUE = "commerce.order-events.v1";
    private static final String DEAD_EXCHANGE = "commerce.orders.dlx";
    private static final String DEAD_QUEUE = "commerce.order-events.dlq.v1";
    private static final String DEAD_ROUTE = "order.created.v1.dead";

    @Bean
    Declarables orderEvents() {
        var exchange = new TopicExchange(EXCHANGE, true, false);
        var deadExchange = new DirectExchange(DEAD_EXCHANGE, true, false);
        var deadQueue = QueueBuilder.durable(DEAD_QUEUE).build();
        var queue = QueueBuilder.durable(QUEUE)
                .deadLetterExchange(DEAD_EXCHANGE)
                .deadLetterRoutingKey(DEAD_ROUTE)
                .build();
        return new Declarables(exchange, deadExchange, queue, deadQueue,
                BindingBuilder.bind(queue).to(exchange).with(ORDER_CREATED),
                BindingBuilder.bind(deadQueue).to(deadExchange).with(DEAD_ROUTE));
    }
}

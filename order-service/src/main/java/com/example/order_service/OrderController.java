package com.example.order_service;

import jakarta.persistence.*;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

@Entity
@Table(name = "orders")
class Order {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;
    public String product;
    public Double price;
}

@RestController
@RequestMapping("/api/orders")
public class OrderController {
    @Autowired
    private RabbitTemplate rabbitTemplate;
    
    @Autowired
    private EntityManager entityManager;

    @PostMapping("/checkout")
    @jakarta.transaction.Transactional
    public String placeOrder(@RequestBody Order order) {
        entityManager.persist(order);
        String message = "OrderPlaced Event: ID " + order.id + " for " + order.product;
        rabbitTemplate.convertAndSend("amq.topic", "order.created", message);
        return "Order successfully placed and event broadcasted!";
    }
}
package com.example.order_service;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
    private static final Pattern IDEMPOTENCY_KEY = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final BigDecimal MAX_PRICE = new BigDecimal("9999999999.99");

    private final OrderService orders;
    private final byte[] serviceToken;

    public OrderController(OrderService orders, @Value("${checkout.service-token}") String serviceToken) {
        this.orders = orders;
        this.serviceToken = serviceToken.getBytes(StandardCharsets.UTF_8);
        if (serviceToken.isBlank() || this.serviceToken.length < 32) {
            throw new IllegalArgumentException("CHECKOUT_SERVICE_TOKEN must contain at least 32 bytes");
        }
    }

    @PostMapping("/checkout")
    public ResponseEntity<OrderService.Order> checkout(
            @RequestHeader(value = "X-Checkout-Service-Token", required = false) String providedToken,
            @RequestHeader(value = "Idempotency-Key", required = false) String key,
            @RequestBody CheckoutRequest request) {
        if (providedToken == null || !MessageDigest.isEqual(serviceToken, providedToken.getBytes(StandardCharsets.UTF_8))) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid checkout service token");
        }
        if (key == null || !IDEMPOTENCY_KEY.matcher(key).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A valid Idempotency-Key is required");
        }

        String product = request.product() == null ? "" : request.product().strip();
        if (product.isEmpty() || product.length() > 255 || product.indexOf('\0') >= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Product must contain between 1 and 255 characters");
        }

        BigDecimal price = request.price();
        if (price == null || price.signum() <= 0 || price.compareTo(MAX_PRICE) > 0 || price.stripTrailingZeros().scale() > 2) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Price must be positive and have at most two decimal places");
        }

        OrderService.Checkout result = orders.checkout(key, product, price.setScale(2));
        return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(result.order());
    }

    public record CheckoutRequest(String product, BigDecimal price) {}
}

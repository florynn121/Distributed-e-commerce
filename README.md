# Distributed E-Commerce Backend

This is a distributed e-commerce backend I built to practice microservices, event-driven architecture, and fault tolerance. It handles order processing asynchronously, preventing UI blocking and allowing independent scaling of core business logic and background tasks.

## Tech Stack
* **API Gateway:** Node.js / Express
* **Order Service:** Java 21 / Spring Boot
* **AI Processing Service:** Python / FastAPI
* **Message Broker:** RabbitMQ
* **Database:** PostgreSQL
* **Infrastructure:** Docker Compose

## Key Features
* **Security:** The API edge is secured using JWT authentication. Downstream services are isolated and communicate securely.
* **Event-Driven:** When an order is placed, the Java service writes to PostgreSQL and publishes an event to RabbitMQ, decoupling the transaction from the heavy AI processing.
* **Fault Tolerance:** The Python consumer uses manual acknowledgments (`auto_ack=False`) and connection retry loops. If processing fails or crashes, RabbitMQ routes the lost order to a Dead Letter Queue (DLQ) for inspection.
* **Containerized:** The entire 5-container architecture is orchestrated with Docker Compose, utilizing `depends_on` rules to handle boot race conditions.

## Running Locally
1. Clone the repo.
2. Create a `.env` file in the root directory (add your `POSTGRES_USER`, `POSTGRES_PASSWORD`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, and `JWT_SECRET`).
3. Run `docker-compose up -d --build`.
4. The frontend will be available at `http://localhost:3000`.
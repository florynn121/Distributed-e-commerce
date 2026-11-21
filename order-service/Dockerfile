FROM eclipse-temurin:21-jdk-alpine AS build

WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.m2 sh ./mvnw -B -ntp -DskipTests package

FROM eclipse-temurin:21-jre-alpine

RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
COPY --from=build --chown=app:app /app/target/order-service-*.jar /app/app.jar

USER app
EXPOSE 8080
CMD ["java", "-jar", "/app/app.jar"]

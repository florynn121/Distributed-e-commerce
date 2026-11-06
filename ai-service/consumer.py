import pika, os, time, json

def connect_with_retry():
    # The 'or' keyword ensures that if Docker passes an empty string "", it falls back to 'guest'
    rabbit_user = os.environ.get('RABBITMQ_USER') or 'guest'
    rabbit_pass = os.environ.get('RABBITMQ_PASSWORD') or 'guest'
    credentials = pika.PlainCredentials(rabbit_user, rabbit_pass)
    
    # Retry loop: Try to connect 10 times, waiting 5 seconds between tries
    for i in range(10):
        try:
            print(f"[AI Service] Attempting to connect to RabbitMQ (Attempt {i+1}/10)...")
            return pika.BlockingConnection(pika.ConnectionParameters(host='rabbitmq', credentials=credentials))
        except pika.exceptions.AMQPConnectionError:
            print(f"[AI Service] RabbitMQ not ready. Retrying in 5s...")
            time.sleep(5)
    raise Exception("Could not connect to RabbitMQ after 10 attempts.")

def main():
    connection = connect_with_retry()
    channel = connection.channel()

    # 1. Create the Dead Letter Exchange and Queue
    channel.exchange_declare(exchange='dlx', exchange_type='direct')
    channel.queue_declare(queue='dead_letter_queue')
    channel.queue_bind(exchange='dlx', queue='dead_letter_queue', routing_key='dlq_routing_key')

    # 2. Configure the Main Queue to forward failures to the DLX
    queue_args = {
        'x-dead-letter-exchange': 'dlx',
        'x-dead-letter-routing-key': 'dlq_routing_key'
    }
    channel.queue_declare(queue='order_queue', arguments=queue_args)

    def callback(ch, method, properties, body):
        try:
            message = body.decode()
            print(f"[AI Service] Processing: {message}")
            time.sleep(1) # Simulate heavy AI processing
            
            # Simulate a fatal crash if the order contains the word "Crash"
            if "Crash" in message:
                raise Exception("Simulated processing crash!")

            print("[AI Service] Success! Manually acknowledging.")
            ch.basic_ack(delivery_tag=method.delivery_tag)
            
        except Exception as e:
            print(f"[AI Service] FAILED: {str(e)} -> Routing to DLQ.")
            # requeue=False rejects the message and sends it to the DLQ
            ch.basic_reject(delivery_tag=method.delivery_tag, requeue=False)

    # 3. auto_ack=False forces RabbitMQ to wait for basic_ack
    channel.basic_consume(queue='order_queue', on_message_callback=callback, auto_ack=False)

    print('[AI Service] Waiting for messages...')
    channel.start_consuming()

if __name__ == '__main__':
    main()
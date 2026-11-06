FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN pip install pika fastapi uvicorn
CMD ["python", "consumer.py"]
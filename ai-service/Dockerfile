FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

FROM base AS search

COPY requirements-search.txt ./
RUN python -m pip install -r requirements-search.txt \
    && install -d -o app -g app /app/model-cache
COPY --chown=app:app main.py ./
USER app
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--limit-concurrency", "16"]

FROM base AS worker

COPY requirements-worker.txt ./
RUN python -m pip install -r requirements-worker.txt
COPY --chown=app:app consumer.py ./
USER app
CMD ["python", "consumer.py"]

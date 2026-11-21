"""Private semantic product indexing and search."""

import os
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query, Request
from fastembed import TextEmbedding
from huggingface_hub import snapshot_download
from pydantic import BaseModel, ConfigDict, Field
from qdrant_client import QdrantClient, models
from qdrant_client.http.exceptions import ResponseHandlingException, UnexpectedResponse

COLLECTION = "products"
MODEL = "sentence-transformers/all-MiniLM-L6-v2"
MODEL_REPOSITORY = "Qdrant/all-MiniLM-L6-v2-onnx"
MODEL_REVISION = "d13954661f83248295ba75c1ed411eef3b7b936e"
VECTOR_SIZE = 384
QDRANT_ERRORS = (ResponseHandlingException, UnexpectedResponse)


class ProductInfo(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    id: int = Field(strict=True, gt=0, le=2**64 - 1)
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=4000)


def load_encoder() -> TextEmbedding:
    cache_directory = os.getenv("EMBEDDING_CACHE_DIR", "/tmp/order-embedding-cache")
    model_path = os.getenv("EMBEDDING_MODEL_PATH")
    if not model_path:
        model_path = snapshot_download(
            repo_id=MODEL_REPOSITORY,
            revision=MODEL_REVISION,
            cache_dir=cache_directory,
            allow_patterns=[
                "config.json",
                "model.onnx",
                "special_tokens_map.json",
                "tokenizer.json",
                "tokenizer_config.json",
                "vocab.txt",
            ],
            max_workers=2,
            etag_timeout=10,
        )
    return TextEmbedding(
        model_name=MODEL,
        cache_dir=cache_directory,
        specific_model_path=model_path,
        local_files_only=True,
        threads=2,
    )


def check_collection(client: QdrantClient) -> None:
    vectors = client.get_collection(COLLECTION).config.params.vectors
    if (
        not isinstance(vectors, models.VectorParams)
        or vectors.size != VECTOR_SIZE
        or vectors.distance != models.Distance.COSINE
    ):
        raise ValueError("products collection must use 384-dimensional cosine vectors")


def prepare_collection(client: QdrantClient) -> None:
    if not client.collection_exists(COLLECTION):
        try:
            client.create_collection(
                collection_name=COLLECTION,
                vectors_config=models.VectorParams(size=VECTOR_SIZE, distance=models.Distance.COSINE),
            )
        except UnexpectedResponse:
            # An overlapping start may have created the collection first.
            if not client.collection_exists(COLLECTION):
                raise
    check_collection(client)


@asynccontextmanager
async def lifespan(app: FastAPI):
    client = QdrantClient(
        url=os.getenv("QDRANT_URL", "http://qdrant:6333"),
        api_key=os.getenv("QDRANT_API_KEY") or None,
        timeout=5,
    )
    try:
        prepare_collection(client)
        app.state.client = client
        app.state.encoder = load_encoder()
        yield
    finally:
        client.close()


app = FastAPI(lifespan=lifespan)


@app.get("/livez", include_in_schema=False)
def live():
    return {"status": "ok"}


@app.get("/readyz", include_in_schema=False)
def ready(request: Request):
    try:
        check_collection(request.app.state.client)
    except (*QDRANT_ERRORS, ValueError):
        raise HTTPException(status_code=503, detail="Search storage unavailable") from None
    return {"status": "ok"}


@app.post("/index-product")
def index_product(product: ProductInfo, request: Request):
    vector = next(request.app.state.encoder.embed([product.description])).tolist()
    try:
        request.app.state.client.upsert(
            collection_name=COLLECTION,
            points=[
                models.PointStruct(
                    id=product.id,
                    vector=vector,
                    payload={"name": product.name, "description": product.description},
                )
            ],
            wait=True,
        )
    except QDRANT_ERRORS:
        raise HTTPException(status_code=503, detail="Search storage unavailable") from None
    return {"status": f"Successfully indexed: {product.name}"}


@app.get("/search")
def search_product(query: Annotated[str, Query(min_length=1, max_length=512)], request: Request):
    query = query.strip()
    if not query:
        raise HTTPException(status_code=422, detail="Search query cannot be blank")

    vector = next(request.app.state.encoder.embed([query])).tolist()
    try:
        hits = request.app.state.client.query_points(
            collection_name=COLLECTION,
            query=vector,
            limit=3,
            with_payload=["name"],
        ).points
    except QDRANT_ERRORS:
        raise HTTPException(status_code=503, detail="Search storage unavailable") from None
    return {
        "matches": [
            {"name": hit.payload["name"], "score": hit.score}
            for hit in hits
            if hit.payload and isinstance(hit.payload.get("name"), str)
        ]
    }

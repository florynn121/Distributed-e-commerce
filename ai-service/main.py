from fastapi import FastAPI
from pydantic import BaseModel
from qdrant_client import QdrantClient
from qdrant_client.models import VectorParams, Distance, PointStruct
from sentence_transformers import SentenceTransformer

app = FastAPI()

# Connect to the local Qdrant container we spun up earlier
qdrant = QdrantClient("localhost", port=6333)

# Load a lightweight embedding model (downloads automatically on first run)
model = SentenceTransformer('all-MiniLM-L6-v2') 
COLLECTION_NAME = "products"

# Create the vector collection if it doesn't exist
try:
    qdrant.get_collection(COLLECTION_NAME)
except:
    qdrant.create_collection(
        collection_name=COLLECTION_NAME,
        vectors_config=VectorParams(size=384, distance=Distance.COSINE),
    )

class ProductInfo(BaseModel):
    id: int
    name: str
    description: str

@app.post("/index-product")
async def index_product(product: ProductInfo):
    # Convert text description into a 384-dimensional vector
    vector = model.encode(product.description).tolist() 
    
    qdrant.upsert(
        collection_name=COLLECTION_NAME,
        points=[
            PointStruct(
                id=product.id,
                vector=vector,
                payload={"name": product.name, "description": product.description}
            )
        ]
    )
    return {"status": f"Successfully indexed: {product.name}"}

@app.get("/search")
async def search_product(query: str):
    # Vectorize the user's search query to find the closest mathematical matches
    vector = model.encode(query).tolist()
    
    results = qdrant.search(
        collection_name=COLLECTION_NAME,
        query_vector=vector,
        limit=3
    )
    return {"matches": [{"name": hit.payload["name"], "score": hit.score} for hit in results]}
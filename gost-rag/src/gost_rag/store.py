"""Qdrant vector store: dense retrieval, or dense+BM25 HYBRID, plus a metadata filter.

Two modes, chosen by whether a sparse Bm25Encoder is supplied:
- dense-only (default): one unnamed cosine vector; the lean baseline.
- hybrid (sparse=...): a named "dense" vector + a "bm25" sparse vector, fused server-side with RRF.
  Uses its own collection ("<name>_hybrid") so both modes can be indexed and compared side by side.
"""

from __future__ import annotations

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    Fusion,
    FusionQuery,
    MatchValue,
    PointStruct,
    Prefetch,
    SparseVector,
    SparseVectorParams,
    VectorParams,
)

from .embeddings import Embedder
from .schema import Chunk, RetrievedChunk
from .sparse import Bm25Encoder


class Store:
    def __init__(self, url: str, collection: str, embedder: Embedder, sparse: Bm25Encoder | None = None):
        self._client = QdrantClient(url=url)
        self._embedder = embedder
        self._sparse = sparse
        self._hybrid = sparse is not None
        self._collection = collection + ("_hybrid" if self._hybrid else "")

    def reset(self) -> None:
        # create_collection (not the deprecated recreate_collection, removed in newer clients).
        if self._client.collection_exists(self._collection):
            self._client.delete_collection(self._collection)
        if self._hybrid:
            self._client.create_collection(
                collection_name=self._collection,
                vectors_config={"dense": VectorParams(size=self._embedder.dim, distance=Distance.COSINE)},
                sparse_vectors_config={"bm25": SparseVectorParams()},
            )
        else:
            self._client.create_collection(
                collection_name=self._collection,
                vectors_config=VectorParams(size=self._embedder.dim, distance=Distance.COSINE),
            )

    def index(self, chunks: list[Chunk], batch: int = 64) -> int:
        for i in range(0, len(chunks), batch):
            window = chunks[i : i + batch]
            dense = self._embedder.embed_documents([c.text for c in window])
            if self._hybrid:
                assert self._sparse is not None
                points = [
                    PointStruct(
                        id=c.id,
                        vector={"dense": dv, "bm25": SparseVector(**self._sparse.encode_document(c.text))},
                        payload=c.model_dump(),
                    )
                    for c, dv in zip(window, dense)
                ]
            else:
                points = [
                    PointStruct(id=c.id, vector=dv, payload=c.model_dump())
                    for c, dv in zip(window, dense)
                ]
            self._client.upsert(collection_name=self._collection, points=points)
        return len(chunks)

    def search(self, query: str, top_k: int = 8, industry: str | None = None) -> list[RetrievedChunk]:
        qfilter = (
            Filter(must=[FieldCondition(key="industry", match=MatchValue(value=industry))])
            if industry
            else None
        )
        if self._hybrid:
            assert self._sparse is not None
            sv = self._sparse.encode_query(query)
            res = self._client.query_points(
                collection_name=self._collection,
                prefetch=[
                    Prefetch(query=self._embedder.embed_query(query), using="dense", limit=top_k, filter=qfilter),
                    Prefetch(query=SparseVector(**sv), using="bm25", limit=top_k, filter=qfilter),
                ],
                query=FusionQuery(fusion=Fusion.RRF),
                limit=top_k,
                with_payload=True,
            ).points
            return [RetrievedChunk(chunk=Chunk.model_validate(p.payload), score=p.score) for p in res]

        res = self._client.query_points(  # .search() was removed in qdrant-client 1.18
            collection_name=self._collection,
            query=self._embedder.embed_query(query),
            limit=top_k,
            query_filter=qfilter,
            with_payload=True,
        ).points
        return [RetrievedChunk(chunk=Chunk.model_validate(p.payload), score=p.score) for p in res]

"""HTTP-сервис, чтобы продукт (engine) мог ЗАЗЕМЛЯТЬ ответы в ГОСТ — сейчас этого нет, поэтому в вебе
ответы не подпёрты базой знаний.

Эндпоинты:
- POST /retrieve {query, top_k} → {context, top_score, chunks, sources}: winner-ретрив (hybrid dense+BM25
  + диверсификация по документам). engine инъектит `context` в системный промпт (минимально, модель-
  агностично) и вешает `sources` (резолвленные Source[] ретривнутых документов) в metadata ответа.
- POST /ask {query, model?} → {text, abstained, citations, sources, validation}: ПОЛНЫЙ пайплайн gost-rag
  (retrieve→generate→validate→abstain→cite) — авторитетный заземлённый ответ с цитатами/источниками.

Запуск:  uv run --extra serve uvicorn gost_rag.server:app --host 0.0.0.0 --port 8000
         (или `make serve` из gost-rag/)
"""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from .agent import answer_gost_query
from .config import load_settings
from .embeddings import Embedder
from .generate import format_context
from .sources import resolve_citations, sources_for_hits
from .sparse import Bm25Encoder
from .store import Store

TOP_K = 16  # winner config

app = FastAPI(title="gost-rag")
_settings = load_settings()
# winner retrieval: hybrid (dense+BM25) store; diversify is a per-search flag below.
_store = Store(_settings.qdrant_url, _settings.qdrant_collection, Embedder(_settings), sparse=Bm25Encoder())


class RetrieveReq(BaseModel):
    query: str
    top_k: int = TOP_K


@app.post("/retrieve")
def retrieve(req: RetrieveReq) -> dict:
    hits = _store.search(req.query, top_k=req.top_k, diversify=True)
    return {
        "context": format_context(hits),
        "top_score": hits[0].score if hits else 0.0,
        "chunks": [{"gost_id": h.chunk.gost_id, "clause_path": h.chunk.clause_path, "score": h.score} for h in hits],
        "sources": [s.model_dump() for s in sources_for_hits(hits)],
    }


class AskReq(BaseModel):
    query: str
    model: str | None = None


@app.post("/ask")
def ask(req: AskReq) -> dict:
    r = answer_gost_query(req.query, strategy="rag", gen_model=req.model, top_k=TOP_K, hybrid=True, diversify=True)
    return {
        "text": r.answer.text,
        "abstained": r.answer.abstained,
        "citations": [c.model_dump() for c in r.answer.citations],
        "sources": [s.model_dump() for s in resolve_citations(r.answer.citations)],
        "validation": ({"ok": r.validation.ok, "faithfulness": r.validation.faithfulness} if r.validation else None),
    }


@app.get("/health")
def health() -> dict:
    """Readiness, not just liveness — so ops sees a meaningful status instead of a 401/timeout on the
    first /retrieve. Reports whether the embeddings key is configured and Qdrant + its collection exist."""
    embeddings_key = bool(_settings.embeddings_api_key or _settings.openrouter_api_key or _settings.litellm_api_key)
    try:
        qdrant_ready = _store._client.collection_exists(_store._collection)
    except Exception:  # noqa: BLE001 — unreachable Qdrant must surface as not-ready, not a 500
        qdrant_ready = False
    return {
        "ok": embeddings_key and qdrant_ready,
        "embeddings_key": embeddings_key,
        "qdrant": qdrant_ready,
        "collection": _store._collection,
    }

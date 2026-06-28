"""HTTP-сервис, чтобы продукт (engine) мог ЗАЗЕМЛЯТЬ ответы в ГОСТ — сейчас этого нет, поэтому в вебе
ответы не подпёрты базой знаний.

Эндпоинты:
- POST /retrieve {query, top_k} → {context, top_score, chunks}: winner-ретрив (hybrid dense+BM25 +
  диверсификация по документам). engine инъектит `context` в системный промпт — минимально, модель-агностично.
- POST /ask {query, model?} → {text, abstained, citations, sources, validation}: ПОЛНЫЙ пайплайн gost-rag
  (retrieve→generate→validate→abstain→cite) — авторитетный заземлённый ответ с цитатами/источниками.

Запуск:  uv run --extra serve uvicorn gost_rag.server:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from .agent import answer_gost_query
from .config import load_settings
from .embeddings import Embedder
from .generate import format_context
from .sources import resolve_citations
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
    return {"ok": True}

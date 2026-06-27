"""Single entrypoint for the ГОСТ agent — the reuse hook.

Call `answer_gost_query(...)` from anywhere (CLI, eval harness, or later as a
sub-task/tool inside the матзаявки agent). Returns a structured Result with the
answer, its validation report, and cost/latency — never a bare string.
"""

from __future__ import annotations

import time
from pathlib import Path

from .config import ROOT, load_settings
from .corpus import chunk_documents, load_corpus
from .embeddings import Embedder
from .llm import LLM
from .multiagent import (
    CascadeStrategy,
    DecomposeStrategy,
    ModelEnsembleStrategy,
    SelfConsistencyStrategy,
    VerifyEnsembleStrategy,
)
from .rerank import NativeReranker
from .schema import Result
from .sparse import Bm25Encoder
from .store import Store
from .strategies import RAGStrategy, RLMStrategy

FIXTURES = ROOT / "data" / "fixtures"

# Strategies that retrieve via Qdrant (built with a Store, like RAG). Multi-agent variants (Stream C)
# take their tuning kwargs straight from config/models.yaml via **opts.
_STORE_STRATEGIES = {
    "rag": RAGStrategy,
    "verify_ensemble": VerifyEnsembleStrategy,
    "decompose": DecomposeStrategy,
    "self_consistency": SelfConsistencyStrategy,
    "model_ensemble": ModelEnsembleStrategy,
    "cascade": CascadeStrategy,
}


def build_strategy(name: str, *, gen_model: str | None = None, **opts):
    settings = load_settings()
    llm = LLM(settings)
    gen_model = gen_model or settings.gen_model
    judge_model = settings.judge_model

    if name in _STORE_STRATEGIES:
        # Stream D ablations: hybrid (dense+BM25) Store and/or a native reranker, driven by opts.
        sparse = Bm25Encoder() if opts.get("hybrid") else None
        store = Store(settings.qdrant_url, settings.qdrant_collection, Embedder(settings), sparse=sparse)
        opts = {k: v for k, v in opts.items() if k != "hybrid"}  # consumed by Store, not the strategy
        if name == "rag" and str(opts.get("rerank")).lower() == "native":
            opts["reranker"] = NativeReranker(settings.rerank_base_url, settings.rerank_api_key, settings.rerank_model)
        return _STORE_STRATEGIES[name](llm, store, gen_model, judge_model, **opts)
    if name == "rlm":
        # RLM reads the corpus directly (no Qdrant). Prefer the real PDF corpus when present, else
        # the JSON fixtures; load_corpus auto-detects pdf/json so RLM matches what RAG indexed.
        pdf_dir = ROOT / "data" / "pdfs"
        default_src = pdf_dir if any(pdf_dir.glob("*.pdf")) else FIXTURES
        src = opts.get("fixtures") or opts.get("corpus") or default_src
        chunks = chunk_documents(load_corpus(src, registry_path=ROOT / "data" / "registry.yaml"))
        return RLMStrategy(llm, chunks, gen_model, judge_model,
                           max_steps=opts.get("max_steps", 12), max_depth=opts.get("max_depth", 2))
    raise ValueError(f"unknown strategy: {name!r} (expected one of {sorted(_STORE_STRATEGIES) + ['rlm']})")


def answer_gost_query(query: str, strategy: str = "rag", *, gen_model: str | None = None,
                      industry: str | None = None, **opts) -> Result:
    strat = build_strategy(strategy, gen_model=gen_model, **opts)
    t0 = time.perf_counter()
    result = strat.answer(query, industry=industry)
    result.usage.latency_s = round(time.perf_counter() - t0, 2)
    return result

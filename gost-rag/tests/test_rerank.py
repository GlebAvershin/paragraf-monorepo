"""Unit tests for the native reranker's pure ordering (Stream D2) — no HTTP."""

from __future__ import annotations

from gost_rag.rerank import reorder
from gost_rag.schema import Chunk, RetrievedChunk


def _hits(n):
    return [RetrievedChunk(chunk=Chunk(id=str(i), gost_id="g", clause_path=str(i), title="", text=f"t{i}"), score=0.0)
            for i in range(n)]


def test_reorder_sorts_by_relevance_and_rewrites_scores():
    hits = _hits(3)
    results = [{"index": 0, "relevance_score": 0.1}, {"index": 2, "relevance_score": 0.9}, {"index": 1, "relevance_score": 0.5}]
    out = reorder(hits, results, top_k=3)
    assert [h.chunk.clause_path for h in out] == ["2", "1", "0"]
    assert out[0].score == 0.9


def test_reorder_truncates_to_top_k():
    out = reorder(_hits(5), [{"index": i, "relevance_score": i / 10} for i in range(5)], top_k=2)
    assert [h.chunk.clause_path for h in out] == ["4", "3"]


def test_reorder_appends_unranked_and_ignores_bad_indices():
    hits = _hits(3)
    # reranker scored only index 1, plus a garbage out-of-range index → unranked (0,2) appended in order
    out = reorder(hits, [{"index": 1, "relevance_score": 0.9}, {"index": 99, "relevance_score": 1.0}], top_k=3)
    assert [h.chunk.clause_path for h in out] == ["1", "0", "2"]


def test_reorder_empty_results_keeps_original_order():
    out = reorder(_hits(2), [], top_k=8)
    assert [h.chunk.clause_path for h in out] == ["0", "1"]

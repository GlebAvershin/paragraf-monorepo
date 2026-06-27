"""RAGStrategy guardrail enforcement (Phase 1 fix A) — the cheapest precision lever.

The validator was already computed but plain RAG returned the answer unmodified, so answers the
guardrail rejected were still 'emitted' → false positives. These tests pin the fix: gate=True
flips a rejected answer to abstained; gate=False keeps the raw (un-gated) baseline.
"""

from __future__ import annotations

import gost_rag.strategies as strat
from gost_rag.schema import Answer, Chunk, Citation, RetrievedChunk, ValidationReport


class _FakeStore:
    def search(self, query, top_k=8, industry=None, **kwargs):
        chunk = Chunk(id="x", gost_id="ГОСТ 1", clause_path="5.1", title="", industry="", text="текст")
        return [RetrievedChunk(chunk=chunk, score=1.0)]


def _patch(monkeypatch, *, ok: bool):
    answer = Answer(text="ответ", citations=[Citation(gost_id="ГОСТ 1", clause_path="5.1", quote="текст")])
    monkeypatch.setattr(strat, "generate_answer", lambda *a, **k: answer.model_copy())
    monkeypatch.setattr(strat, "validate", lambda *a, **k: ValidationReport(ok=ok, faithfulness=1.0))


def test_rag_gate_abstains_when_validation_fails(monkeypatch):
    _patch(monkeypatch, ok=False)
    s = strat.RAGStrategy(llm=None, store=_FakeStore(), gen_model="m", judge_model="j", gate=True)
    assert s.answer("q").answer.abstained is True


def test_rag_gate_keeps_answer_when_validation_passes(monkeypatch):
    _patch(monkeypatch, ok=True)
    s = strat.RAGStrategy(llm=None, store=_FakeStore(), gen_model="m", judge_model="j", gate=True)
    assert s.answer("q").answer.abstained is False


def test_rag_raw_baseline_emits_even_when_validation_fails(monkeypatch):
    _patch(monkeypatch, ok=False)
    s = strat.RAGStrategy(llm=None, store=_FakeStore(), gen_model="m", judge_model="j", gate=False)
    assert s.answer("q").answer.abstained is False  # raw baseline does NOT enforce the gate


def test_diversify_by_doc_round_robins_across_documents():
    from gost_rag.store import _diversify_by_doc

    def h(gid, cp, score):
        return RetrievedChunk(chunk=Chunk(id=f"{gid}:{cp}", gost_id=gid, clause_path=cp, title="", text="t"), score=score)

    # docA dominates by score (3 chunks); B and C have 1 each — exactly the clustering that starves recall
    hits = [h("A", "1", 0.9), h("A", "2", 0.85), h("A", "3", 0.8), h("B", "1", 0.7), h("C", "1", 0.6)]
    # top_k=3 → one from each distinct doc before a second from A (maximizes documents covered)
    assert [x.chunk.gost_id for x in _diversify_by_doc(hits, 3)] == ["A", "B", "C"]
    # top_k=5 → after every doc represented, fill with the remaining best chunks
    assert [x.chunk.gost_id for x in _diversify_by_doc(hits, 5)] == ["A", "B", "C", "A", "A"]

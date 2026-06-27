"""Validation thresholds are tunable (Phase 2 abstain calibration) — faith + quote thresholds
thread through validate()/check_citations so an operating point can be locked in per config."""

from __future__ import annotations

import gost_rag.validate as v
from gost_rag.schema import Answer, Citation, Usage


def test_check_citations_respects_quote_threshold():
    ctx = {("Г", "1"): "это дословный текст пункта"}
    ans = Answer(text="a", citations=[Citation(gost_id="Г", clause_path="1", quote="дословный")])
    # exact substring → partial_ratio 100: found at 80, not found above 100 (proves the knob is wired)
    assert v.check_citations(ans, ctx, quote_threshold=80.0)[0].quote_found is True
    assert v.check_citations(ans, ctx, quote_threshold=101.0)[0].quote_found is False


def test_validate_respects_custom_faith_threshold(monkeypatch):
    ctx = {("Г", "1"): "это дословный текст пункта"}
    ans = Answer(text="a", citations=[Citation(gost_id="Г", clause_path="1", quote="дословный")])
    monkeypatch.setattr(v, "judge_faithfulness", lambda *a, **k: (0.6, []))
    assert v.validate(None, "j", "q", ans, ctx, "ctx", Usage()).ok is True            # 0.6 ≥ default 0.5
    assert v.validate(None, "j", "q", ans, ctx, "ctx", Usage(), faith_threshold=0.7).ok is False  # 0.6 < 0.7

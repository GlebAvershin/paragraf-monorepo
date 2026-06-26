"""Unit tests for the benchmark scoring/stats — pure, no network."""

from __future__ import annotations

from gost_rag.evalmetrics import (
    aggregate,
    bootstrap_ci,
    corpus_citation_diagnostics,
    cost_usd,
    outcome,
    precision_of,
)
from gost_rag.schema import (
    Answer,
    Citation,
    CitationCheck,
    Result,
    Usage,
    ValidationReport,
)


def _result(*, abstained=False, contexts=(), citations=(), checks=(), valid_ok=True,
            faith=1.0, pt=0, ct=0) -> Result:
    return Result(
        query="q", strategy="rag", model="m",
        answer=Answer(text="" if abstained else "ответ", citations=list(citations), abstained=abstained),
        validation=ValidationReport(ok=valid_ok, faithfulness=faith, citation_checks=list(checks)),
        usage=Usage(prompt_tokens=pt, completion_tokens=ct),
        contexts=list(contexts),
    )


def _gold(expects=True, expected=None, ref=""):
    return {"expects_answer": expects, "expected": expected or [], "reference": ref}


# ---- cost ----

def test_cost_usd_math_and_null():
    assert cost_usd(1_000_000, 1_000_000, {"in": 1.0, "out": 2.0}) == 3.0
    assert cost_usd(500_000, 0, {"in": 4.0, "out": 9.0}) == 2.0
    assert cost_usd(10, 10, None) is None
    assert cost_usd(10, 10, {"in": None, "out": 2.0}) is None


# ---- outcome (the trust core) ----

def test_positive_correct():
    r = _result(contexts=["ГОСТ Р 7.0.97-2016, п. 5.1"], valid_ok=True)
    o = outcome(r, _gold(expected=[{"gost_id": "ГОСТ Р 7.0.97-2016", "clause_path": "5.1"}]))
    assert o["correct"] and not o["false_positive"] and o["emitted"]


def test_positive_answered_but_ungrounded_is_false_positive():
    # recall hit but validation rejected → confidently wrong
    r = _result(contexts=["ГОСТ Р 7.0.97-2016, п. 5.1"], valid_ok=False)
    o = outcome(r, _gold(expected=[{"gost_id": "ГОСТ Р 7.0.97-2016", "clause_path": "5.1"}]))
    assert not o["correct"] and o["false_positive"]


def test_positive_abstained_is_neither_correct_nor_fp():
    o = outcome(_result(abstained=True), _gold(expected=[{"gost_id": "g", "clause_path": "1"}]))
    assert not o["emitted"] and not o["correct"] and not o["false_positive"]


def test_negative_abstain_is_correct():
    o = outcome(_result(abstained=True), _gold(expects=False))
    assert o["correct"] and not o["false_positive"]


def test_negative_answered_is_false_positive():
    o = outcome(_result(contexts=["x"]), _gold(expects=False))
    assert not o["correct"] and o["false_positive"]


# ---- aggregate ----

def test_aggregate_precision_coverage_fpr():
    rows = [
        {"expects": True, "emitted": True, "correct": True, "false_positive": False,
         "recall": 1.0, "cit_acc": 1.0, "faith": 1.0, "valid_ok": True, "tokens": 10, "latency": 0.1},
        {"expects": True, "emitted": True, "correct": False, "false_positive": True,
         "recall": 0.0, "cit_acc": 0.0, "faith": 0.0, "valid_ok": False, "tokens": 20, "latency": 0.2},
        {"expects": True, "emitted": False, "correct": False, "false_positive": False,
         "recall": 0.0, "cit_acc": 1.0, "faith": 0.0, "valid_ok": False, "tokens": 5, "latency": 0.1},
    ]
    agg = aggregate(rows)
    assert agg["coverage"] == 2 / 3            # 2 of 3 emitted
    assert agg["precision"] == 0.5             # of 2 emitted, 1 correct
    assert round(agg["fpr"], 3) == round(1 / 3, 3)
    assert agg["cost"] is None                 # no prices in rows


def test_aggregate_precision_none_when_nothing_emitted():
    rows = [{"expects": True, "emitted": False, "correct": False, "false_positive": False,
             "recall": 0.0, "cit_acc": 1.0, "faith": 0.0, "valid_ok": False, "tokens": 0, "latency": 0.0}]
    assert aggregate(rows)["precision"] is None


# ---- bootstrap CI ----

def test_bootstrap_ci_is_deterministic_and_bounded():
    rows = [{"emitted": True, "correct": i % 2 == 0} for i in range(20)]
    a = bootstrap_ci(rows, precision_of, iters=500, seed=42)
    b = bootstrap_ci(rows, precision_of, iters=500, seed=42)
    assert a == b
    assert 0.0 <= a[0] <= a[1] <= 1.0


# ---- corpus diagnostics (retrieval miss vs fabrication) ----

def test_corpus_diagnostics_separates_miss_from_fabrication():
    corpus = {("ГОСТ Р 7.0.97-2016", "5.1"), ("ГОСТ Р 7.0.97-2016", "6.4")}
    r = _result(
        citations=[
            Citation(gost_id="ГОСТ Р 7.0.97-2016", clause_path="6.4", quote="x"),  # real, not retrieved → miss
            Citation(gost_id="ГОСТ Р 7.0.97-2016", clause_path="9.9", quote="y"),  # not in corpus → fabricated
        ],
        checks=[],  # nothing marked in_context
    )
    d = corpus_citation_diagnostics(r, corpus)
    assert d == {"retrieval_miss": 1, "fabricated": 1}


def test_corpus_diagnostics_ignores_in_context_citations():
    corpus = {("g", "1")}
    cit = Citation(gost_id="g", clause_path="1", quote="q")
    r = _result(citations=[cit], checks=[CitationCheck(citation=cit, in_context=True, quote_found=True)])
    assert corpus_citation_diagnostics(r, corpus) == {"retrieval_miss": 0, "fabricated": 0}


def test_corpus_diagnostics_no_validation_returns_zeros():
    # validation absent ⇒ we can't know in-context ⇒ must NOT report a wall of fabrications
    r = Result(
        query="q", strategy="rag", model="m",
        answer=Answer(text="x", citations=[Citation(gost_id="g", clause_path="9.9")]),
        validation=None, usage=Usage(), contexts=[],
    )
    assert corpus_citation_diagnostics(r, {("g", "1")}) == {"retrieval_miss": 0, "fabricated": 0}


def test_empty_clause_path_ref_matches_between_gold_and_context():
    # preamble clause (empty clause_path): expected ref and a RAG-style Chunk.ref must agree,
    # else a correct answer is mis-scored as a false positive
    from gost_rag.schema import clause_ref
    r = _result(contexts=[clause_ref("ГОСТ X", "")], valid_ok=True)
    o = outcome(r, _gold(expected=[{"gost_id": "ГОСТ X", "clause_path": ""}]))
    assert o["recall"] == 1.0 and o["correct"] and not o["false_positive"]

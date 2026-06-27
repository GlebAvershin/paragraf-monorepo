"""Unit tests for the benchmark scoring/stats — pure, no network."""

from __future__ import annotations

from gost_rag.evalmetrics import (
    aggregate,
    bootstrap_ci,
    corpus_citation_diagnostics,
    cost_per_correct,
    cost_usd,
    cost_usd_by_model,
    discrimination,
    negative_specificity,
    outcome,
    paired_bootstrap,
    positive_coverage,
    precision_of,
    risk_coverage,
    select_operating_point,
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


# ---- document-level recall (real gold granularity) + material coverage ----

def test_recall_document_level_matches_any_clause_of_doc():
    from gost_rag.evalmetrics import recall_fraction
    # gold lists DOCUMENTS (no clause_path); any retrieved clause of that doc counts as recalled
    r = _result(contexts=["ГОСТ 34028-2016, п. 5.2", "СП 63.13330.2018, п. 1"])
    assert recall_fraction(r, [{"gost_id": "ГОСТ 34028-2016"}, {"gost_id": "СП 63.13330.2018"}]) == 1.0
    assert recall_fraction(r, [{"gost_id": "ГОСТ 34028-2016"}, {"gost_id": "ГОСТ 15150-69"}]) == 0.5
    # a clause-level expected still requires the exact (gost, п.) ref
    assert recall_fraction(r, [{"gost_id": "ГОСТ 34028-2016", "clause_path": "9.9"}]) == 0.0


def test_citation_clause_path_strips_p_prefix():
    from gost_rag.schema import Citation
    # models echo "п. 6.2.5" / "пункт 5.1"; must normalize to the bare path the chunks store
    assert Citation(gost_id="g", clause_path="п. 6.2.5").clause_path == "6.2.5"
    assert Citation(gost_id="g", clause_path="пункт 5.1").clause_path == "5.1"
    assert Citation(gost_id="g", clause_path="п.4.4").clause_path == "4.4"
    assert Citation(gost_id="g", clause_path="п. п. 6.2.5").clause_path == "6.2.5"
    assert Citation(gost_id="g", clause_path="6.2.5").clause_path == "6.2.5"   # already bare
    assert Citation(gost_id="g", clause_path="§3").clause_path == "§3"          # window path untouched
    assert Citation(gost_id="g", clause_path="приложение А").clause_path == "приложение А"  # no false strip


def test_material_coverage_homoglyph_and_none():
    from gost_rag.evalmetrics import material_coverage
    from gost_rag.schema import Answer, Result, Usage

    def res(text):
        return Result(query="q", strategy="s", model="m", answer=Answer(text=text), usage=Usage(), contexts=[])

    # gold tokens are Cyrillic "А500С"/"А400"; a model may emit Latin-lookalikes "A500C"/"A400"
    assert material_coverage(res("Рекомендуется A500C и A400"), {"materials": ["А500С", "А400"]}) == 1.0
    assert material_coverage(res("только А500С"), {"materials": ["А500С", "А400"]}) == 0.5
    assert material_coverage(res("любой"), {"materials": []}) is None
    assert material_coverage(res("любой"), {}) is None


# ---- per-model cost (mixed-model runs) ----

def test_cost_usd_by_model_sums_per_price_and_none_on_missing():
    prices = {"gen": {"in": 1.0, "out": 2.0}, "judge": {"in": 0.5, "out": 0.5}}
    by_model = {"gen": [1_000_000, 1_000_000, 1], "judge": [2_000_000, 0, 1]}
    assert cost_usd_by_model(by_model, prices) == 3.0 + 1.0  # gen 3.0 + judge 1.0
    # any used model without a price ⇒ None (don't understate cost)
    assert cost_usd_by_model({"gen": [10, 10, 1], "x": [10, 10, 1]}, prices) is None
    assert cost_usd_by_model({}, prices) is None


def test_usage_add_attributes_tokens_per_model():
    from gost_rag.schema import Usage
    u = Usage()
    u.add(10, 5, "gen")
    u.add(3, 2, "gen")
    u.add(7, 1, "judge")
    assert u.by_model == {"gen": [13, 7, 2], "judge": [7, 1, 1]}
    assert u.prompt_tokens == 20 and u.completion_tokens == 8 and u.model_calls == 3


# ---- selective-prediction coverage axes ----

def _rows(*specs):
    """specs: (expects, emitted, correct[, extra dict]) → row dicts."""
    out = []
    for s in specs:
        expects, emitted, correct = s[0], s[1], s[2]
        row = {"expects": expects, "emitted": emitted, "correct": correct,
               "false_positive": emitted and not correct and expects, "gate_passed": True}
        if len(s) > 3:
            row.update(s[3])
        out.append(row)
    return out


def test_positive_coverage_and_negative_specificity_split_negatives_out():
    rows = _rows(
        (True, True, True), (True, True, False), (True, False, False),  # 2/3 positives emitted
        (False, False, False), (False, True, False),                     # 1/2 negatives abstained
    )
    assert positive_coverage(rows) == 2 / 3
    assert negative_specificity(rows) == 1 / 2


def test_cost_per_correct():
    rows = _rows(
        (True, True, True, {"cost": 0.02}),
        (True, True, False, {"cost": 0.02}),
        (True, False, False, {"cost": 0.01}),
    )
    assert abs(cost_per_correct(rows) - 0.05 / 1) < 1e-9   # total 0.05 / 1 correct
    assert cost_per_correct(_rows((True, True, False, {"cost": 0.02}))) is None  # zero correct → None


# ---- risk-coverage sweep + operating point (offline, one run) ----

def test_risk_coverage_and_operating_point():
    # 4 positives, all gate-passed & emitted; faith separates correct (high) from wrong (low)
    rows = _rows(
        (True, True, True, {"faith": 0.9}),
        (True, True, True, {"faith": 0.8}),
        (True, True, False, {"faith": 0.4}),
        (True, True, False, {"faith": 0.3}),
    )
    pts = risk_coverage(rows, "faith")
    # at threshold 0 everything emits → coverage 1.0, precision 0.5
    assert (0.0, 1.0, 0.5) in [(round(t, 3), round(c, 3), round(p, 3)) for t, c, p in pts]
    # raising the bar to 0.8 keeps only the two correct → coverage 0.5, precision 1.0
    op = select_operating_point(rows, "faith", prec_floor=0.9, cov_floor=0.5)
    assert op is not None and round(op[1], 3) == 0.5 and op[2] == 1.0
    # an unreachable bar returns None
    assert select_operating_point(rows, "faith", prec_floor=0.99, cov_floor=0.9) is None


def test_discrimination_auc_separates_and_ties():
    rows = _rows(
        (True, True, True, {"faith": 0.9}), (True, True, True, {"faith": 0.8}),
        (True, True, False, {"faith": 0.2}), (True, True, False, {"faith": 0.1}),
    )
    assert discrimination(rows, "faith") == 1.0          # perfectly separates correct from wrong
    flat = _rows((True, True, True, {"faith": 0.5}), (True, True, False, {"faith": 0.5}))
    assert discrimination(flat, "faith") == 0.5          # no signal → 0.5
    assert discrimination(_rows((True, True, True, {"faith": 0.5})), "faith") is None  # one class empty


def test_paired_bootstrap_ci_detects_and_excludes_zero():
    # b strictly better than a on every question → positive paired delta, CI excludes 0
    a = _rows(*[(True, True, False)] * 12)
    b = _rows(*[(True, True, True)] * 12)
    lo, hi = paired_bootstrap(a, b, precision_of, iters=400, seed=1)
    assert lo > 0.0 and hi >= lo
    # identical configs → delta CI straddles 0
    lo2, hi2 = paired_bootstrap(a, a, precision_of, iters=400, seed=1)
    assert lo2 == 0.0 and hi2 == 0.0


# ---- stricter multihop correctness ----

def test_multihop_requires_full_document_recall():
    # retrieved 1 of 2 expected docs, validation OK
    r = _result(contexts=["ГОСТ A, п. 1"], valid_ok=True)
    expected = [{"gost_id": "ГОСТ A"}, {"gost_id": "ГОСТ B"}]
    mh = outcome(r, {"expects_answer": True, "expected": expected, "type": "multihop"})
    assert mh["recall"] == 0.5 and not mh["correct"] and mh["false_positive"]  # 1/2 ⇒ not correct
    rec = outcome(r, {"expects_answer": True, "expected": expected, "type": "recommendation"})
    assert rec["correct"]  # non-multihop: any expected doc retrieved ⇒ correct

"""Unit tests for the multi-agent decision cores (Stream C) — pure, no LLM/network."""

from __future__ import annotations

from gost_rag.agentlogic import (
    as_bool_vote,
    as_model_list,
    citation_keys,
    decide_emission,
    deterministic_gate,
    merge_citations,
    normalize_consensus,
    reconcile_models,
    select_cited_context,
    select_consensus_candidate,
)
from gost_rag.llm import num
from gost_rag.schema import Answer, Citation, CitationCheck, parse_citations


def _check(g, c, in_ctx=True, found=True):
    return CitationCheck(citation=Citation(gost_id=g, clause_path=c), in_context=in_ctx, quote_found=found)


# ---- utilities ----

def test_as_model_list_forms():
    assert as_model_list(None) == []
    assert as_model_list(["a", " b "]) == ["a", "b"]
    assert as_model_list("a, b ,c") == ["a", "b", "c"]


def test_citation_keys_signature():
    a = Answer(text="x", citations=[Citation(gost_id="g", clause_path="5.1"), Citation(gost_id="g", clause_path="6.4")])
    assert citation_keys(a) == frozenset({("g", "5.1"), ("g", "6.4")})


# ---- deterministic gate ----

def test_gate_passes_only_when_all_citations_in_context_and_quoted():
    assert deterministic_gate([_check("g", "1")], has_citation=True) is True
    assert deterministic_gate([_check("g", "1", found=False)], has_citation=True) is False
    assert deterministic_gate([_check("g", "1", in_ctx=False)], has_citation=True) is False
    assert deterministic_gate([], has_citation=False) is False  # no citations → no emit


# ---- consensus normalization ----

def test_normalize_consensus():
    assert normalize_consensus("unanimous", 3) == 3
    assert normalize_consensus("majority", 3) == 2
    assert normalize_consensus("2", 3) == 2
    assert normalize_consensus(5, 3) == 3            # clamped to n
    assert normalize_consensus("garbage", 3) == 3    # unknown → safest (all)


# ---- emission decision ----

def test_decide_emission_truth_table():
    assert decide_emission(False, True, [True, True, True], 3) is True          # unanimous approve
    assert decide_emission(False, True, [True, False, True], 3) is False        # one reject, unanimous req
    assert decide_emission(False, True, [True, False, True], 2) is True         # majority req met
    assert decide_emission(False, False, [True, True, True], 3) is False        # gate failed
    assert decide_emission(True, True, [True, True, True], 3) is False          # generator abstained


# ---- cited-only context ----

def test_select_cited_context_intersects():
    full = {("g", "1"): "t1", ("g", "2"): "t2", ("g", "3"): "t3"}
    cits = [Citation(gost_id="g", clause_path="2")]
    assert select_cited_context(cits, full) == {("g", "2"): "t2"}


# ---- self-consistency selection ----

def test_select_consensus_candidate_majority_cluster():
    sig_a, sig_b = frozenset({("g", "1")}), frozenset({("g", "2")})
    scored = [
        {"answer": "a1", "signature": sig_a, "valid": True, "faith": 0.6},
        {"answer": "a2", "signature": sig_a, "valid": True, "faith": 0.9},
        {"answer": "b1", "signature": sig_b, "valid": True, "faith": 1.0},
    ]
    w = select_consensus_candidate(scored)
    assert w["signature"] == sig_a and w["faith"] == 0.9  # majority cluster, best faith within it


def test_select_consensus_none_when_no_valid():
    assert select_consensus_candidate([{"signature": frozenset(), "valid": False}]) is None


# ---- model ensemble reconciliation ----

def test_reconcile_models_requires_min_agreement():
    sig = frozenset({("g", "1")})
    scored = [
        {"model": "m1", "signature": sig, "valid": True, "faith": 0.5},
        {"model": "m2", "signature": sig, "valid": True, "faith": 0.8},
        {"model": "m3", "signature": frozenset({("g", "9")}), "valid": True, "faith": 1.0},
    ]
    assert reconcile_models(scored, min_agreement=2)["faith"] == 0.8   # 2 agree on sig
    assert reconcile_models(scored, min_agreement=3) is None           # no 3-way agreement


# ---- citation merge ----

def test_merge_citations_dedupes_preserving_order():
    a = Citation(gost_id="g", clause_path="1", quote="q")
    b = Citation(gost_id="g", clause_path="2", quote="r")
    assert merge_citations([a, a, b]) == [a, b]


# ---- defensive coercion (review fixes) ----

def test_num_coerces_or_defaults():
    assert num("0.7") == 0.7
    assert num(0.5) == 0.5
    assert num("high") == 0.0        # non-numeric → default, not a crash
    assert num(None, 1.0) == 1.0


def test_parse_citations_drops_malformed():
    cits = parse_citations([
        {"gost_id": "g", "clause_path": "1", "quote": "q"},  # ok
        {"clause_path": "2"},                                 # missing gost_id → dropped, not a crash
        "not a dict",                                         # dropped
    ])
    assert len(cits) == 1 and cits[0].gost_id == "g"


def test_as_bool_vote_strict():
    assert as_bool_vote(True) is True
    assert as_bool_vote("true") is True
    assert as_bool_vote("да") is True
    assert as_bool_vote(1) is True
    assert as_bool_vote("false") is False   # bug guard: plain bool("false") would be True
    assert as_bool_vote(False) is False
    assert as_bool_vote(0) is False
    assert as_bool_vote("maybe") is False


def test_consensus_threshold_blocks_size1_majority():
    # 3 valid candidates, all distinct signatures → 'majority' cluster size 1 → abstain at min_agreement=2
    scored = [{"signature": frozenset({("g", str(i))}), "valid": True, "faith": 1.0} for i in range(3)]
    assert select_consensus_candidate(scored, min_agreement=2) is None
    assert select_consensus_candidate(scored, min_agreement=1) is not None

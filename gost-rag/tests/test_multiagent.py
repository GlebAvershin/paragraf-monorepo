"""Integration tests for the verification-ensemble strategy (C1) with stubbed LLM/Store —
proves the orchestration (emit on consensus, abstain on any reject, free gate short-circuits panel)
without any network."""

from __future__ import annotations

from gost_rag.multiagent import (
    ModelEnsembleStrategy,
    SelfConsistencyStrategy,
    VerifyEnsembleStrategy,
)
from gost_rag.schema import Chunk, RetrievedChunk

CHUNK = Chunk(
    id="i", gost_id="ГОСТ Р 7.0.97-2016", clause_path="5.1", title="",
    text="При оформлении документов устанавливают размеры полей: левое — 20 мм, правое — 10 мм.",
)
ANSWER = ('{"answer":"Левое поле 20 мм.","citations":[{"gost_id":"ГОСТ Р 7.0.97-2016",'
          '"clause_path":"5.1","quote":"левое — 20 мм"}],"confidence":0.9,"abstained":false}')
APPROVE = '{"approve": true, "score": 1.0, "issues": []}'
REJECT = '{"approve": false, "score": 0.2, "issues": ["переобобщение"]}'


class FakeStore:
    def __init__(self, chunks):
        self._chunks = chunks

    def search(self, query, top_k=8, industry=None):
        return [RetrievedChunk(chunk=c, score=1.0) for c in self._chunks][:top_k]


class FakeLLM:
    """SYSTEM_GOST → answer JSON; verifier lens prompts (contain 'approve') → next queued vote."""

    def __init__(self, answer_json, votes):
        self._answer = answer_json
        self._votes = list(votes)

    def chat(self, model, system, user, usage, temperature=0.0):
        usage.add(1, 1)
        if "approve" in system:
            return self._votes.pop(0)  # IndexError if the panel runs when it shouldn't
        return self._answer


def test_verify_ensemble_emits_on_unanimous_approval():
    s = VerifyEnsembleStrategy(FakeLLM(ANSWER, [APPROVE, APPROVE, APPROVE]), FakeStore([CHUNK]), "gen", "judge")
    r = s.answer("Какие поля?")
    assert not r.answer.abstained
    assert r.validation.ok
    assert r.answer.citations


def test_verify_ensemble_abstains_when_one_verifier_rejects():
    s = VerifyEnsembleStrategy(FakeLLM(ANSWER, [APPROVE, REJECT, APPROVE]), FakeStore([CHUNK]), "gen", "judge")
    r = s.answer("Какие поля?")
    assert r.answer.abstained
    assert not r.validation.ok
    assert any("citation_exactness" in i for i in r.validation.issues)


def test_verify_ensemble_gate_failure_short_circuits_panel():
    # answer cites a clause NOT in the retrieved context → free gate fails → panel never runs
    bad = ('{"answer":"x","citations":[{"gost_id":"ГОСТ X","clause_path":"9.9","quote":"нет"}],'
           '"confidence":0.9,"abstained":false}')
    s = VerifyEnsembleStrategy(FakeLLM(bad, []), FakeStore([CHUNK]), "gen", "judge")  # no votes queued
    r = s.answer("?")
    assert r.answer.abstained
    assert not r.validation.ok


class GenJudgeLLM:
    """SYSTEM_GOST → answer; JUDGE_FAITHFULNESS (contains 'faithfulness') → judge verdict."""

    def __init__(self, answer_json, judge_json):
        self._answer = answer_json
        self._judge = judge_json

    def chat(self, model, system, user, usage, temperature=0.0):
        usage.add(1, 1)
        return self._judge if "faithfulness" in system else self._answer


def test_self_consistency_abstains_when_judge_rejects():
    # candidates agree (valid majority) but the faithfulness judge rejects → MUST abstain, not emit
    llm = GenJudgeLLM(ANSWER, '{"faithfulness": 0.2, "issues": ["переобобщение"]}')
    s = SelfConsistencyStrategy(llm, FakeStore([CHUNK]), "gen", "judge", k_candidates=2, min_agreement=2)
    r = s.answer("Какие поля?")
    assert r.answer.abstained
    assert not r.validation.ok


def test_model_ensemble_single_model_can_emit():
    # default models=None → [gen_model]; min_agreement clamps to 1 so a 1-model ensemble still emits
    llm = GenJudgeLLM(ANSWER, '{"faithfulness": 1.0, "issues": []}')
    s = ModelEnsembleStrategy(llm, FakeStore([CHUNK]), "gen", "judge")  # min_agreement default 2 → clamp 1
    r = s.answer("Какие поля?")
    assert not r.answer.abstained
    assert r.validation.ok

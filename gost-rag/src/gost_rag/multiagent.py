"""Multi-agent answer strategies (Stream C) — branch-per-variant experiments, all behind the
same Strategy interface so the benchmark compares them identically to RAG / RLM.

- VerifyEnsembleStrategy (C1): RAG candidate -> free deterministic gate -> N-lens verifier panel
  (verifiers see CITED-ONLY context) -> emit only on consensus, else abstain. Direct precision lever.
- DecomposeStrategy      (C2): planner -> per-subquestion RAG -> aggregator (citations preserved).
- SelfConsistencyStrategy(C3): K sampled candidates -> majority citation-signature cluster -> validate.
- ModelEnsembleStrategy  (C4): same context through M models -> reconcile by agreement -> validate.

All reuse generate_answer / Store.search / check_citations / validate; the decision cores live in
agentlogic (pure, unit-tested). Cost = extra model calls; tracked in Usage like everything else.
"""

from __future__ import annotations

from .agentlogic import (
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
from .generate import generate_answer
from .llm import LLM, num, parse_json
from .prompts import AGGREGATOR, PLANNER, VERIFIER_LENSES
from .schema import Answer, Chunk, Citation, Result, Usage, ValidationReport, parse_citations
from .store import Store
from .validate import check_citations, validate


def _ctx_by_ref(chunks: list[Chunk]) -> dict[tuple[str, str], str]:
    return {(c.gost_id, c.clause_path): c.text for c in chunks}


def _format_ctx(ctx: dict[tuple[str, str], str]) -> str:
    return "\n\n".join(f"[{g} | п. {c}]\n{t}" for (g, c), t in ctx.items())


def _dedupe_chunks(chunks: list[Chunk]) -> list[Chunk]:
    seen: set[tuple[str, str]] = set()
    out: list[Chunk] = []
    for c in chunks:
        key = (c.gost_id, c.clause_path)
        if key not in seen:
            seen.add(key)
            out.append(c)
    return out


def _cited_str(citations: list[Citation]) -> str:
    return "; ".join(f"{c.gost_id} п.{c.clause_path}: «{c.quote}»" for c in citations)


def _abstain(text: str, issues: list[str]) -> tuple[Answer, ValidationReport]:
    return Answer(text=text, abstained=True), ValidationReport(ok=False, faithfulness=0.0, issues=issues)


def _mk(name: str, model: str, query: str, answer: Answer, report: ValidationReport,
        usage: Usage, contexts: list[str]) -> Result:
    return Result(query=query, strategy=name, model=model, answer=answer,
                  validation=report, usage=usage, contexts=contexts)


# ───────────────────────────── C1: verification ensemble ─────────────────────────────

class VerifyEnsembleStrategy:
    name = "verify_ensemble"

    def __init__(self, llm: LLM, store: Store, gen_model: str, judge_model: str,
                 top_k: int = 8, verifier_models=None, consensus="unanimous"):
        self._llm, self._store = llm, store
        self._gen_model, self._judge_model = gen_model, judge_model
        self._top_k = top_k
        self._verifier_models = as_model_list(verifier_models) or [judge_model]
        self._consensus = consensus

    def answer(self, query: str, industry: str | None = None) -> Result:
        usage = Usage()
        hits = self._store.search(query, top_k=self._top_k, industry=industry)
        used = [h.chunk for h in hits]
        full_ctx = _ctx_by_ref(used)
        contexts = [c.ref for c in used]
        candidate = generate_answer(self._llm, self._gen_model, query, hits, usage)

        if candidate.abstained:
            ans, rep = _abstain(candidate.text or "Нет данных в документах.", ["генератор воздержался"])
            return _mk(self.name, self._gen_model, query, ans, rep, usage, contexts)

        checks = check_citations(candidate, full_ctx)
        gate = deterministic_gate(checks, bool(candidate.citations))

        votes: list[dict] = []
        if gate:  # free gate short-circuits the panel on the dominant failure (bad citations)
            cited_text = _format_ctx(select_cited_context(candidate.citations, full_ctx))
            for i, (lens, prompt) in enumerate(VERIFIER_LENSES):
                model = self._verifier_models[i % len(self._verifier_models)]
                votes.append(self._vote(lens, model, prompt, query, candidate, cited_text, usage))

        min_app = normalize_consensus(self._consensus, len(VERIFIER_LENSES))
        emit = decide_emission(False, gate, [v["approve"] for v in votes], min_app)

        issues = [] if gate else ["цитаты не прошли детерминированный гейт"]
        issues += [f"{v['lens']}: {'; '.join(v['issues'])}" for v in votes if not v["approve"]]
        faith = min((v["score"] for v in votes), default=0.0)
        report = ValidationReport(ok=emit, faithfulness=faith, citation_checks=checks, issues=issues)
        answer = candidate if emit else candidate.model_copy(update={"abstained": True})
        return _mk(self.name, self._gen_model, query, answer, report, usage, contexts)

    def _vote(self, lens: str, model: str, prompt: str, query: str, candidate: Answer,
              cited_text: str, usage: Usage) -> dict:
        user = (f"ВОПРОС: {query}\n\nЦИТИРУЕМЫЕ ПУНКТЫ:\n{cited_text}\n\n"
                f"ОТВЕТ:\n{candidate.text}\n\nЦИТАТЫ: {_cited_str(candidate.citations)}")
        data = parse_json(self._llm.chat(model=model, system=prompt, user=user, usage=usage))
        # missing / unparseable / non-true 'approve' counts as REJECT (conservative; bool("false") is True!)
        return {"lens": lens, "approve": as_bool_vote(data.get("approve", False)),
                "score": num(data.get("score")), "issues": list(data.get("issues", []))}


# ───────────────────────────── C2: decomposition / orchestration ─────────────────────────────

class DecomposeStrategy:
    name = "decompose"

    def __init__(self, llm: LLM, store: Store, gen_model: str, judge_model: str,
                 top_k: int = 6, max_subq: int = 4):
        self._llm, self._store = llm, store
        self._gen_model, self._judge_model = gen_model, judge_model
        self._top_k, self._max_subq = top_k, max_subq

    def answer(self, query: str, industry: str | None = None) -> Result:
        usage = Usage()
        subqs = self._plan(query, usage)[: self._max_subq] or [query]
        chunks_all: list[Chunk] = []
        sub_blocks: list[tuple[str, Answer]] = []
        for sq in subqs:
            hits = self._store.search(sq, top_k=self._top_k, industry=industry)
            sub = generate_answer(self._llm, self._gen_model, sq, hits, usage)
            chunks_all += [h.chunk for h in hits]
            if not sub.abstained and sub.citations:
                sub_blocks.append((sq, sub))

        used = _dedupe_chunks(chunks_all)
        full_ctx = _ctx_by_ref(used)
        contexts = [c.ref for c in used]
        if not sub_blocks:
            ans, rep = _abstain("В доступных документах нет данных для ответа.",
                                ["ни один под-вопрос не дал обоснованного ответа"])
            return _mk(self.name, self._gen_model, query, ans, rep, usage, contexts)

        final = self._aggregate(query, sub_blocks, usage)
        report = validate(self._llm, self._judge_model, query, final, full_ctx, _format_ctx(full_ctx), usage)
        if not report.ok:  # judge rejected → abstain, never emit a confidently-wrong answer
            final = final.model_copy(update={"abstained": True})
        return _mk(self.name, self._gen_model, query, final, report, usage, contexts)

    def _plan(self, query: str, usage: Usage) -> list[str]:
        data = parse_json(self._llm.chat(
            model=self._gen_model, system=PLANNER, usage=usage,
            user=f"ВОПРОС: {query}\nРазбей на под-вопросы (строго JSON).",
        ))
        return [str(s).strip() for s in data.get("sub_questions", []) if str(s).strip()]

    def _aggregate(self, query: str, sub_blocks: list[tuple[str, Answer]], usage: Usage) -> Answer:
        joined = "\n\n".join(
            f"ПОД-ВОПРОС: {sq}\nОТВЕТ: {sub.text}\nЦИТАТЫ: {_cited_str(sub.citations)}"
            for sq, sub in sub_blocks
        )
        data = parse_json(self._llm.chat(
            model=self._gen_model, system=AGGREGATOR, usage=usage,
            user=f"ВОПРОС: {query}\n\nЧАСТИЧНЫЕ ОТВЕТЫ:\n{joined}",
        ))
        all_cits = merge_citations([c for _, sub in sub_blocks for c in sub.citations])
        if not data:  # aggregator unparseable → safe fallback: concatenate + union citations
            return Answer(text=" ".join(sub.text for _, sub in sub_blocks),
                          citations=all_cits, confidence=0.5, abstained=False)
        cits = merge_citations(parse_citations(data.get("citations", [])))
        return Answer(text=str(data.get("answer", "")), citations=cits or all_cits,
                      confidence=num(data.get("confidence")),
                      abstained=bool(data.get("abstained", False)))


# ───────────────────────────── C3: self-consistency / debate ─────────────────────────────

class SelfConsistencyStrategy:
    name = "self_consistency"

    def __init__(self, llm: LLM, store: Store, gen_model: str, judge_model: str,
                 top_k: int = 8, k_candidates: int = 3, temperature: float = 0.7, min_agreement: int = 2):
        self._llm, self._store = llm, store
        self._gen_model, self._judge_model = gen_model, judge_model
        self._top_k, self._k, self._temperature = top_k, k_candidates, temperature
        self._min_agreement = max(1, min(min_agreement, k_candidates))  # need real agreement, not a size-1 "majority"

    def answer(self, query: str, industry: str | None = None) -> Result:
        usage = Usage()
        hits = self._store.search(query, top_k=self._top_k, industry=industry)
        used = [h.chunk for h in hits]
        full_ctx = _ctx_by_ref(used)
        contexts = [c.ref for c in used]

        scored: list[dict] = []
        for _ in range(self._k):
            cand = generate_answer(self._llm, self._gen_model, query, hits, usage, temperature=self._temperature)
            checks = check_citations(cand, full_ctx)
            valid = (not cand.abstained) and deterministic_gate(checks, bool(cand.citations))
            scored.append({"answer": cand, "signature": citation_keys(cand), "valid": valid, "faith": 0.0})

        winner = select_consensus_candidate(scored, self._min_agreement)
        if winner is None:
            ans, rep = _abstain("Кандидаты не сошлись на обоснованном ответе.",
                                ["self-consistency: нет валидного консенсуса"])
            return _mk(self.name, self._gen_model, query, ans, rep, usage, contexts)
        final = winner["answer"]
        report = validate(self._llm, self._judge_model, query, final, full_ctx, _format_ctx(full_ctx), usage)
        if not report.ok:
            final = final.model_copy(update={"abstained": True})
        return _mk(self.name, self._gen_model, query, final, report, usage, contexts)


# ───────────────────────────── C4: model ensemble ─────────────────────────────

class ModelEnsembleStrategy:
    name = "model_ensemble"

    def __init__(self, llm: LLM, store: Store, gen_model: str, judge_model: str,
                 top_k: int = 8, models=None, min_agreement: int = 2):
        self._llm, self._store = llm, store
        self._gen_model, self._judge_model = gen_model, judge_model
        self._top_k = top_k
        self._models = as_model_list(models) or [gen_model]
        # clamp so a single-model ensemble (no `models` opt) can still emit instead of always abstaining
        self._min_agreement = max(1, min(min_agreement, len(self._models)))

    def answer(self, query: str, industry: str | None = None) -> Result:
        usage = Usage()
        hits = self._store.search(query, top_k=self._top_k, industry=industry)
        used = [h.chunk for h in hits]
        full_ctx = _ctx_by_ref(used)
        contexts = [c.ref for c in used]

        scored: list[dict] = []
        for m in self._models:
            cand = generate_answer(self._llm, m, query, hits, usage)
            checks = check_citations(cand, full_ctx)
            valid = (not cand.abstained) and deterministic_gate(checks, bool(cand.citations))
            scored.append({"model": m, "answer": cand, "signature": citation_keys(cand), "valid": valid, "faith": 0.0})

        winner = reconcile_models(scored, self._min_agreement)
        if winner is None:
            ans, rep = _abstain("Модели не пришли к согласию.", ["model-ensemble: нет согласия моделей"])
            return _mk(self.name, "ensemble", query, ans, rep, usage, contexts)
        final = winner["answer"]
        report = validate(self._llm, self._judge_model, query, final, full_ctx, _format_ctx(full_ctx), usage)
        if not report.ok:
            final = final.model_copy(update={"abstained": True})
        return _mk(self.name, f"ensemble:{winner['model']}", query, final, report, usage, contexts)

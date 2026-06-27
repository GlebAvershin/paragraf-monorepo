"""Validation layer — the guardrail that runs BEFORE an answer reaches the user.

Two independent checks, deliberately not both LLM-based:
1. Deterministic citation check: the cited (gost, clause) must be in the context
   actually used, and the quoted span must fuzzy-match that clause's text.
2. LLM-judge faithfulness: does the answer follow from the context (groundedness)?

If a citation is fabricated or faithfulness is below threshold, ok=False and the
caller abstains. Cheap to run, catches the failure mode that matters here.
"""

from __future__ import annotations

from rapidfuzz import fuzz

from .llm import LLM, num, parse_json
from .prompts import JUDGE_FAITHFULNESS
from .schema import Answer, CitationCheck, Usage, ValidationReport

QUOTE_MATCH_THRESHOLD = 80.0   # rapidfuzz partial_ratio (0..100)
FAITHFULNESS_THRESHOLD = 0.5


def check_citations(answer: Answer, context_by_ref: dict[tuple[str, str], str],
                    quote_threshold: float = QUOTE_MATCH_THRESHOLD) -> list[CitationCheck]:
    checks: list[CitationCheck] = []
    for cit in answer.citations:
        key = (cit.gost_id, cit.clause_path)
        source = context_by_ref.get(key)
        in_context = source is not None
        score = fuzz.partial_ratio(cit.quote, source) if (in_context and cit.quote) else 0.0
        checks.append(
            CitationCheck(
                citation=cit,
                in_context=in_context,
                quote_found=score >= quote_threshold,
                match_score=round(score, 1),
            )
        )
    return checks


def judge_faithfulness(llm: LLM, model: str, query: str, answer: Answer, context: str, usage: Usage) -> tuple[float, list[str]]:
    user = f"ВОПРОС: {query}\n\nCONTEXT:\n{context}\n\nОТВЕТ:\n{answer.text}"
    data = parse_json(llm.chat(model=model, system=JUDGE_FAITHFULNESS, user=user, usage=usage))
    return num(data.get("faithfulness")), list(data.get("issues", []))


def validate(
    llm: LLM,
    judge_model: str,
    query: str,
    answer: Answer,
    context_by_ref: dict[tuple[str, str], str],
    context_text: str,
    usage: Usage,
    faith_threshold: float = FAITHFULNESS_THRESHOLD,
    quote_threshold: float = QUOTE_MATCH_THRESHOLD,
) -> ValidationReport:
    issues: list[str] = []
    checks = check_citations(answer, context_by_ref, quote_threshold)

    if not answer.abstained and not answer.citations:
        issues.append("ответ без единой ссылки на пункт ГОСТа")
    for ch in checks:
        if not ch.in_context:
            issues.append(f"цитируется отсутствующий в контексте пункт: {ch.citation.gost_id} п.{ch.citation.clause_path}")
        elif not ch.quote_found:
            issues.append(f"цитата не найдена в тексте пункта (match={ch.match_score}): {ch.citation.gost_id} п.{ch.citation.clause_path}")

    faithfulness, judge_issues = judge_faithfulness(llm, judge_model, query, answer, context_text, usage)
    issues.extend(judge_issues)

    ok = answer.abstained or (
        not any(not c.in_context or not c.quote_found for c in checks)
        and bool(answer.citations)
        and faithfulness >= faith_threshold
    )
    return ValidationReport(ok=ok, faithfulness=faithfulness, citation_checks=checks, issues=issues)

"""Pure decision logic for the multi-agent strategies (Stream C) — no LLM/IO, unit-testable.

Each architecture's voting / selection / merge core lives here so it can be tested with stubbed
inputs; multiagent.py only does the LLM orchestration around these functions.
"""

from __future__ import annotations

from collections import Counter

from .schema import Answer, Citation, CitationCheck


def as_model_list(value) -> list[str]:
    """Normalize a YAML list / comma-string / None into a list of model ids ([] if empty)."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v).strip()]
    return [s.strip() for s in str(value).split(",") if s.strip()]


def as_bool_vote(value) -> bool:
    """Strict approve coercion. A model may return "approve": "false" — bool("false") is True,
    so for a precision-critical verifier vote ONLY explicit truthy values count as approval."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in {"true", "yes", "да", "1"}


def citation_keys(answer: Answer) -> frozenset[tuple[str, str]]:
    """The set of (gost_id, clause_path) an answer cites — its 'signature' for clustering."""
    return frozenset((c.gost_id, c.clause_path) for c in answer.citations)


def deterministic_gate(checks: list[CitationCheck], has_citation: bool) -> bool:
    """Free hard gate: >=1 citation AND every cited clause in-context with a verbatim quote."""
    return has_citation and bool(checks) and all(c.in_context and c.quote_found for c in checks)


def normalize_consensus(consensus, n: int) -> int:
    """Map a consensus spec to a minimum-approvals integer in [1, n]."""
    if isinstance(consensus, bool):  # guard: bool is an int subclass
        consensus = "unanimous" if consensus else "majority"
    if isinstance(consensus, int):
        return max(1, min(consensus, n))
    s = str(consensus).strip().lower()
    if s == "unanimous":
        return n
    if s == "majority":
        return n // 2 + 1
    if s.isdigit():
        return max(1, min(int(s), n))
    return n  # unknown spec → safest (require all)


def decide_emission(generator_abstained: bool, gate_passed: bool,
                    approvals: list[bool], min_approvals: int) -> bool:
    """Emit iff generator didn't abstain, the deterministic gate passed, and approvals suffice."""
    return (not generator_abstained) and gate_passed and sum(1 for a in approvals if a) >= min_approvals


def select_cited_context(citations: list[Citation],
                         full_ctx: dict[tuple[str, str], str]) -> dict[tuple[str, str], str]:
    """Keep only the context clauses the answer actually cited (verifiers judge cited-only,
    so they can't inherit the generator's over-broad retrieval window)."""
    keys = {(c.gost_id, c.clause_path) for c in citations}
    return {k: v for k, v in full_ctx.items() if k in keys}


def select_consensus_candidate(scored: list[dict], min_agreement: int = 1) -> dict | None:
    """Self-consistency (C3): among VALID candidates, take the majority citation-signature
    cluster IF it has >= min_agreement members, then the highest faith within it. None otherwise —
    so K disagreeing candidates (a size-1 'majority') abstain instead of emitting an arbitrary one."""
    valid = [c for c in scored if c.get("valid")]
    if not valid:
        return None
    top_sig, n = Counter(c["signature"] for c in valid).most_common(1)[0]
    if n < min_agreement:
        return None
    cluster = [c for c in valid if c["signature"] == top_sig]
    return max(cluster, key=lambda c: c.get("faith", 0.0))


def reconcile_models(scored: list[dict], min_agreement: int) -> dict | None:
    """Model ensemble (C4): require >= min_agreement VALID models sharing the majority
    citation-signature; pick the highest faith among them. None if no such agreement."""
    valid = [c for c in scored if c.get("valid")]
    if not valid:
        return None
    top_sig, n = Counter(c["signature"] for c in valid).most_common(1)[0]
    if n < min_agreement:
        return None
    cluster = [c for c in valid if c["signature"] == top_sig]
    return max(cluster, key=lambda c: c.get("faith", 0.0))


def merge_citations(citations: list[Citation]) -> list[Citation]:
    """Dedupe citations (by gost_id, clause_path, quote) preserving order — for C2 aggregation."""
    seen: set[tuple[str, str, str]] = set()
    out: list[Citation] = []
    for c in citations:
        key = (c.gost_id, c.clause_path, c.quote)
        if key not in seen:
            seen.add(key)
            out.append(c)
    return out

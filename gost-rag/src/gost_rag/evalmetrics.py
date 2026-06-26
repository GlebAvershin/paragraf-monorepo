"""Pure scoring & stats for the benchmark — no IO, unit-testable.

North-star framing (see plan): trust ≈ precision of EMITTED answers at near-zero
false-positives, traded against coverage and USD cost. These helpers turn a Result +
its gold entry into those signals; run_eval.py only orchestrates and renders.
"""

from __future__ import annotations

import random
from collections.abc import Callable

from .schema import Result, clause_ref


def cost_usd(prompt_tokens: int, completion_tokens: int, price: dict | None) -> float | None:
    """USD for one query from a {in, out} price (USD per 1M tokens). None if price unknown."""
    if not price:
        return None
    pin, pout = price.get("in"), price.get("out")
    if pin is None or pout is None:
        return None
    return prompt_tokens / 1_000_000 * pin + completion_tokens / 1_000_000 * pout


def _expected_refs(expected: list[dict]) -> set[str]:
    return {clause_ref(e["gost_id"], e["clause_path"]) for e in expected}


def recall_fraction(result: Result, expected: list[dict]) -> float:
    """Fraction of expected clauses that ended up in the context actually used (graded)."""
    exp = _expected_refs(expected)
    return len(exp & set(result.contexts)) / len(exp) if exp else 0.0


def outcome(result: Result, gold: dict) -> dict:
    """Per-question trust outcome. `expects_answer` defaults True; negatives set it False."""
    expects = gold.get("expects_answer", True)
    emitted = not result.answer.abstained
    rfrac = recall_fraction(result, gold.get("expected", []))
    valid_ok = bool(result.validation and result.validation.ok)

    checks = result.validation.citation_checks if result.validation else []
    good_cits = sum(1 for c in checks if c.in_context and c.quote_found)
    cit_acc = good_cits / len(checks) if checks else (1.0 if result.answer.abstained else 0.0)

    if expects:
        correct = emitted and rfrac > 0 and valid_ok
        false_positive = emitted and not correct
    else:  # negative question — the correct behaviour is to abstain
        correct = not emitted
        false_positive = emitted

    return {
        "expects": expects,
        "emitted": emitted,
        "correct": correct,
        "false_positive": false_positive,
        "recall": rfrac,
        "cit_acc": cit_acc,
        "faith": result.validation.faithfulness if result.validation else 0.0,
        "valid_ok": valid_ok,
        "tokens": result.usage.prompt_tokens + result.usage.completion_tokens,
        "latency": result.usage.latency_s,
    }


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def precision_of(rows: list[dict]) -> float:
    """Precision = fraction of EMITTED answers that are correct (the ≈100% target)."""
    emitted = [r for r in rows if r["emitted"]]
    return sum(1 for r in emitted if r["correct"]) / len(emitted) if emitted else 0.0


def fpr_of(rows: list[dict]) -> float:
    """False-positive rate = fraction of ALL questions answered confidently-wrong (→ ~0)."""
    return sum(1 for r in rows if r["false_positive"]) / len(rows) if rows else 0.0


def aggregate(rows: list[dict]) -> dict:
    """Aggregate per-question outcomes into the headline trust×cost metrics.

    `precision` and `cost` are None when undefined (nothing emitted / no prices) so the
    renderer can show "—" instead of a misleading 0.
    """
    positives = [r for r in rows if r["expects"]]
    return {
        "n": len(rows),
        "coverage": _mean([1.0 if r["emitted"] else 0.0 for r in rows]) or 0.0,
        "precision": precision_of(rows) if any(r["emitted"] for r in rows) else None,
        "fpr": fpr_of(rows),
        "recall": _mean([r["recall"] for r in positives]) or 0.0,
        "cit_acc": _mean([r["cit_acc"] for r in rows]) or 0.0,
        "faith": _mean([r["faith"] for r in rows]) or 0.0,
        "valid_ok": _mean([1.0 if r["valid_ok"] else 0.0 for r in rows]) or 0.0,
        "fabricated": sum(r.get("fabricated", 0) for r in rows),
        "tokens": _mean([float(r["tokens"]) for r in rows]) or 0.0,
        "cost": _mean([r["cost"] for r in rows if r.get("cost") is not None]),
        "latency": _mean([r["latency"] for r in rows]) or 0.0,
    }


def bootstrap_ci(rows: list[dict], stat_fn: Callable[[list[dict]], float], *,
                 iters: int = 1000, alpha: float = 0.05, seed: int = 0) -> tuple[float, float]:
    """Percentile bootstrap CI for a statistic over per-question rows. Deterministic via seed."""
    if not rows:
        return (0.0, 0.0)
    rng = random.Random(seed)
    n = len(rows)
    stats = sorted(stat_fn([rows[rng.randrange(n)] for _ in range(n)]) for _ in range(iters))
    return (stats[int((alpha / 2) * iters)], stats[int((1 - alpha / 2) * iters) - 1])


def corpus_citation_diagnostics(result: Result, corpus_refs: set[tuple[str, str]]) -> dict:
    """Separate retrieval misses from fabrications: of cited clauses NOT in the retrieved
    context, how many exist in the FULL corpus (retrieval miss) vs don't exist (fabricated).

    Returns zeros when validation is absent — we can't know what was in-context, so we don't
    misreport every citation as a miss/fabrication.
    """
    if result.validation is None:
        return {"retrieval_miss": 0, "fabricated": 0}
    in_context = {
        (c.citation.gost_id, c.citation.clause_path)
        for c in result.validation.citation_checks
        if c.in_context
    }
    miss = fabricated = 0
    for cit in result.answer.citations:
        key = (cit.gost_id, cit.clause_path)
        if key in in_context:
            continue
        if key in corpus_refs:
            miss += 1          # real clause, just not retrieved → retrieval problem
        else:
            fabricated += 1    # not in corpus at all → generation hallucination
    return {"retrieval_miss": miss, "fabricated": fabricated}


def ragas_sample(result: Result, gold: dict) -> dict:
    """Assemble one RAGAS sample from a Result (pure). The actual ragas.evaluate is wired
    in run_eval behind the [eval] extra; keeping assembly here makes it testable."""
    return {
        "user_input": result.query,
        "response": result.answer.text,
        "retrieved_contexts": list(result.contexts),
        "reference": gold.get("reference", ""),
    }

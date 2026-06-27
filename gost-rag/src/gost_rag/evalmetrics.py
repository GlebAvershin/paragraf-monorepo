"""Pure scoring & stats for the benchmark — no IO, unit-testable.

North-star framing (see plan): trust ≈ precision of EMITTED answers at near-zero
false-positives, traded against coverage and USD cost. These helpers turn a Result +
its gold entry into those signals; run_eval.py only orchestrates and renders.
"""

from __future__ import annotations

import random
from collections.abc import Callable

from .agentlogic import deterministic_gate
from .schema import Result, clause_ref


def cost_usd(prompt_tokens: int, completion_tokens: int, price: dict | None) -> float | None:
    """USD for one query from a {in, out} price (USD per 1M tokens). None if price unknown."""
    if not price:
        return None
    pin, pout = price.get("in"), price.get("out")
    if pin is None or pout is None:
        return None
    return prompt_tokens / 1_000_000 * pin + completion_tokens / 1_000_000 * pout


def cost_usd_by_model(by_model: dict[str, list[int]], prices: dict[str, dict | None]) -> float | None:
    """USD summed across models, each costed by ITS OWN price (USD/1M). Correct for mixed-model
    runs (judge ≠ generator, ensembles, cascade). None if ANY used model lacks a price — a partial
    sum would understate cost and mislead the Pareto."""
    if not by_model:
        return None
    total = 0.0
    for model, acc in by_model.items():
        pt, ct = acc[0], acc[1]
        c = cost_usd(pt, ct, prices.get(model))
        if c is None:
            return None
        total += c
    return total


def _context_gost_ids(contexts: list[str]) -> set[str]:
    # context refs are clause_ref() strings: "<gost_id>, п. <clause>" or bare "<gost_id>"
    return {c.split(", п. ")[0] for c in contexts}


def recall_fraction(result: Result, expected: list[dict]) -> float:
    """Graded retrieval recall over the gold's expected items.

    The real gold is labeled at DOCUMENT level (which standards to open): an expected item with no
    clause_path counts as recalled if ANY clause of that gost_id reached the used context. A
    clause-level expected (with clause_path) still requires that exact "(gost, п.)" ref — so one
    metric serves both the document-level gold and any precise clause checks.
    """
    if not expected:
        return 0.0
    ctx_refs = set(result.contexts)
    ctx_ids = _context_gost_ids(result.contexts)
    hits = 0
    for e in expected:
        clause = e.get("clause_path", "")
        ok = (clause_ref(e["gost_id"], clause) in ctx_refs) if clause else (e["gost_id"] in ctx_ids)
        hits += 1 if ok else 0
    return hits / len(expected)


# Latin↔Cyrillic homoglyph fold so steel-grade tokens match regardless of script: "А500С" is
# Cyrillic, but a model may emit the Latin-lookalike "A500C". Fold both sides before substring test.
_HOMOGLYPH = str.maketrans({
    "a": "а", "c": "с", "e": "е", "o": "о", "p": "р", "x": "х", "y": "у",
    "k": "к", "b": "в", "h": "н", "m": "м", "t": "т",
})


def _fold(s: str) -> str:
    return s.lower().translate(_HOMOGLYPH)


def material_coverage(result: Result, gold: dict) -> float | None:
    """Fraction of the gold material classes/types named in the answer (None if gold lists none).
    Substring match after a homoglyph+case fold — a soft 'did it recommend the right grades' signal,
    reported alongside (not folded into) precision so grounding stays the headline trust metric."""
    mats = gold.get("materials") or []
    if not mats:
        return None
    text = _fold(result.answer.text)
    return sum(1 for m in mats if _fold(m) in text) / len(mats)


def outcome(result: Result, gold: dict) -> dict:
    """Per-question trust outcome + raw selective-prediction signals (for offline threshold sweeps).
    `expects_answer` defaults True; negatives set it False."""
    expects = gold.get("expects_answer", True)
    emitted = not result.answer.abstained
    rfrac = recall_fraction(result, gold.get("expected", []))
    valid_ok = bool(result.validation and result.validation.ok)

    checks = result.validation.citation_checks if result.validation else []
    good_cits = sum(1 for c in checks if c.in_context and c.quote_found)
    cit_acc = good_cits / len(checks) if checks else (1.0 if result.answer.abstained else 0.0)
    gate_passed = deterministic_gate(checks, bool(result.answer.citations))
    match_min = min((c.match_score for c in checks), default=0.0)

    # multihop questions name several standards; retrieving 1 of 3 + passing validation must NOT
    # count as correct (12/23 positives are multihop) — require FULL document recall there.
    recall_ok = (rfrac >= 1.0) if gold.get("type") == "multihop" else (rfrac > 0)

    if expects:
        correct = emitted and recall_ok and valid_ok
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
        "recall_ok": recall_ok,
        "material_cov": material_coverage(result, gold),
        "cit_acc": cit_acc,
        "gate_passed": gate_passed,        # free deterministic citation gate (raw signal)
        "match_min": match_min,            # weakest citation quote-match (raw signal)
        "confidence": result.answer.confidence,  # model self-report (raw signal; gate only if it discriminates)
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


def positive_coverage(rows: list[dict]) -> float:
    """Coverage over ANSWERABLE questions only: emitted positives / total positives. The headline
    coverage axis — overall coverage is capped by the mandatory-abstain negatives, so it can't be
    the selective-prediction knob (4 of 27 gold are negatives → overall coverage ceiling 0.85)."""
    pos = [r for r in rows if r["expects"]]
    return sum(1 for r in pos if r["emitted"]) / len(pos) if pos else 0.0


def negative_specificity(rows: list[dict]) -> float:
    """Of the negatives (no answer in corpus), the fraction correctly abstained. Reported separately
    from positive coverage so 'answer the answerable' and 'stay silent on the unanswerable' don't
    blur into one misleading number."""
    neg = [r for r in rows if not r["expects"]]
    return sum(1 for r in neg if not r["emitted"]) / len(neg) if neg else 0.0


def cost_per_correct(rows: list[dict]) -> float | None:
    """USD per correct emitted answer = sum(cost) / #correct. The product-relevant cost unit (you
    pay for every call but only correct answers have value). None if costs missing or zero correct."""
    costs = [r["cost"] for r in rows if r.get("cost") is not None]
    n_correct = sum(1 for r in rows if r["correct"])
    return sum(costs) / n_correct if costs and n_correct else None


def risk_coverage(rows: list[dict], score_key: str) -> list[tuple[float, float, float]]:
    """OFFLINE selective-prediction sweep over positives: for each threshold t on a continuous
    `score_key` (e.g. 'faith' / 'match_min' / 'confidence'), emit the base-emittable rows
    (model didn't abstain AND deterministic gate passed) whose score ≥ t, and report
    (t, positive_coverage, precision). One run → the whole risk-coverage curve, no re-execution."""
    pos = [r for r in rows if r["expects"]]
    if not pos:
        return []
    base = [r for r in pos if r["emitted"] and r.get("gate_passed", True)]
    thresholds = sorted({r.get(score_key, 0.0) for r in base} | {0.0})
    points: list[tuple[float, float, float]] = []
    for t in thresholds:
        emit = [r for r in base if r.get(score_key, 0.0) >= t]
        coverage = len(emit) / len(pos)
        precision = (sum(1 for r in emit if r["correct"]) / len(emit)) if emit else 1.0
        points.append((t, coverage, precision))
    return points


def select_operating_point(rows: list[dict], score_key: str, *, prec_floor: float = 0.90,
                           cov_floor: float = 0.80) -> tuple[float, float, float] | None:
    """The threshold giving MAX positive-coverage among points meeting both precision and coverage
    floors (the cheapest abstention that holds the bar). None if the bar is unreachable on this run."""
    feasible = [p for p in risk_coverage(rows, score_key) if p[2] >= prec_floor and p[1] >= cov_floor]
    return max(feasible, key=lambda p: p[1]) if feasible else None


def paired_bootstrap(rows_a: list[dict], rows_b: list[dict], stat_fn: Callable[[list[dict]], float],
                     *, iters: int = 1000, alpha: float = 0.05, seed: int = 0) -> tuple[float, float]:
    """Percentile CI of the PAIRED delta stat(b) - stat(a) over the SAME questions (rows aligned by
    index). Paired comparison is the only way to distinguish configs on n=27 — independent CIs are
    too wide. A CI excluding 0 ⇒ a real difference; including 0 ⇒ not yet distinguished."""
    if not rows_a or len(rows_a) != len(rows_b):
        return (0.0, 0.0)
    rng = random.Random(seed)
    n = len(rows_a)
    deltas = []
    for _ in range(iters):
        idx = [rng.randrange(n) for _ in range(n)]
        deltas.append(stat_fn([rows_b[i] for i in idx]) - stat_fn([rows_a[i] for i in idx]))
    deltas.sort()
    return (deltas[int((alpha / 2) * iters)], deltas[int((1 - alpha / 2) * iters) - 1])


def discrimination(rows: list[dict], score_key: str) -> float | None:
    """AUC of `score_key` vs correctness over emitted positives (Mann-Whitney). ≈0.5 ⇒ the score
    can't tell correct from wrong (don't gate on it, e.g. an uncalibrated model `confidence`);
    →1.0 ⇒ it discriminates. None if either class is empty."""
    pos = [r for r in rows if r["expects"] and r["emitted"]]
    yes = [r.get(score_key, 0.0) for r in pos if r["correct"]]
    no = [r.get(score_key, 0.0) for r in pos if not r["correct"]]
    if not yes or not no:
        return None
    wins = sum((a > b) + 0.5 * (a == b) for a in yes for b in no)
    return wins / (len(yes) * len(no))


def aggregate(rows: list[dict]) -> dict:
    """Aggregate per-question outcomes into the headline trust×cost metrics.

    `precision` and `cost` are None when undefined (nothing emitted / no prices) so the
    renderer can show "—" instead of a misleading 0.
    """
    positives = [r for r in rows if r["expects"]]
    return {
        "n": len(rows),
        "coverage": _mean([1.0 if r["emitted"] else 0.0 for r in rows]) or 0.0,
        "pos_coverage": positive_coverage(rows),
        "neg_specificity": negative_specificity(rows),
        "precision": precision_of(rows) if any(r["emitted"] for r in rows) else None,
        "fpr": fpr_of(rows),
        "cost_per_correct": cost_per_correct(rows),
        "recall": _mean([r["recall"] for r in positives]) or 0.0,
        "material_cov": _mean([r["material_cov"] for r in rows if r.get("material_cov") is not None]),
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

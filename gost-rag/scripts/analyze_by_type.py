"""Per-task-type breakdown of a run dump (run_eval --dump / --report writes dump.jsonl with task_type):
where is the system strong/weak by question type — selection / lookup / substitution / procedure /
interpretation / multihop / negative. Pure re-analysis, no model calls.

    uv run python scripts/analyze_by_type.py eval/reports/<label>/dump.jsonl
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict

from gost_rag.evalmetrics import positive_coverage, precision_of


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "eval/dump.jsonl"
    rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
    for cfg in sorted({r["config"] for r in rows}):
        crows = [r for r in rows if r["config"] == cfg]
        print(f"\n## {cfg}  (n={len(crows)})")
        print(f"{'task_type':<16}{'n':>4}{'prec':>7}{'pos_cov':>9}{'recall':>8}{'mat':>7}")
        print("-" * 51)
        by_type: dict[str, list[dict]] = defaultdict(list)
        for r in crows:
            by_type[r.get("task_type") or "?"].append(r)
        for t in sorted(by_type):
            ts = by_type[t]
            prec = precision_of(ts)
            cov = positive_coverage(ts)
            rec = _mean([r["recall"] for r in ts if r["expects"]]) or 0.0
            mat = _mean([r.get("material_cov") for r in ts])
            mat_s = "—" if mat is None else f"{mat:.2f}"
            print(f"{t:<16}{len(ts):>4}{prec:>7.2f}{cov:>9.2f}{rec:>8.2f}{mat_s:>7}")


if __name__ == "__main__":
    main()

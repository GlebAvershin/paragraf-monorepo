"""Phase-2 OFFLINE analysis on a run dump (`run_eval --dump out.jsonl`): risk-coverage curve,
operating-point selection (max coverage at precision ≥0.90), score discrimination (which signal
gates well), and PAIRED config deltas. No model calls — pure re-analysis of one run's rows.

    uv run python scripts/analyze_thresholds.py eval/dump.jsonl
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict

from gost_rag.evalmetrics import (
    discrimination,
    fpr_of,
    paired_bootstrap,
    positive_coverage,
    precision_of,
    risk_coverage,
    select_operating_point,
)


def load(path: str) -> dict[str, list[dict]]:
    by_cfg: dict[str, list[dict]] = defaultdict(list)
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line:
            r = json.loads(line)
            by_cfg[r["config"]].append(r)
    return by_cfg


def align(a: list[dict], b: list[dict]) -> tuple[list[dict], list[dict]]:
    ai = {r["id"]: r for r in a}
    bi = {r["id"]: r for r in b}
    ids = [i for i in ai if i in bi]
    return [ai[i] for i in ids], [bi[i] for i in ids]


def _fmt_op(op):
    return None if op is None else (round(op[0], 2), round(op[1], 2), round(op[2], 2))


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "eval/dump.jsonl"
    by_cfg = load(path)
    print(f"# threshold analysis — {path}\nconfigs: {list(by_cfg)}\n")
    for cfg, rows in by_cfg.items():
        n_pos = sum(1 for r in rows if r["expects"])
        print(f"## {cfg}  (n={len(rows)}, positives={n_pos})")
        print(f"  precision={precision_of(rows):.2f}  pos_cov={positive_coverage(rows):.2f}  fpr={fpr_of(rows):.2f}")
        for key in ("faith", "match_min", "confidence"):
            disc = discrimination(rows, key)
            op = select_operating_point(rows, key, prec_floor=0.90, cov_floor=0.80)
            disc_s = "—" if disc is None else f"{disc:.2f}"
            print(f"  [{key:9}] AUC(correct)={disc_s}  op(prec≥.90,cov≥.80)={_fmt_op(op)}")
            pts = risk_coverage(rows, key)
            brief = "  ".join(f"t={round(t, 2)}→cov={round(c, 2)},prec={round(p, 2)}" for t, c, p in pts[:8])
            print(f"      risk-coverage: {brief}")
        print()

    cfgs = list(by_cfg)
    if len(cfgs) >= 2:
        print("## paired deltas vs the first config (95% CI of B−A; CI excluding 0 ⇒ real difference)")
        base = cfgs[0]
        for other in cfgs[1:]:
            a, b = align(by_cfg[base], by_cfg[other])
            dp = paired_bootstrap(a, b, precision_of)
            dc = paired_bootstrap(a, b, positive_coverage)
            print(f"  {other} − {base}:  Δprecision [{dp[0]:+.2f}, {dp[1]:+.2f}]   Δpos_cov [{dc[0]:+.2f}, {dc[1]:+.2f}]")


if __name__ == "__main__":
    main()

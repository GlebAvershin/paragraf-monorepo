"""Benchmark matrix: model x strategy(ablation) -> trust × cost.

North-star (see plan): precision of EMITTED answers at near-zero false-positives, at the
lowest USD cost. For every gold question each (model, strategy) combo is scored via
gost_rag.evalmetrics; results.md gets per-config metrics + bootstrap CIs.

Columns: prec=precision of emitted answers · fpr=confidently-wrong rate (→0) ·
pos_cov=coverage over ANSWERABLE questions (the selective-prediction knob) · neg_spec=negatives
correctly abstained · recall=graded doc-level recall (positives; multihop needs ALL docs) ·
mat=material-grade coverage · valid=passed the guardrail · fabr=hallucinated citations ·
cost$=USD/answer (per-model priced) · $/corr=USD per CORRECT answer (null prices ⇒ "—").

Usage:
    uv run python eval/run_eval.py                       # all models x all strategies (synthetic gold)
    uv run python eval/run_eval.py --model qwen/qwen3-8b
    uv run python eval/run_eval.py --ragas               # also export RAGAS samples (eval/ragas_samples.jsonl)
RAG combos need Qdrant indexed first (scripts/index_corpus.py); RLM reads the corpus directly.
"""

from __future__ import annotations

import json

import typer
import yaml
from rich.console import Console
from rich.table import Table

from gost_rag.agent import FIXTURES, answer_gost_query
from gost_rag.config import ROOT, load_model_registry
from gost_rag.corpus import load_corpus
from gost_rag.evalmetrics import (
    aggregate,
    bootstrap_ci,
    corpus_citation_diagnostics,
    cost_usd_by_model,
    fpr_of,
    outcome,
    precision_of,
    ragas_sample,
)

app = typer.Typer(add_completion=False)
console = Console()

COLUMNS = ["model", "strategy", "prec", "fpr", "pos_cov", "neg_spec", "recall", "mat",
           "valid", "fabr", "tokens", "cost$", "$/corr", "lat_s"]

# Strategies whose computation is independent of the swept gen_model (their models come from their
# own config) — run once, not once per gen_model, to avoid identical duplicate rows + wasted spend.
MODEL_AGNOSTIC = {"model_ensemble"}


def _fmt(v, spec: str = "", none: str = "—") -> str:
    return none if v is None else (f"{v:{spec}}" if spec else str(v))


def _label(strat: dict) -> str:
    """Unique row label per ablation — hybrid, rerank-mode and gate must not collapse to one name."""
    opts = {k: v for k, v in strat.items() if k != "name"}
    rerank = {"true": "+rerank", "1": "+rerank", "llm": "+rerank", "native": "+rerank.native"}.get(
        str(opts.get("rerank")).lower(), "")
    gate = ("+gate" if opts.get("gate") else "+raw") if "gate" in opts else ""
    topk = f".k{opts['top_k']}" if opts.get("top_k") not in (None, 8) else ""  # mark non-default top_k
    div = "+div" if opts.get("diversify") else ""
    return strat["name"] + ("+hybrid" if opts.get("hybrid") else "") + rerank + gate + div + topk


def _corpus_refs(corpus_dir: str, registry: str) -> set[tuple[str, str]]:
    return {
        (doc.gost_id, cl.clause_path)
        for doc in load_corpus(corpus_dir, registry_path=registry)
        for cl in doc.clauses
    }


@app.command()
def main(
    model: str = typer.Option(None, help="restrict to model id(s), comma-separated (e.g. 'z-ai/glm-5.2,minimax/minimax-m3')"),
    strategy: str = typer.Option(None, "--strategy", help="restrict to one strategy name (rag/rlm/verify_ensemble/…)"),
    label: str = typer.Option(None, "--label", help="restrict to specific config label(s), comma-sep (e.g. 'rag+raw,rag+gate')"),
    limit: int = typer.Option(0, "--limit", help="взять только первые N вопросов gold (0 = все) — для дешёвого смока"),
    corpus: str = typer.Option(str(FIXTURES), "--corpus", help="каталог корпуса для диагностики цитат"),
    registry: str = typer.Option(str(ROOT / "data" / "registry.yaml"), "--registry"),
    ragas: bool = typer.Option(False, "--ragas", help="экспорт RAGAS-сэмплов в eval/ragas_samples.jsonl"),
    dump: str = typer.Option(None, "--dump", help="сохранить per-row сигналы в JSONL (для оффлайн risk-coverage/paired)"),
    report: str = typer.Option(None, "--report", help="заархивировать отчёт в eval/reports/<label>/ (results.md + dump.jsonl + meta)"),
) -> None:
    reg = load_model_registry()
    gold = yaml.safe_load((ROOT / "eval" / "gold.yaml").read_text(encoding="utf-8"))
    if limit:
        gold = gold[:limit]
    model_ids = set(model.split(",")) if model else None
    gen_models = [m for m in reg["generation"] if not model_ids or m["id"] in model_ids]
    labels = set(label.split(",")) if label else None
    strategies = [s for s in reg["strategies"]
                  if (not strategy or s["name"] == strategy) and (not labels or _label(s) in labels)]
    corpus_refs = _corpus_refs(corpus, registry)
    # price per model id (USD/1M) — covers generator, judge and any ensemble/cascade models, so cost
    # is attributed per the model that actually spent the tokens (Usage.by_model), not the gen price.
    prices = {m["id"]: m.get("price") for m in reg["generation"]}

    table = Table(title="ГОСТ-agent benchmark · достоверность × стоимость", show_lines=True)
    for col in COLUMNS:
        table.add_column(col)
    md = ["| " + " | ".join(COLUMNS) + " |", "|" + "---|" * len(COLUMNS)]
    ci_lines = ["", "### Доверительные интервалы (bootstrap 95%)", "",
                "| model | strategy | precision CI | fpr CI |", "|---|---|---|---|"]
    ragas_rows: list[dict] = []
    dump_rows: list[dict] = []

    for gi, gm in enumerate(gen_models):
        for strat in strategies:
            if strat["name"] in MODEL_AGNOSTIC and gi > 0:
                continue  # already run for the first gen_model; result is identical
            opts = {k: v for k, v in strat.items() if k != "name"}
            label = _label(strat)
            rows: list[dict] = []
            for q in gold:
                try:
                    r = answer_gost_query(q["query"], strategy=strat["name"], gen_model=gm["id"], **opts)
                except Exception as exc:  # noqa: BLE001 — one bad combo shouldn't kill the sweep
                    console.print(f"[red]fail[/red] {gm['label']} / {label} / {q['query'][:40]}: {exc}")
                    continue
                row = outcome(r, q)
                row["id"] = q.get("id")
                row["cost"] = cost_usd_by_model(r.usage.by_model, prices)
                row.update(corpus_citation_diagnostics(r, corpus_refs))
                rows.append(row)
                if ragas:
                    ragas_rows.append(ragas_sample(r, q))
            if not rows:
                continue
            if dump or report:
                dump_rows.extend({**r, "config": label, "gen_model": gm["id"]} for r in rows)
            agg = aggregate(rows)
            cells = [
                gm["label"], label,
                _fmt(agg["precision"], ".2f"), _fmt(agg["fpr"], ".2f"),
                _fmt(agg["pos_coverage"], ".2f"), _fmt(agg["neg_specificity"], ".2f"),
                _fmt(agg["recall"], ".2f"), _fmt(agg["material_cov"], ".2f"),
                _fmt(agg["valid_ok"], ".2f"), _fmt(agg["fabricated"]),
                _fmt(agg["tokens"], ".0f"), _fmt(agg["cost"], ".4f"),
                _fmt(agg["cost_per_correct"], ".4f"), _fmt(agg["latency"], ".1f"),
            ]
            table.add_row(*cells)
            md.append("| " + " | ".join(cells) + " |")
            pci = bootstrap_ci(rows, precision_of)
            fci = bootstrap_ci(rows, fpr_of)
            ci_lines.append(f"| {gm['label']} | {label} | [{pci[0]:.2f}, {pci[1]:.2f}] | [{fci[0]:.2f}, {fci[1]:.2f}] |")

    console.print(table)
    out = ROOT / "eval" / "results.md"
    out.write_text("\n".join(md + ci_lines) + "\n", encoding="utf-8")
    console.print(f"[dim]saved {out}[/dim]")

    md_text = "\n".join(md + ci_lines) + "\n"
    if dump:
        from pathlib import Path
        Path(dump).write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in dump_rows) + "\n", encoding="utf-8")
        console.print(f"[dim]dumped {len(dump_rows)} rows → {dump}[/dim]")

    if report:
        from datetime import datetime, timezone
        rdir = ROOT / "eval" / "reports" / report
        rdir.mkdir(parents=True, exist_ok=True)
        (rdir / "results.md").write_text(md_text, encoding="utf-8")
        (rdir / "dump.jsonl").write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in dump_rows) + "\n", encoding="utf-8")
        meta = {"label": report, "when": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "filters": {"model": model, "strategy": strategy, "label": label, "limit": limit},
                "corpus": corpus, "n_rows": len(dump_rows), "configs": sorted({r["config"] for r in dump_rows})}
        (rdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        console.print(f"[dim]report → {rdir}  ({len(dump_rows)} rows)[/dim]")

    if ragas:
        rs = ROOT / "eval" / "ragas_samples.jsonl"
        rs.write_text("\n".join(json.dumps(s, ensure_ascii=False) for s in ragas_rows) + "\n", encoding="utf-8")
        console.print(f"[dim]RAGAS samples → {rs} "
                      f"(прогнать ragas.evaluate с настроенными judge+embeddings — [eval] extra)[/dim]")


if __name__ == "__main__":
    app()

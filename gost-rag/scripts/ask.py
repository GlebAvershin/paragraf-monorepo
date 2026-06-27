"""Ask the ГОСТ agent one question — defaults to the WINNER config (gated RAG + hybrid + document
diversification, top_k=16, deepseek-chat), so manual testing reflects the best pipeline, not the
weak dense-k8 baseline.

    uv run python scripts/ask.py "Какая арматура для фундамента при -40..+50?"
    uv run python scripts/ask.py --gold rebar-monolith        # ask a gold question + show its reference
    uv run python scripts/ask.py --no-hybrid --no-diversify "..."   # the baseline retrieval, to compare
    uv run python scripts/ask.py --model z-ai/glm-5.2 "..."
"""

from __future__ import annotations

import yaml
import typer
from rich.console import Console
from rich.panel import Panel

from gost_rag.agent import answer_gost_query
from gost_rag.config import ROOT
from gost_rag.sources import resolve_citations

app = typer.Typer(add_completion=False)
console = Console()


def _gold_by_id(gid: str) -> dict | None:
    gold = yaml.safe_load((ROOT / "eval" / "gold.yaml").read_text(encoding="utf-8"))
    return next((q for q in gold if q.get("id") == gid), None)


@app.command()
def main(
    query: str = typer.Argument(None, help="вопрос (или используй --gold <id>)"),
    gold: str = typer.Option(None, "--gold", help="взять вопрос из gold по id и показать эталон"),
    strategy: str = typer.Option("rag", help="rag | rlm | verify_ensemble | cascade | ..."),
    model: str = typer.Option("deepseek/deepseek-chat", "--model", help="модель-генератор (победитель: deepseek-chat)"),
    top_k: int = typer.Option(16, "--top-k", help="сколько чанков в контекст (победитель: 16)"),
    hybrid: bool = typer.Option(True, "--hybrid/--no-hybrid", help="dense+BM25 (нужна *_hybrid коллекция)"),
    diversify: bool = typer.Option(True, "--diversify/--no-diversify", help="round-robin по документам (поднимает recall)"),
    industry: str = typer.Option(None, help="фильтр по отрасли (по умолчанию выкл.)"),
):
    reference, expected = None, []
    if gold:
        q = _gold_by_id(gold)
        if not q:
            console.print(f"[red]нет вопроса с id={gold} в gold.yaml[/red]")
            raise typer.Exit(1)
        query, reference, expected = q["query"], q.get("reference"), q.get("expected", [])
    if not query:
        console.print("[red]укажи вопрос или --gold <id>[/red]")
        raise typer.Exit(1)

    opts = {} if strategy == "rlm" else {"top_k": top_k, "hybrid": hybrid, "diversify": diversify}
    r = answer_gost_query(query, strategy=strategy, gen_model=model, industry=industry, **opts)
    v = r.validation
    verdict = "—" if not v else ("[green]OK — выдан[/green]" if v.ok else "[red]ОТКЛОНЁН → воздержание[/red]")

    console.print(Panel(f"[bold]ВОПРОС:[/bold] {query}", border_style="dim"))
    body = r.answer.text + ("\n\n[dim](воздержался — нет обоснованного ответа)[/dim]" if r.answer.abstained else "")
    console.print(Panel(body, title=f"ОТВЕТ · {strategy} · {r.model}", border_style="cyan"))
    if reference:
        console.print(Panel(reference, title="ЭТАЛОН (gold reference)", border_style="green"))

    if r.answer.citations:
        console.print("[bold]Ссылки в ответе (открыть исходник для проверки):[/bold]")
        for c, src in zip(r.answer.citations, resolve_citations(r.answer.citations)):
            console.print(f"  • [bold]{c.gost_id}[/bold], п. {c.clause_path} — «{c.quote[:90]}»")
            if src.available:
                console.print(f"      источник ({src.view.kind}): [link={src.view.url}]{src.view.url}[/link]")
            else:
                console.print("      [dim]источник недоступен[/dim]")

    # which documents reached the context (and, for a gold question, which expected ones were hit/missed)
    ctx_docs = sorted({ref.split(", п. ")[0] for ref in r.contexts})
    console.print(f"\n[bold]Документы в контексте[/bold] ({len(ctx_docs)}): {', '.join(ctx_docs) or '—'}")
    if expected:
        exp_ids = [e["gost_id"] for e in expected]
        hit = [g for g in exp_ids if g in ctx_docs]
        miss = [g for g in exp_ids if g not in ctx_docs]
        console.print(f"[bold]Ожидались (gold):[/bold] {', '.join(exp_ids)}")
        console.print(f"  [green]найдено: {', '.join(hit) or '—'}[/green]   [red]пропущено: {', '.join(miss) or '—'}[/red]")

    if v:
        console.print(f"\nВалидация: {verdict}  faithfulness={v.faithfulness:.2f}")
        for issue in v.issues:
            console.print(f"  [yellow]![/yellow] {issue}")
    console.print(
        f"[dim]calls={r.usage.model_calls} tokens={r.usage.prompt_tokens}+{r.usage.completion_tokens} "
        f"latency={r.usage.latency_s}s[/dim]"
    )


if __name__ == "__main__":
    app()

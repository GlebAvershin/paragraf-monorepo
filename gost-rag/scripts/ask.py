"""Ask the agent one question and print answer + citations + validation.

Usage:
    uv run python scripts/ask.py "Какой шрифт у реквизитов документа?"
    uv run python scripts/ask.py --strategy rlm --model deepseek/deepseek-chat "..."
"""

from __future__ import annotations

import typer
from rich.console import Console
from rich.panel import Panel

from gost_rag.agent import answer_gost_query

app = typer.Typer(add_completion=False)
console = Console()


@app.command()
def main(
    query: str,
    strategy: str = typer.Option("rag", help="rag | rlm"),
    model: str = typer.Option(None, help="OpenRouter model id (default from .env)"),
    industry: str = typer.Option(None, help="filter by industry"),
    rerank: bool = typer.Option(False, help="(rag) LLM rerank"),
):
    r = answer_gost_query(query, strategy=strategy, gen_model=model, industry=industry, rerank=rerank)
    v = r.validation
    verdict = "—"
    if v:
        verdict = "[green]OK[/green]" if v.ok else "[red]ОТКЛОНЁН[/red]"

    body = r.answer.text + ("\n\n[dim](abstained)[/dim]" if r.answer.abstained else "")
    console.print(Panel(body, title=f"{strategy} · {r.model}", border_style="cyan"))

    if r.answer.citations:
        console.print("[bold]Ссылки:[/bold]")
        for c in r.answer.citations:
            console.print(f"  • {c.gost_id}, п. {c.clause_path} — «{c.quote[:90]}»")
    if v:
        console.print(f"\nВалидация: {verdict}  faithfulness={v.faithfulness:.2f}")
        for issue in v.issues:
            console.print(f"  [yellow]![/yellow] {issue}")
    console.print(
        f"\n[dim]calls={r.usage.model_calls} tokens={r.usage.prompt_tokens}+{r.usage.completion_tokens} "
        f"latency={r.usage.latency_s}s · контекст: {', '.join(r.contexts) or '—'}[/dim]"
    )


if __name__ == "__main__":
    app()

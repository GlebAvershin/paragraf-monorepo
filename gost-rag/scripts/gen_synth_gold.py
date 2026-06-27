"""Synthetic gold generator — broaden the eval beyond the one human-labeled question type.

Per ГОСТ document: generate realistic engineer questions ACROSS task types (see eval/TAXONOMY.md),
grounded in real clauses, then CROSS-VENDOR verify each (generator ≠ verifier; the verifier checks the
answer against the REAL clause text, not the generator's quote). Kept questions → a gold YAML, marked
`source: synthetic` with a train/test split. Synthetic = breadth/regression, NOT absolute truth — the
human gold (data.md) stays the trust anchor; sample-review the output.

    uv run python scripts/gen_synth_gold.py --limit-docs 3 --per-doc 5 --out eval/gold_synth_pilot.yaml
    uv run python scripts/gen_synth_gold.py --out eval/gold_synth.yaml        # full corpus
"""

from __future__ import annotations

import zlib

import typer
import yaml

from gost_rag.config import ROOT, load_settings
from gost_rag.corpus import load_corpus
from gost_rag.llm import LLM, parse_json
from gost_rag.schema import _CLAUSE_PREFIX_RE, Usage  # models write "п. 5.4.1"; chunks key on bare "5.4.1"

app = typer.Typer(add_completion=False)

GEN_SYSTEM = """Ты — методист: составляешь вопросы для проверки ИИ-ассистента по российским стандартам (ГОСТ/СП).
Дан фрагмент одного стандарта (его пункты с текстом). Сгенерируй реалистичные вопросы инженера-технолога,
на которые ОТВЕЧАЮТ приведённые пункты. Жёсткие требования:
1. Формулировка — как у инженера (сценарий «у меня <объект> в условиях <среда/температура/…>, что …?»),
   НЕ дословная перефразировка текста пункта (иначе вопрос тривиален).
2. Покрой РАЗНЫЕ типы (где применимо к этим пунктам): selection (подбор материала/изделия),
   lookup (конкретное требование/значение), substitution (допустимость замены), procedure (метод/испытание/
   контроль), interpretation (толкование формулировки).
3. Ответ давай СТРОГО по приведённым пунктам; укажи clause_paths (РОВНО из приведённых) и дословную quote.
4. Если в пунктах есть классы/марки материала — перечисли применимые в "materials".
5. Ничего не выдумывай сверх приведённых пунктов.

Верни СТРОГО JSON без markdown:
{"questions": [
  {"query": "<вопрос>", "task_type": "selection|lookup|substitution|procedure|interpretation",
   "clause_paths": ["<пункт из приведённых>", ...], "answer": "<ответ строго по пунктам>",
   "materials": ["<класс/марка>", ...], "quote": "<дословная цитата из пункта>", "difficulty": "easy|medium|hard"}
]}"""

VERIFY_SYSTEM = """Ты — СТРОГИЙ рецензент тестовых вопросов по ГОСТам. Дан вопрос, его тип, предложенный ОТВЕТ
и РЕАЛЬНЫЙ текст пунктов, на которые он ссылается. Проверь:
1. Ответ ПОЛНОСТЬЮ следует из приведённого текста пунктов (ничего не выдумано, не додумано).
2. Вопрос реалистичен и отвечаем по этим пунктам; это НЕ тривиальная дословная перефразировка текста.
3. Тип (task_type) указан корректно.
При ЛЮБОМ сомнении → keep=false. Верни СТРОГО JSON: {"keep": <true|false>, "reason": "<кратко>"}"""


def _brief(doc, max_clauses: int = 18, clip: int = 360) -> tuple[str, dict]:
    """Compact document brief for the generator + a {clause_path: text} map for verification."""
    clauses = [c for c in doc.clauses if len(c.text) > 80][:max_clauses]
    by_path = {c.clause_path: c.text for c in doc.clauses}
    lines = [f"СТАНДАРТ: {doc.gost_id} — {doc.title} (отрасль: {doc.industry})", "ПУНКТЫ:"]
    lines += [f"[п. {c.clause_path}] {c.text[:clip]}" for c in clauses]
    return "\n".join(lines), by_path


def _split(query: str) -> str:
    return "test" if (zlib.crc32(query.encode("utf-8")) % 5 == 0) else "train"  # ~20% held-out


@app.command()
def main(
    out: str = typer.Option("eval/gold_synth.yaml", "--out"),
    src: str = typer.Option("data/pdfs", "--src"),
    registry: str = typer.Option(str(ROOT / "data" / "registry.yaml"), "--registry"),
    limit_docs: int = typer.Option(0, "--limit-docs", help="0 = все документы (для пилота поставь 2-3)"),
    per_doc: int = typer.Option(6, "--per-doc", help="сколько вопросов просить на документ"),
    gen_model: str = typer.Option("deepseek/deepseek-chat", "--gen-model"),
    verify_model: str = typer.Option("z-ai/glm-5.2", "--verify-model", help="кросс-вендор, ≠ генератора"),
) -> None:
    settings = load_settings()
    llm = LLM(settings)
    docs = load_corpus(src, registry_path=registry)
    if limit_docs:
        docs = docs[:limit_docs]

    kept: list[dict] = []
    stats = {"generated": 0, "kept": 0, "rejected": 0, "by_type": {}}
    usage = Usage()
    for doc in docs:
        try:  # one bad document must not lose the whole (long) run; partial result still written
            brief, by_path = _brief(doc)
            raw = llm.chat(model=gen_model, system=GEN_SYSTEM,
                           user=f"{brief}\n\nСгенерируй {per_doc} вопросов (разные типы). Только JSON.", usage=usage)
            questions = parse_json(raw).get("questions", [])
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] {doc.gost_id}: генерация упала: {exc}")
            continue
        for q in questions:
            stats["generated"] += 1
            # normalize "п. 5.4.1" → "5.4.1" before matching the doc's bare clause paths
            paths = [pp for p in q.get("clause_paths", [])
                     if (pp := _CLAUSE_PREFIX_RE.sub("", str(p)).strip()) in by_path]
            if not q.get("query") or not paths:
                stats["rejected"] += 1
                continue
            # verifier sees the REAL clause text (not the generator's quote)
            cited = "\n\n".join(f"[п. {p}]\n{by_path[p]}" for p in paths)
            try:
                vraw = llm.chat(model=verify_model, system=VERIFY_SYSTEM,
                                user=f"ВОПРОС: {q['query']}\nТИП: {q.get('task_type')}\nОТВЕТ: {q.get('answer')}\n\n"
                                     f"РЕАЛЬНЫЙ ТЕКСТ ПУНКТОВ:\n{cited}", usage=usage)
                keep = bool(parse_json(vraw).get("keep", False))
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] verify упал ({doc.gost_id}): {exc}")
                keep = False
            if not keep:
                stats["rejected"] += 1
                continue
            t = q.get("task_type", "lookup")
            stats["kept"] += 1
            stats["by_type"][t] = stats["by_type"].get(t, 0) + 1
            kept.append({
                "id": f"syn-{doc.gost_id.replace(' ', '').replace('/', '')}-{stats['kept']}",
                "query": q["query"],
                "task_type": t,
                "type": "multihop" if len(paths) > 1 and t == "selection" else "citation",
                "expected": [{"gost_id": doc.gost_id, "clause_path": p} for p in paths],
                "materials": q.get("materials") or [],
                "reference": q.get("answer", ""),
                "industry": doc.industry,
                "expects_answer": True,
                "difficulty": q.get("difficulty", "medium"),
                "source": "synthetic",
                "split": _split(q["query"]),
            })
        # incremental write after each document — a long run must never lose progress on kill/crash
        (ROOT / out).write_text(yaml.safe_dump(kept, allow_unicode=True, sort_keys=False), encoding="utf-8")
        print(f"[{doc.gost_id}] kept={stats['kept']} generated={stats['generated']}", flush=True)

    (ROOT / out).write_text(yaml.safe_dump(kept, allow_unicode=True, sort_keys=False), encoding="utf-8")
    print(f"\n# generated={stats['generated']} kept={stats['kept']} rejected={stats['rejected']} "
          f"(accept={stats['kept'] / max(stats['generated'], 1):.0%})")
    print(f"# by_type: {stats['by_type']}")
    print(f"# tokens: {usage.prompt_tokens}+{usage.completion_tokens}  →  {ROOT / out}")


if __name__ == "__main__":
    app()

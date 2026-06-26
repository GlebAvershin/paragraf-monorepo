"""Answer generation: context -> grounded answer + citations (via OpenRouter)."""

from __future__ import annotations

from .llm import LLM, num, parse_json
from .prompts import SYSTEM_GOST
from .schema import Answer, RetrievedChunk, Usage, parse_citations


def format_context(chunks: list[RetrievedChunk]) -> str:
    blocks = []
    for r in chunks:
        c = r.chunk
        blocks.append(f"[{c.gost_id} | п. {c.clause_path}]\n{c.text}")
    return "\n\n".join(blocks)


def generate_answer(llm: LLM, model: str, query: str, chunks: list[RetrievedChunk], usage: Usage,
                    temperature: float = 0.0) -> Answer:
    context = format_context(chunks)
    user = f"CONTEXT:\n{context}\n\nВОПРОС: {query}"
    raw = llm.chat(model=model, system=SYSTEM_GOST, user=user, usage=usage, temperature=temperature)
    data = parse_json(raw)
    if not data:
        # Model returned unparseable output — treat as a low-confidence plain answer.
        return Answer(text=raw.strip(), citations=[], confidence=0.0, abstained=False)
    return Answer(
        text=str(data.get("answer", "")),
        citations=parse_citations(data.get("citations", [])),
        confidence=num(data.get("confidence")),
        abstained=bool(data.get("abstained", False)),
    )

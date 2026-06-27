"""Answer strategies behind one interface, so the eval harness compares them fairly.

- RAGStrategy:  embed query -> Qdrant dense search -> (optional LLM rerank) -> generate.
- RLMStrategy:  Recursive Language Model. The controller has NO corpus in context;
  it explores with tools (grep / open) and can `recurse` — delegate a sub-question
  to a fresh LM instance over a scoped slice of clauses (depth-limited). Captures the
  RLM idea (Zhang & Khattab, 2025): treat the corpus as an environment to explore and
  recurse over, instead of relying on vector-retrieval recall.
"""

from __future__ import annotations

from .corpus import clause_text
from .generate import format_context, generate_answer
from .llm import LLM, num, parse_json
from .prompts import RLM_ROOT, SYSTEM_GOST
from .schema import Answer, Chunk, RetrievedChunk, Result, Usage, clause_ref, parse_citations
from .store import Store
from .validate import validate


def _context_by_ref(chunks: list[Chunk]) -> dict[tuple[str, str], str]:
    return {(c.gost_id, c.clause_path): c.text for c in chunks}


class RAGStrategy:
    name = "rag"

    def __init__(self, llm: LLM, store: Store, gen_model: str, judge_model: str,
                 top_k: int = 8, rerank=False, reranker=None, gate: bool = True,
                 faith_threshold=None, quote_threshold=None, diversify: bool = False):
        self._llm, self._store = llm, store
        self._gen_model, self._judge_model = gen_model, judge_model
        self._top_k = top_k
        self._reranker = reranker  # NativeReranker | None (Stream D2)
        self._diversify = diversify  # round-robin retrieval by document (lifts multi-doc recall)
        # validation thresholds (None ⇒ validate() defaults) — the Phase-2 abstain-calibration knobs.
        self._faith_threshold = faith_threshold
        self._quote_threshold = quote_threshold
        # Enforce the guardrail: abstain when validation fails (gate=True). The multi-agent
        # strategies already do this; plain RAG historically did NOT — it returned answers the
        # validator rejected, which is most of the false-positive rate. gate=False keeps the raw
        # (un-gated) baseline for comparison.
        self._gate = gate
        # rerank mode: "off" | "llm" (the in-house LLM ranker) | "native" (a cross-encoder endpoint).
        mode = str(rerank).lower() if rerank else "off"
        self._rerank = "llm" if mode in ("true", "1", "llm") else ("native" if mode == "native" else "off")

    def answer(self, query: str, industry: str | None = None) -> Result:
        usage = Usage()
        overfetch = self._rerank in ("llm", "native")
        hits = self._store.search(query, top_k=self._top_k * 3 if overfetch else self._top_k,
                                  industry=industry, diversify=self._diversify)
        if self._rerank == "native" and self._reranker is not None:
            hits = self._reranker.rerank(query, hits, self._top_k)
        elif self._rerank == "llm":
            hits = self._llm_rerank(query, hits, usage)[: self._top_k]
        else:  # "off", or native without a configured reranker → plain top_k (never pass the overfetch on)
            hits = hits[: self._top_k]
        answer = generate_answer(self._llm, self._gen_model, query, hits, usage)
        used = [h.chunk for h in hits]
        vkw = {}
        if self._faith_threshold is not None:
            vkw["faith_threshold"] = self._faith_threshold
        if self._quote_threshold is not None:
            vkw["quote_threshold"] = self._quote_threshold
        report = validate(
            self._llm, self._judge_model, query, answer,
            _context_by_ref(used), format_context(hits), usage, **vkw,
        )
        if self._gate and not report.ok:
            answer = answer.model_copy(update={"abstained": True})  # guardrail rejected → abstain
        return Result(
            query=query, strategy=self.name, model=self._gen_model, answer=answer,
            validation=report, usage=usage, contexts=[c.ref for c in used],
        )

    def _llm_rerank(self, query: str, hits: list[RetrievedChunk], usage: Usage) -> list[RetrievedChunk]:
        listing = "\n".join(f"[{i}] {h.chunk.ref}: {h.chunk.text[:200]}" for i, h in enumerate(hits))
        raw = self._llm.chat(
            model=self._gen_model, usage=usage,
            system="Отранжируй фрагменты по релевантности вопросу. Верни JSON: {\"order\": [индексы от лучшего]}",
            user=f"ВОПРОС: {query}\n\nФРАГМЕНТЫ:\n{listing}",
        )
        order = parse_json(raw).get("order", [])
        ranked = [hits[i] for i in order if isinstance(i, int) and 0 <= i < len(hits)]
        seen = set(id(h) for h in ranked)
        return ranked + [h for h in hits if id(h) not in seen]


class RLMStrategy:
    name = "rlm"

    def __init__(self, llm: LLM, chunks: list[Chunk], gen_model: str, judge_model: str, max_steps: int = 12, max_depth: int = 2):
        self._llm, self._chunks = llm, chunks
        self._gen_model, self._judge_model = gen_model, judge_model
        self._max_steps, self._max_depth = max_steps, max_depth

    def answer(self, query: str, industry: str | None = None) -> Result:
        usage = Usage()
        opened: dict[tuple[str, str], str] = {}
        answer = self._run(query, depth=0, scope=None, opened=opened, usage=usage)
        used = [Chunk(id="", gost_id=g, clause_path=c, title="", text=t) for (g, c), t in opened.items()]
        context_text = "\n\n".join(f"[{g} | п. {c}]\n{t}" for (g, c), t in opened.items())
        report = validate(self._llm, self._judge_model, query, answer, dict(opened), context_text, usage)
        return Result(
            query=query, strategy=self.name, model=self._gen_model, answer=answer,
            validation=report, usage=usage, contexts=[clause_ref(g, c) for (g, c) in opened],
        )

    def _view(self, scope: set[tuple[str, str]] | None) -> list[Chunk]:
        if scope is None:
            return self._chunks
        return [c for c in self._chunks if (c.gost_id, c.clause_path) in scope]

    def _run(self, query: str, depth: int, scope, opened: dict, usage: Usage) -> Answer:
        view = self._view(scope)
        observations: list[str] = []
        for _ in range(self._max_steps):
            recurse_hint = "" if depth < self._max_depth else " (recurse НЕДОСТУПЕН — достигнут предел глубины)"
            obs = "\n".join(observations[-6:]) or "(пока ничего не исследовано)"
            user = f"ВОПРОС: {query}\n\nНАБЛЮДЕНИЯ:\n{obs}\n\nГлубина рекурсии: {depth}{recurse_hint}\nСледующее действие (строго JSON):"
            action = parse_json(self._llm.chat(model=self._gen_model, system=RLM_ROOT, user=user, usage=usage))
            kind = action.get("action")

            if kind == "grep":
                pat = str(action.get("pattern", "")).lower()
                found = [c for c in view if pat and pat in c.text.lower()][:8]
                observations.append(
                    f"grep '{pat}': " + ("; ".join(f"{c.gost_id}::{c.clause_path}" for c in found) or "ничего")
                )
            elif kind == "open":
                g, c = str(action.get("gost_id", "")), str(action.get("clause_path", ""))
                txt = clause_text(view, g, c)
                if txt:
                    opened[(g, c)] = txt
                observations.append(f"open {g}::{c}:\n{(txt or 'не найдено')[:600]}")
            elif kind == "recurse" and depth < self._max_depth:
                subq = str(action.get("question", query))
                refs = {tuple(s.split("::", 1)) for s in action.get("scope", []) if "::" in s}  # type: ignore[misc]
                sub = self._run(subq, depth + 1, refs or scope, opened, usage)
                observations.append(f"recurse '{subq}' -> {sub.text[:400]}")
            elif kind == "finish":
                return Answer(
                    text=str(action.get("answer", "")),
                    citations=parse_citations(action.get("citations", [])),
                    confidence=num(action.get("confidence")),
                    abstained=bool(action.get("abstained", False)),
                )
            else:
                observations.append("неизвестное действие — используй grep/open/recurse/finish")
        return Answer(text="Не удалось собрать обоснованный ответ за лимит шагов.", abstained=True)

"""Native cross-encoder reranker (Stream D2) — an alternative to RAGStrategy's LLM-as-reranker.

A dedicated reranker (e.g. Qwen3-Reranker served on vLLM) usually reorders retrieved passages
better AND cheaper than asking the generation LLM to rank them. The HTTP shape follows the common
/rerank API ({model, query, documents} -> {results:[{index, relevance_score}]}, Cohere/Jina/vLLM
style); adjust the client to your server if it differs. The ordering logic is pure + unit-tested.
"""

from __future__ import annotations

import httpx

from .schema import RetrievedChunk


def reorder(hits: list[RetrievedChunk], results: list[dict], top_k: int) -> list[RetrievedChunk]:
    """Reorder hits by reranker results [{index, relevance_score}], rewriting scores; keep top_k.

    Robust to a flaky reranker: out-of-range/duplicate indices are dropped, and any hit the
    reranker didn't score is appended after the ranked ones (so we never silently lose a passage).
    """
    ranked: list[RetrievedChunk] = []
    seen: set[int] = set()
    for r in sorted(results, key=lambda x: x.get("relevance_score", 0.0), reverse=True):
        i = r.get("index")
        if isinstance(i, int) and 0 <= i < len(hits) and i not in seen:
            seen.add(i)
            ranked.append(RetrievedChunk(chunk=hits[i].chunk, score=float(r.get("relevance_score", hits[i].score))))
    ranked += [h for j, h in enumerate(hits) if j not in seen]
    return ranked[:top_k]


class NativeReranker:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 30.0):
        self._url = base_url.rstrip("/") + "/rerank"
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key and api_key != "EMPTY" else {}
        self._model = model
        self._timeout = timeout

    def rerank(self, query: str, hits: list[RetrievedChunk], top_k: int) -> list[RetrievedChunk]:
        if not hits:
            return hits
        resp = httpx.post(
            self._url,
            json={"model": self._model, "query": query, "documents": [h.chunk.text for h in hits]},
            headers=self._headers,
            timeout=self._timeout,
        )
        resp.raise_for_status()
        return reorder(hits, resp.json().get("results", []), top_k)

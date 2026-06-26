"""Embeddings via OpenRouter (OpenAI-compatible) — Qwen3-Embedding-8B by default.

Same OPENROUTER_API_KEY as generation, so one key covers the whole pipeline — no self-hosted
embedder. Qwen3-Embedding is instruction-aware: queries get a task instruction prefix, docs don't.
"""

from __future__ import annotations

from openai import OpenAI

from .config import Settings

_QUERY_INSTRUCT = (
    "Instruct: Найди пункты ГОСТов, релевантные вопросу пользователя.\nQuery: "
)


class Embedder:
    def __init__(self, settings: Settings):
        # dedicated embeddings key if set, else reuse the OpenRouter key (one-key setup)
        api_key = settings.embeddings_api_key or settings.openrouter_api_key or "EMPTY"
        self._client = OpenAI(api_key=api_key, base_url=settings.embeddings_base_url)
        self._model = settings.embeddings_model
        self.dim = settings.embeddings_dim

    def _embed(self, texts: list[str]) -> list[list[float]]:
        resp = self._client.embeddings.create(model=self._model, input=texts)
        return [d.embedding for d in resp.data]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._embed(texts)

    def embed_query(self, text: str) -> list[float]:
        return self._embed([_QUERY_INSTRUCT + text])[0]

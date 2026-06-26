"""Chat-LLM provider resolution.

A clean seam so the active backend (OpenRouter) and a future one (LiteLLM via the
paragraf-gateway :4000) are selected by `settings.llm_provider`, not by editing call
sites. Adding LiteLLM later = one branch here + filling the litellm_* settings; the
rest of the code (llm.LLM) is unaware which backend it talks to.

NB: LiteLLM is NOT built/used yet — the slot exists so we don't have to rewrite later.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import Settings


@dataclass(frozen=True)
class ChatProvider:
    name: str
    base_url: str
    api_key: str
    headers: dict[str, str] = field(default_factory=dict)


def resolve_chat_provider(settings: Settings) -> ChatProvider:
    name = (settings.llm_provider or "openrouter").lower()
    if name == "openrouter":
        return ChatProvider(
            "openrouter",
            settings.openrouter_base_url,
            settings.openrouter_api_key,
            # OpenRouter ranks/attributes calls by these optional headers.
            {"HTTP-Referer": "https://github.com/GlebAvershin/paragraf-monorepo", "X-Title": "gost-rag"},
        )
    if name == "litellm":
        # Future: route through the paragraf LiteLLM gateway (:4000) with a virtual key.
        return ChatProvider("litellm", settings.litellm_base_url, settings.litellm_api_key)
    raise ValueError(f"unknown llm_provider: {name!r} (expected 'openrouter' or 'litellm')")

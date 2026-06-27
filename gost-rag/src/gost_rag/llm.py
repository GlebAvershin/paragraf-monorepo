"""Thin OpenAI-compatible chat client + robust JSON parsing.

All generation, the LLM-judge, and RLM/multi-agent sub-calls go through here, so model
choice is a single string, token usage is tracked uniformly for the cost benchmark, and
the backend (OpenRouter now; LiteLLM later) is chosen via the provider seam — not here.
Each call is optionally traced to Langfuse (no-op unless configured).
"""

from __future__ import annotations

import json
import re
import time

from openai import OpenAI

from .config import Settings
from .providers import resolve_chat_provider
from .schema import Usage
from .tracing import get_tracer


class LLM:
    def __init__(self, settings: Settings):
        provider = resolve_chat_provider(settings)
        self._client = OpenAI(
            api_key=provider.api_key or "EMPTY",
            base_url=provider.base_url,
            default_headers=provider.headers or None,
        )
        self._tracer = get_tracer()

    def chat(self, model: str, system: str, user: str, usage: Usage, temperature: float = 0.0) -> str:
        t0 = time.perf_counter()
        resp = self._client.chat.completions.create(
            model=model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        latency = time.perf_counter() - t0
        u = resp.usage
        pt, ct = (u.prompt_tokens or 0, u.completion_tokens or 0) if u else (0, 0)
        usage.add(pt, ct, model)
        out = resp.choices[0].message.content or ""
        self._tracer.generation(
            name="chat", model=model, prompt=user, output=out,
            prompt_tokens=pt, completion_tokens=ct, latency_s=latency,
        )
        return out


def num(value, default: float = 0.0) -> float:
    """Coerce a model-supplied numeric field defensively (a weak model may return "high")."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_json(text: str) -> dict:
    """Best-effort JSON extraction — models wrap JSON in prose or ```json fences."""
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # fall back to the outermost {...}
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                pass
    return {}

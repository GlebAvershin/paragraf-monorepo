"""Unit tests for the chat-provider seam (Stream E)."""

from __future__ import annotations

import pytest

from gost_rag.config import Settings
from gost_rag.providers import resolve_chat_provider


def test_openrouter_is_the_active_default():
    p = resolve_chat_provider(Settings(openrouter_api_key="sk-x"))
    assert p.name == "openrouter"
    assert "openrouter" in p.base_url
    assert p.api_key == "sk-x"
    assert p.headers  # OpenRouter ranking headers present


def test_litellm_slot_resolves_to_gateway():
    s = Settings(llm_provider="litellm", litellm_base_url="http://localhost:4000", litellm_api_key="sk-v")
    p = resolve_chat_provider(s)
    assert p.name == "litellm"
    assert p.base_url == "http://localhost:4000"
    assert p.api_key == "sk-v"


def test_unknown_provider_raises():
    with pytest.raises(ValueError):
        resolve_chat_provider(Settings(llm_provider="bogus"))

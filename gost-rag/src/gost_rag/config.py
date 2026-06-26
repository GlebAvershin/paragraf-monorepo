"""Settings from env (.env) + the model registry (config/models.yaml)."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    # Active chat backend: "openrouter" (used now) | "litellm" (future, via paragraf-gateway).
    llm_provider: str = "openrouter"
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    # Seam for later — LiteLLM/paragraf-gateway. NOT used while llm_provider == "openrouter".
    litellm_base_url: str = "http://localhost:4000"
    litellm_api_key: str = ""

    # Embeddings via OpenRouter (OpenAI-compatible). Key falls back to OPENROUTER_API_KEY (see Embedder).
    embeddings_base_url: str = "https://openrouter.ai/api/v1"
    embeddings_api_key: str = ""
    embeddings_model: str = "qwen/qwen3-embedding-8b"
    embeddings_dim: int = 4096

    qdrant_url: str = "http://localhost:6333"
    qdrant_collection: str = "gost"

    # Native reranker (Stream D2) — OpenAI/Cohere-style /rerank endpoint (e.g. Qwen3-Reranker on vLLM).
    rerank_base_url: str = "http://localhost:8001"
    rerank_api_key: str = "EMPTY"
    rerank_model: str = "Qwen/Qwen3-Reranker-8B"

    gen_model: str = "qwen/qwen3-8b"
    judge_model: str = "qwen/qwen3-8b"


def load_settings() -> Settings:
    return Settings()


def load_model_registry() -> dict:
    path = ROOT / "config" / "models.yaml"
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)

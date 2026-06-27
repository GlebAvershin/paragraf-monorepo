"""Core data contracts. Everything downstream speaks these types."""

from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator

# Models echo the human style "п. 6.2.5" / "пункт 6.2.5"; chunks store the bare "6.2.5". Strip a
# leading "п."/"пункт" (possibly repeated) before a digit so citation matching isn't broken by it.
_CLAUSE_PREFIX_RE = re.compile(r"^\s*(?:(?:пункт|п\.?)\s*)+(?=\d)", re.IGNORECASE)


def clause_ref(gost_id: str, clause_path: str) -> str:
    """Canonical citation ref — ONE format everywhere (expected set, strategy contexts, Chunk.ref).

    Bare gost_id when clause_path is empty (preamble/scope), else "GOST, п. X". Keeping a single
    source of truth prevents recall mismatches between the gold set and retrieved contexts.
    """
    return f"{gost_id}, п. {clause_path}" if clause_path else gost_id


class Clause(BaseModel):
    """One addressable unit of a ГОСТ — the granularity we cite."""

    clause_path: str  # e.g. "5.2.1"  (empty for preamble/scope)
    title: str = ""
    text: str


class Document(BaseModel):
    gost_id: str  # e.g. "ГОСТ Р 7.0.97-2016"
    title: str
    industry: str = ""
    year: int | None = None
    clauses: list[Clause] = Field(default_factory=list)


class Chunk(BaseModel):
    """A retrievable, citable chunk. id is deterministic so re-indexing is idempotent."""

    id: str
    gost_id: str
    clause_path: str
    title: str
    industry: str = ""
    text: str  # clause text, prefixed with a small header for retrieval context

    @property
    def ref(self) -> str:
        return clause_ref(self.gost_id, self.clause_path)


class RetrievedChunk(BaseModel):
    chunk: Chunk
    score: float


class Citation(BaseModel):
    gost_id: str
    clause_path: str = ""
    quote: str = ""  # verbatim span the model claims to rely on

    @field_validator("clause_path", mode="before")
    @classmethod
    def _normalize_clause_path(cls, v):
        # "п. 6.2.5" → "6.2.5" so the deterministic check matches the retrieved clause's bare path.
        return _CLAUSE_PREFIX_RE.sub("", v).strip() if isinstance(v, str) else v


def parse_citations(items) -> list["Citation"]:
    """Validate a list of raw citation dicts, dropping malformed ones (missing gost_id etc.)
    instead of crashing the whole generation."""
    out: list[Citation] = []
    for c in items if isinstance(items, list) else []:
        if not isinstance(c, dict):
            continue
        try:
            out.append(Citation.model_validate(c))
        except Exception:  # noqa: BLE001 — drop a malformed citation, keep the good ones
            continue
    return out


class Answer(BaseModel):
    text: str
    citations: list[Citation] = Field(default_factory=list)
    confidence: float = 0.0
    abstained: bool = False


class CitationCheck(BaseModel):
    citation: Citation
    in_context: bool        # cited clause was actually among retrieved/opened context
    quote_found: bool       # quote fuzzy-matches the source clause text
    match_score: float = 0.0


class ValidationReport(BaseModel):
    ok: bool
    faithfulness: float = 0.0       # 0..1 from the LLM judge
    citation_checks: list[CitationCheck] = Field(default_factory=list)
    issues: list[str] = Field(default_factory=list)


class Usage(BaseModel):
    """Accumulated cost/latency signal for one query (across all model calls)."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    model_calls: int = 0
    latency_s: float = 0.0
    # Per-model token attribution [prompt, completion, calls] — so a mixed-model run
    # (Claude generator + qwen judge, or a cheap→expensive cascade) is costed per its own price,
    # not the single gen-model price. Without this the cost Pareto is fiction for ensembles/cascade.
    by_model: dict[str, list[int]] = Field(default_factory=dict)

    def add(self, prompt: int, completion: int, model: str = "") -> None:
        self.prompt_tokens += prompt
        self.completion_tokens += completion
        self.model_calls += 1
        if model:
            acc = self.by_model.setdefault(model, [0, 0, 0])
            acc[0] += prompt
            acc[1] += completion
            acc[2] += 1


class Result(BaseModel):
    """What a strategy returns: the answer, its validation, and the cost it incurred."""

    query: str
    strategy: str
    model: str
    answer: Answer
    validation: ValidationReport | None = None
    usage: Usage = Field(default_factory=Usage)
    contexts: list[str] = Field(default_factory=list)  # refs of context actually used

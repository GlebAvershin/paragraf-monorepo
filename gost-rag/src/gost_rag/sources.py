"""Resolve a Citation (gost_id, clause_path, quote) → a source-INDEPENDENT `Source` for the frontend.

The frontend renders from `Source.view` alone (kind/url/mime/page) and NEVER knows where the document is
stored. Today every doc resolves to an external portal URL (kind="external"). When we self-host files,
flip the entry in `data/sources.yaml` to kind="backend" with url="/api/sources/<doc_id>" — the frontend
is unchanged. This is the seam that lets us defer the "how do we store documents" decision.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml

from .config import ROOT
from .schema import Citation, Source, SourceView

_SOURCES = ROOT / "data" / "sources.yaml"


@lru_cache(maxsize=4)
def load_sources(path: str | None = None) -> dict[str, dict]:
    p = Path(path) if path else _SOURCES
    return (yaml.safe_load(p.read_text(encoding="utf-8")) or {}) if p.exists() else {}


def resolve_source(gost_id: str, clause_path: str = "", quote: str = "",
                   sources: dict[str, dict] | None = None) -> Source:
    """Map one citation to a viewable Source. Unknown/scan-gap docs → available=False (frontend shows
    'источник недоступен') so the engineer still sees WHAT was cited, just can't open it."""
    sources = load_sources() if sources is None else sources
    s = sources.get(gost_id)
    if not s or s.get("kind", "unavailable") == "unavailable":
        return Source(doc_id=gost_id, title=(s or {}).get("title", ""), clause_path=clause_path,
                      quote=quote, view=SourceView(kind="unavailable"), available=False)
    return Source(
        doc_id=gost_id, title=s.get("title", ""), clause_path=clause_path, quote=quote,
        view=SourceView(kind=s["kind"], url=s.get("url", ""), mime=s.get("mime", ""), page=s.get("page")),
        available=True,
    )


def resolve_citations(citations: list[Citation], sources: dict[str, dict] | None = None) -> list[Source]:
    """Resolve every citation of an answer → the Sources the frontend renders for validation."""
    sources = load_sources() if sources is None else sources
    return [resolve_source(c.gost_id, c.clause_path, c.quote, sources) for c in citations]


def sources_for_hits(hits, sources: dict[str, dict] | None = None) -> list[Source]:
    """Resolve retrieved hits → one viewable Source per document (dedup by gost_id, keep the top-ranked
    clause). The /retrieve endpoint returns these so engine can hand the web SourceViewer authoritative
    `metadata.sources`, replacing the client-side regex stopgap. Hits are score-sorted ⇒ first wins.
    `hits` are duck-typed (anything with `.chunk.gost_id` / `.chunk.clause_path`)."""
    sources = load_sources() if sources is None else sources
    seen: set[str] = set()
    out: list[Source] = []
    for h in hits:
        gid = h.chunk.gost_id
        if gid in seen:
            continue
        seen.add(gid)
        out.append(resolve_source(gid, h.chunk.clause_path, sources=sources))
    return out

"""/retrieve source resolution: retrieved hits → deduped viewable Source[] for the web SourceViewer.

Imports the helper from `gost_rag.sources` (NOT `gost_rag.server`) so the test runs under `--extra dev`
without the optional `serve` extra (fastapi/uvicorn)."""

from __future__ import annotations

from gost_rag.schema import Chunk, RetrievedChunk
from gost_rag.sources import sources_for_hits

SRC = {
    "ГОСТ 34028-2016": {"kind": "external", "url": "https://x/g.pdf", "mime": "application/pdf",
                        "title": "Прокат арматурный"},
    "ГОСТ 14098-2014": {"kind": "external", "url": "https://x/w.pdf", "mime": "application/pdf",
                        "title": "Соединения сварные"},
}


def _hit(gost_id: str, clause: str, score: float) -> RetrievedChunk:
    return RetrievedChunk(
        chunk=Chunk(id=f"{gost_id}:{clause}", gost_id=gost_id, clause_path=clause, title="t", text="x"),
        score=score,
    )


def test_sources_for_hits_dedups_by_doc_keeping_top_clause():
    hits = [
        _hit("ГОСТ 34028-2016", "5.2.1", 0.9),
        _hit("ГОСТ 34028-2016", "7.1", 0.7),  # same doc, lower rank → dropped
        _hit("ГОСТ 14098-2014", "4.3", 0.6),
    ]
    out = sources_for_hits(hits, sources=SRC)
    assert [s.doc_id for s in out] == ["ГОСТ 34028-2016", "ГОСТ 14098-2014"]  # deduped, order preserved
    assert out[0].clause_path == "5.2.1"  # top-ranked clause of the doc wins
    assert all(s.available and s.view.kind == "external" for s in out)


def test_sources_for_hits_empty():
    assert sources_for_hits([], sources=SRC) == []

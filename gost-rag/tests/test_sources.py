"""Citation → source-independent Source resolution (the frontend's storage-agnostic contract)."""

from __future__ import annotations

from gost_rag.schema import Citation
from gost_rag.sources import resolve_citations, resolve_source

SRC = {"ГОСТ 34028-2016": {"kind": "external", "url": "https://x/g.pdf",
                           "mime": "application/pdf", "title": "Прокат арматурный"}}


def test_resolve_external_source_carries_locator():
    s = resolve_source("ГОСТ 34028-2016", "5.2.1", "цитата", sources=SRC)
    assert s.available and s.view.kind == "external" and s.view.url == "https://x/g.pdf"
    assert s.view.mime == "application/pdf"
    assert s.doc_id == "ГОСТ 34028-2016" and s.clause_path == "5.2.1" and s.quote == "цитата"
    assert s.title == "Прокат арматурный"


def test_unknown_or_scan_gap_doc_is_unavailable():
    s = resolve_source("ГОСТ НЕТ-2099", "1", sources=SRC)
    assert not s.available and s.view.kind == "unavailable" and s.view.url == ""
    assert s.doc_id == "ГОСТ НЕТ-2099"  # still shows WHAT was cited, just not viewable
    gap = resolve_source("СанПиН X", sources={"СанПиН X": {"kind": "unavailable", "title": "T"}})
    assert not gap.available and gap.view.kind == "unavailable" and gap.title == "T"


def test_resolve_citations_list():
    cits = [Citation(gost_id="ГОСТ 34028-2016", clause_path="п. 5.2.1", quote="q"), Citation(gost_id="X")]
    out = resolve_citations(cits, sources=SRC)
    assert [s.available for s in out] == [True, False]
    assert out[0].clause_path == "5.2.1"  # citation already normalized the "п." prefix

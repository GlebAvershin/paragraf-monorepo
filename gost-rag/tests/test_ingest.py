"""Unit tests for PDF ingest — pure functions, no PDF/network needed.

Run: cd paragraf-monorepo/gost-rag && uv run --extra dev pytest
"""

from __future__ import annotations

from gost_rag.corpus import _chunk_id
from gost_rag.ingest.pdf import detect_gost_id, segment_clauses

GOST_TEXT = """\
ГОСТ Р 7.0.97-2016
СИБИД. Организационно-распорядительная документация. Требования к оформлению документов

Предисловие
Сведения о стандарте ...

1 Область применения
Настоящий стандарт распространяется на организационно-распорядительные документы.

5 Оформление документов
5.1 Общие требования
Документы оформляют на бланках формата A4. Размеры полей: левое — 20 мм.
5.2 Реквизиты
Реквизиты документа располагают согласно схеме.
6.4 Шрифт
Используют размеры шрифтов № 12, 13, 14.
1. Дополнительный пункт списка внутри 6.4.
"""


def test_segment_clauses_paths():
    # the trailing "1. ..." list item must NOT split into a clause "1"
    assert [c.clause_path for c in segment_clauses(GOST_TEXT)] == ["1", "5", "5.1", "5.2", "6.4"]


def test_segment_clauses_body_and_no_empty():
    by_path = {c.clause_path: c.text for c in segment_clauses(GOST_TEXT)}
    assert "20 мм" in by_path["5.1"]
    assert "Дополнительный пункт" in by_path["6.4"]  # list item stayed in 6.4's body
    assert all(c.text for c in segment_clauses(GOST_TEXT))


def test_detect_gost_id():
    assert detect_gost_id(GOST_TEXT) == "ГОСТ Р 7.0.97-2016"


def test_chunk_id_is_deterministic_uuid():
    a = _chunk_id("ГОСТ Р 7.0.97-2016", "5.1")
    b = _chunk_id("ГОСТ Р 7.0.97-2016", "5.1")
    c = _chunk_id("ГОСТ Р 7.0.97-2016", "5.2")
    assert a == b and a != c
    assert len(a) == 36 and a.count("-") == 4  # UUID string


def test_parse_pdf_metadata_from_registry(monkeypatch, tmp_path):
    import gost_rag.ingest.pdf as pdfmod

    monkeypatch.setattr(pdfmod, "extract_pages", lambda _p: [GOST_TEXT])
    registry = {"ГОСТ Р 7.0.97-2016": {"industry": "делопроизводство", "year": 2016}}
    doc = pdfmod.parse_pdf(tmp_path / "x.pdf", registry)
    assert doc.gost_id == "ГОСТ Р 7.0.97-2016"
    assert doc.industry == "делопроизводство"
    assert doc.year == 2016
    assert [c.clause_path for c in doc.clauses] == ["1", "5", "5.1", "5.2", "6.4"]


def test_parse_pdf_year_falls_back_to_id_suffix(monkeypatch, tmp_path):
    import gost_rag.ingest.pdf as pdfmod

    monkeypatch.setattr(pdfmod, "extract_pages", lambda _p: [GOST_TEXT])
    doc = pdfmod.parse_pdf(tmp_path / "x.pdf", {})  # empty registry
    assert doc.year == 2016  # parsed from the "-2016" suffix
    assert doc.industry == ""  # absent from registry → empty (warned at load time)

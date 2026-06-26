"""Ingest real ГОСТ documents into the Document contract (currently: text PDFs)."""

from __future__ import annotations

from .pdf import load_pdf_documents, parse_pdf, segment_clauses

__all__ = ["load_pdf_documents", "parse_pdf", "segment_clauses"]

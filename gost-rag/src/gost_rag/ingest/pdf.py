"""Parse real ГОСТ PDFs (text layer) into the Document contract.

This is the production swap for the JSON fixtures: `load_pdf_documents()` yields the
exact same `Document` objects that `corpus.chunk_documents()` already consumes, so
nothing downstream (chunking, embedding, retrieval, validation) changes.

Design:
- `extract_pages()` is a thin pdfplumber wrapper (the only IO). pdfplumber is imported
  lazily, so this module — and `segment_clauses` — import even before it is installed.
- `segment_clauses()` is a PURE function (text -> clauses): unit-testable without a PDF.
- Metadata (gost_id / industry / year / title) is detected from the title page and
  enriched from `data/registry.yaml` (industry can't be inferred from text reliably).

Heuristic & limits (text PDFs only; scans need OCR — see README / doc-tools fallback):
a clause opens on a line starting with a clause number ("5", "5.1", "5.2.1.3") followed
by whitespace + text; everything until the next such line is its body. Clause numbers are
assumed без trailing dot (ГОСТ convention), so list items like "1)" / "1." are NOT
mistaken for clauses. A clause number alone on its own line (text wrapped to the next
line) is not split — acceptable for typical text PDFs.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from ..schema import Clause, Document

# A line opens a clause/section: "5", "5.1", "5.2.1.3" + whitespace + text (no trailing dot).
_CLAUSE_RE = re.compile(r"^(?P<num>\d{1,2}(?:\.\d{1,3}){0,5})\s+(?P<rest>\S.*)$")
# ГОСТ designation on the title page, e.g. "ГОСТ Р 7.0.97-2016", "ГОСТ 2.105-2019".
_GOST_ID_RE = re.compile(r"ГОСТ(?:\s+Р)?\s+\d+(?:\.\d+)*(?:-\d{4})?")


def segment_clauses(text: str) -> list[Clause]:
    """Split raw ГОСТ text into citable clauses by leading clause numbering. Pure, no IO."""
    clauses: list[Clause] = []
    cur: str | None = None
    buf: list[str] = []

    def flush() -> None:
        if cur is not None:
            body = " ".join(s for s in (x.strip() for x in buf) if s).strip()
            if body:
                clauses.append(Clause(clause_path=cur, title="", text=body))

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _CLAUSE_RE.match(line)
        if m:
            flush()
            cur = m.group("num")
            buf = [m.group("rest")]
        elif cur is not None:
            buf.append(line)
        # lines before the first clause (title page, содержание, предисловие) are dropped
    flush()
    return clauses


def detect_gost_id(text: str) -> str | None:
    m = _GOST_ID_RE.search(text)
    return re.sub(r"\s+", " ", m.group(0)).strip() if m else None


def _detect_year(gost_id: str) -> int | None:
    m = re.search(r"-(\d{4})\b", gost_id)
    return int(m.group(1)) if m else None


def _detect_title(head: str, gost_id: str | None) -> str | None:
    for raw in head.splitlines():
        s = raw.strip()
        if len(s) >= 15 and (gost_id or "") not in s and any(c.islower() for c in s):
            return s
    return None


def extract_pages(pdf_path: str | Path) -> list[str]:
    import pdfplumber  # lazy: keep module import (and segment_clauses) PDF-dep-free

    with pdfplumber.open(str(pdf_path)) as pdf:
        return [(page.extract_text() or "") for page in pdf.pages]


def parse_pdf(pdf_path: str | Path, registry: dict | None = None) -> Document:
    pages = extract_pages(pdf_path)
    full = "\n".join(pages)
    head = pages[0] if pages else ""
    gost_id = detect_gost_id(head) or detect_gost_id(full) or Path(pdf_path).stem
    meta = (registry or {}).get(gost_id, {})
    return Document(
        gost_id=gost_id,
        title=meta.get("title") or _detect_title(head, gost_id) or Path(pdf_path).stem,
        industry=meta.get("industry", ""),
        year=meta.get("year") or _detect_year(gost_id),
        clauses=segment_clauses(full),
    )


def load_registry(registry_path: str | Path | None) -> dict:
    if not registry_path:
        return {}
    path = Path(registry_path)
    return (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.exists() else {}


def load_pdf_documents(pdf_dir: str | Path, registry_path: str | Path | None = None) -> list[Document]:
    registry = load_registry(registry_path)
    docs: list[Document] = []
    for path in sorted(Path(pdf_dir).glob("*.pdf")):
        doc = parse_pdf(path, registry)
        if not doc.clauses:
            print(f"[warn] {path.name}: 0 пунктов — текстовый ли это PDF, не скан? (сканам нужен OCR)")
        if not doc.industry:
            print(f"[warn] {doc.gost_id}: industry пуст — добавьте в data/registry.yaml")
        docs.append(doc)
    return docs

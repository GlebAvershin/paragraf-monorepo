"""Parse real ГОСТ / СП / СанПиН / ТР ТС PDFs (text layer) into the Document contract.

This is the production swap for the JSON fixtures: `load_pdf_documents()` yields the
exact same `Document` objects that `corpus.chunk_documents()` already consumes, so
nothing downstream (chunking, embedding, retrieval, validation) changes.

Design:
- `extract_pages()` is a thin pdfplumber wrapper (the only IO). pdfplumber is imported
  lazily, so this module — and the segmentation functions — import even before it is installed.
- `segment_clauses()` / `window_chunks()` are PURE functions (text -> clauses): unit-testable.
- Metadata (gost_id / industry / year / title) comes from `data/registry.yaml`, keyed by file
  **slug** (the canonical source of truth for our fixed corpus), with on-text detection as a
  fallback for unregistered PDFs.

Heuristic & limits (text PDFs only; scans need OCR — see README / doc-tools fallback):
- A clause opens on a line starting with a clause number ("5", "5.1", "5.2.1.3") + whitespace +
  text; everything until the next such line is its body. Numbers are assumed без trailing dot
  (ГОСТ convention), so list items like "1)" / "1." are NOT mistaken for clauses.
- Designations print the year via an EM DASH ("ГОСТ 34028—2016", U+2014), not a hyphen — we
  normalize all dash variants to "-" so ids match the registry / gold set.
- Some documents don't use clause numbering our regex catches (ТР ТС articles, table-heavy
  sanitary norms, scans). When structural segmentation captures too little of the text we fall
  back to fixed-size windows ("§1", "§2", …) so the document is still indexed and retrievable —
  document-level citation (gost_id) stays valid; clause-level precision is lower for those docs.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from ..schema import Clause, Document

# A line opens a clause/section: "5", "5.1", "5.2.1.3" + whitespace + text (no trailing dot).
_CLAUSE_RE = re.compile(r"^(?P<num>\d{1,2}(?:\.\d{1,3}){0,5})\s+(?P<rest>\S.*)$")

# Dash variants Russian standards use between number and year ("ГОСТ 34028—2016", U+2014).
_DASHES = "‐‑‒–—―−"
# Designation on the title page: ГОСТ Р / ГОСТ / СНиП / СанПиН / СП / ТР ТС + a number that may
# carry dots, dashes (any variant) and slashes ("СП 295.1325800.2017", "ТР ТС 012/2011").
_DESIG_RE = re.compile(
    r"(?:ГОСТ\s+Р|ГОСТ|СНиП|СанПиН|СП|ТР\s+ТС)\s+\d+(?:[.\-/" + _DASHES + r"]\d+)*"
)

# Fall back to windowing when structural segmentation captures too little of the text.
_MIN_CLAUSES = 5
_MIN_COVERAGE = 0.45
_WINDOW = 900
_OVERLAP = 150


def _normalize_dashes(s: str) -> str:
    for d in _DASHES:
        s = s.replace(d, "-")
    return s


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


def window_chunks(text: str, size: int = _WINDOW, overlap: int = _OVERLAP) -> list[Clause]:
    """Coverage fallback: slice the whole (whitespace-collapsed) text into overlapping windows
    with synthetic paths "§1", "§2", …  Keeps a document retrievable when its numbering isn't
    detectable; gost_id-level citation stays valid."""
    flat = " ".join(text.split())
    if not flat:
        return []
    out: list[Clause] = []
    step = max(size - overlap, 1)
    for i in range(0, len(flat), step):
        out.append(Clause(clause_path=f"§{len(out) + 1}", title="", text=flat[i : i + size]))
        if i + size >= len(flat):
            break
    return out


def _coverage(clauses: list[Clause], full: str) -> float:
    return sum(len(c.text) for c in clauses) / max(len(full), 1)


def segment_or_window(text: str) -> tuple[list[Clause], bool]:
    """Structural clauses if they capture enough of the text, else the window fallback.
    Returns (clauses, used_fallback)."""
    clauses = segment_clauses(text)
    if len(clauses) >= _MIN_CLAUSES and _coverage(clauses, text) >= _MIN_COVERAGE:
        return clauses, False
    win = window_chunks(text)
    return (win, True) if win else (clauses, False)


def detect_gost_id(text: str) -> str | None:
    m = _DESIG_RE.search(text)
    return _normalize_dashes(re.sub(r"\s+", " ", m.group(0)).strip()) if m else None


def _detect_year(gost_id: str) -> int | None:
    m = re.search(r"-(\d{4})\b", _normalize_dashes(gost_id))
    return int(m.group(1)) if m else None


def _detect_title(head: str, gost_id: str | None) -> str | None:
    for raw in head.splitlines():
        s = raw.strip()
        if len(s) >= 15 and (gost_id or "") not in s and any(c.islower() for c in s):
            return s
    return None


def extract_pages(pdf_path: str | Path) -> list[str]:
    import pdfplumber  # lazy: keep module import (and segmentation) PDF-dep-free

    with pdfplumber.open(str(pdf_path)) as pdf:
        return [(page.extract_text() or "") for page in pdf.pages]


def parse_pdf(pdf_path: str | Path, registry: dict | None = None) -> Document:
    pages = extract_pages(pdf_path)
    full = "\n".join(pages)
    head = pages[0] if pages else ""
    detected = detect_gost_id(head) or detect_gost_id(full)
    registry = registry or {}
    stem = Path(pdf_path).stem
    # registry is keyed by file slug (canonical for our fixed corpus); fall back to the detected
    # designation key so an unregistered PDF still gets enriched if its id happens to be listed.
    meta = registry.get(stem) or (registry.get(detected) if detected else None) or {}
    gost_id = meta.get("gost_id") or detected or stem
    clauses, _fallback = segment_or_window(full)
    return Document(
        gost_id=gost_id,
        title=meta.get("title") or _detect_title(head, gost_id) or stem,
        industry=meta.get("industry", ""),
        year=meta.get("year") or _detect_year(gost_id),
        clauses=clauses,
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
            print(f"[warn] {path.name}: 0 пунктов — вероятно скан (нет текстового слоя), нужен OCR")
        elif doc.clauses[0].clause_path.startswith("§"):
            print(f"[warn] {doc.gost_id}: структурная нумерация не распознана → оконный фоллбэк "
                  f"({len(doc.clauses)} окон); цитаты на уровне документа, не пункта")
        if not doc.industry:
            print(f"[warn] {doc.gost_id}: industry пуст — добавьте в data/registry.yaml")
        docs.append(doc)
    return docs

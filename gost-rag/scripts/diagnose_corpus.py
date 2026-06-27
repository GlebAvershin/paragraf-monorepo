"""Diagnostic: how does the real PDF corpus parse — designation, pages, text, clauses, scan-risk?

Run BEFORE freezing registry.yaml + the designation regex. No network / Qdrant needed.
    uv run python scripts/diagnose_corpus.py [data/pdfs]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from gost_rag.ingest.pdf import extract_pages, segment_clauses

# Candidate improved detector: ГОСТ(Р) / СП / СНиП / СанПиН / ТР ТС, number with . - / and
# em/en dashes (Russian standards print the year as "ГОСТ 34028—2016", U+2014, not a hyphen).
_DASHES = "‐‑‒–—―−"  # ‐ ‑ ‒ – — ― −
_DESIG_RE = re.compile(
    r"(?P<kind>ГОСТ\s+Р|ГОСТ|СНиП|СанПиН|СП|ТР\s+ТС)\s+"
    r"(?P<num>\d+(?:[.\-/" + _DASHES + r"]\d+)*)"
)


def normalize_designation(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    for d in _DASHES:
        s = s.replace(d, "-")
    return s


def detect_designation(text: str) -> str | None:
    m = _DESIG_RE.search(text)
    return normalize_designation(m.group(0)) if m else None


def main() -> None:
    pdf_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "data/pdfs")
    pdfs = sorted(pdf_dir.glob("*.pdf"))
    print(f"# corpus diagnostic — {len(pdfs)} PDFs in {pdf_dir}\n")
    print(f"{'file':<26}{'pages':>6}{'chars':>9}{'p1ch':>7}{'cls':>6}  {'designation (improved)':<24} scan?")
    print("-" * 96)
    rows = []
    for p in pdfs:
        try:
            pages = extract_pages(p)
        except Exception as exc:  # noqa: BLE001
            print(f"{p.name:<26}  EXTRACT FAIL: {exc}")
            continue
        full = "\n".join(pages)
        chars = len(full)
        p1 = len(pages[0]) if pages else 0
        clauses = segment_clauses(full)
        desig = detect_designation(pages[0] if pages else "") or detect_designation(full)
        # scan-risk: lots of pages but little extractable text
        per_page = chars / max(len(pages), 1)
        scan = "SCAN?" if per_page < 200 else ""
        rows.append((p.name, desig, len(clauses), chars, scan))
        print(f"{p.name:<26}{len(pages):>6}{chars:>9}{p1:>7}{len(clauses):>6}  {str(desig):<24} {scan}")
        # show a couple of sample clause paths so we can eyeball segmentation quality
        sample = ", ".join(c.clause_path for c in clauses[:6])
        print(f"{'':<26}  clauses[:6]= {sample}")
    print("\n# summary")
    print("  no designation:", [r[0] for r in rows if not r[1]])
    print("  zero clauses  :", [r[0] for r in rows if r[2] == 0])
    print("  scan-risk     :", [r[0] for r in rows if r[4]])


if __name__ == "__main__":
    main()

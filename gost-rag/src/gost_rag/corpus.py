"""Ingest documents and turn them into citable chunks.

For now the source is JSON fixtures (real ГОСТ texts arrive later). Chunking is
structure-aware: one chunk per clause, carrying gost_id + clause_path so the
citation "ГОСТ X, п. Y" is exact rather than reconstructed from prose.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from .schema import Chunk, Document

# Stable namespace so chunk ids are deterministic UUID5(gost_id::clause_path): idempotent
# re-indexing, no hash collisions (Qdrant takes the UUID string directly as the point id).
_CHUNK_NS = uuid.uuid5(uuid.NAMESPACE_URL, "gost-rag/chunk")


def load_documents(fixtures_dir: str | Path) -> list[Document]:
    docs: list[Document] = []
    for path in sorted(Path(fixtures_dir).glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        for item in raw if isinstance(raw, list) else [raw]:
            docs.append(Document.model_validate(item))
    return docs


def load_corpus(src: str | Path, *, fmt: str = "auto", registry_path: str | Path | None = None) -> list[Document]:
    """Load documents from JSON fixtures or real ГОСТ PDFs into the same Document contract.

    fmt: "auto" (pdf if the dir contains *.pdf, else json) | "json" | "pdf".
    """
    src = Path(src)
    if fmt == "auto":
        fmt = "pdf" if any(src.glob("*.pdf")) else "json"
    if fmt == "pdf":
        from .ingest.pdf import load_pdf_documents  # lazy: don't import pdfplumber unless used

        return load_pdf_documents(src, registry_path)
    return load_documents(src)


def _chunk_id(gost_id: str, clause_path: str) -> str:
    return str(uuid.uuid5(_CHUNK_NS, f"{gost_id}::{clause_path}"))


def chunk_documents(docs: list[Document]) -> list[Chunk]:
    chunks: list[Chunk] = []
    for doc in docs:
        for clause in doc.clauses:
            # Prefix a small header so dense retrieval has document/clause context.
            header = f"{doc.gost_id}. {doc.title}. п. {clause.clause_path} {clause.title}".strip()
            chunks.append(
                Chunk(
                    id=_chunk_id(doc.gost_id, clause.clause_path),
                    gost_id=doc.gost_id,
                    clause_path=clause.clause_path,
                    title=clause.title,
                    industry=doc.industry,
                    text=f"{header}\n{clause.text}",
                )
            )
    return chunks


def clause_text(chunks: list[Chunk], gost_id: str, clause_path: str) -> str | None:
    for ch in chunks:
        if ch.gost_id == gost_id and ch.clause_path == clause_path:
            return ch.text
    return None

"""Index the corpus into Qdrant — JSON fixtures or real ГОСТ PDFs; dense or hybrid.

Usage:
    uv run python scripts/index_corpus.py                       # JSON fixtures (default), dense
    uv run python scripts/index_corpus.py --src data/gost_pdfs  # real PDFs (auto-detected)
    uv run python scripts/index_corpus.py --hybrid              # dense+BM25 → '<collection>_hybrid'
"""

from __future__ import annotations

import typer

from gost_rag.agent import FIXTURES
from gost_rag.config import ROOT, load_settings
from gost_rag.corpus import chunk_documents, load_corpus
from gost_rag.embeddings import Embedder
from gost_rag.sparse import Bm25Encoder
from gost_rag.store import Store

app = typer.Typer(add_completion=False)


@app.command()
def main(
    src: str = typer.Option(str(FIXTURES), "--src", help="каталог с *.json фикстурами или *.pdf"),
    fmt: str = typer.Option("auto", "--format", help="auto | json | pdf"),
    registry: str = typer.Option(
        str(ROOT / "data" / "registry.yaml"), "--registry",
        help="(pdf) карта gost_id → industry/title/year",
    ),
    hybrid: bool = typer.Option(False, "--hybrid", help="индексировать гибридную (dense+BM25) коллекцию"),
) -> None:
    settings = load_settings()
    docs = load_corpus(src, fmt=fmt, registry_path=registry)
    chunks = chunk_documents(docs)
    sparse = Bm25Encoder().fit([c.text for c in chunks]) if hybrid else None  # fit BM25 on the corpus
    store = Store(settings.qdrant_url, settings.qdrant_collection, Embedder(settings), sparse=sparse)
    store.reset()
    n = store.index(chunks)
    mode = "hybrid (dense+BM25)" if hybrid else "dense"
    print(f"indexed {n} chunks from {len(docs)} documents [{mode}]")


if __name__ == "__main__":
    app()

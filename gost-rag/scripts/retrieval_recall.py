"""Retrieval-ONLY recall benchmark — no generation/judge (recall is purely retrieval). Fast: just
query embeddings. Sweeps top_k / hybrid / diversify to find what lifts DOCUMENT-level recall — the
precision ceiling for this corpus (single-doc questions already recall 1.0; multi-doc ones ~0.56).

    uv run python scripts/retrieval_recall.py
"""

from __future__ import annotations

import yaml

from gost_rag.config import ROOT, load_settings
from gost_rag.embeddings import Embedder
from gost_rag.sparse import Bm25Encoder
from gost_rag.store import Store


def doc_recall(hits, expected) -> float | None:
    if not expected:
        return None
    ctx_ids = {h.chunk.gost_id for h in hits}
    return sum(1 for e in expected if e["gost_id"] in ctx_ids) / len(expected)


def main() -> None:
    s = load_settings()
    gold = [q for q in yaml.safe_load((ROOT / "eval" / "gold.yaml").read_text(encoding="utf-8"))
            if q.get("expects_answer", True)]
    emb = Embedder(s)
    dense = Store(s.qdrant_url, s.qdrant_collection, emb)
    hybrid = Store(s.qdrant_url, s.qdrant_collection, emb, sparse=Bm25Encoder())

    configs = [
        ("dense k8",       dense,  {"top_k": 8}),
        ("dense k16",      dense,  {"top_k": 16}),
        ("dense k24",      dense,  {"top_k": 24}),
        ("dense+div k8",   dense,  {"top_k": 8, "diversify": True}),
        ("dense+div k16",  dense,  {"top_k": 16, "diversify": True}),
        ("hybrid k8",      hybrid, {"top_k": 8}),
        ("hybrid+div k8",  hybrid, {"top_k": 8, "diversify": True}),
        ("hybrid+div k16", hybrid, {"top_k": 16, "diversify": True}),
    ]
    print(f"{'config':<16}{'recall':>8}{'multihop':>10}{'recommend':>11}{'docs/q':>8}")
    print("-" * 53)
    for name, store, kw in configs:
        rec, mh, rc, ndocs = [], [], [], []
        for q in gold:
            hits = store.search(q["query"], **kw)
            r = doc_recall(hits, q["expected"])
            rec.append(r)
            ndocs.append(len({h.chunk.gost_id for h in hits}))
            (mh if q.get("type") == "multihop" else rc).append(r)
        print(f"{name:<16}{sum(rec) / len(rec):>8.2f}{sum(mh) / len(mh):>10.2f}"
              f"{sum(rc) / len(rc):>11.2f}{sum(ndocs) / len(ndocs):>8.1f}")


if __name__ == "__main__":
    main()

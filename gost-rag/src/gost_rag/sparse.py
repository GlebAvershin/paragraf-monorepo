"""BM25 sparse vectors for hybrid retrieval (Stream D1) — pure, no service, unit-testable.

Hybrid = dense (Qwen3 embeddings) + this sparse BM25 channel, fused in Qdrant. BM25 plugs the
dense model's weak spot: exact tokens — numeric clause refs ("5.2.1.3"), codes, rare terms.

Trick that avoids any query-time persistence: document vectors bake the full BM25 weight
(idf · tf-saturation) into each term, and query vectors are BINARY (1.0 per present term). Their
dot product then equals the BM25 score of the query against the document. So only INDEX-time
needs corpus stats (fit); query encoding is stateless. Term ids are a stable crc32 hash (uint32,
Qdrant-compatible) — collisions are rare for a clause-sized vocab and merely sum weights.
"""

from __future__ import annotations

import math
import re
import zlib
from collections import Counter

_TOKEN_RE = re.compile(r"\w+", re.UNICODE)


def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if len(t) > 1]


def term_id(token: str) -> int:
    """Stable uint32 index for a token (crc32 is deterministic across processes)."""
    return zlib.crc32(token.encode("utf-8"))


def sparse_dot(a: dict, b: dict) -> float:
    """Dot product of two {indices, values} sparse vectors (for tests / local scoring)."""
    bm = dict(zip(b["indices"], b["values"]))
    return sum(v * bm.get(i, 0.0) for i, v in zip(a["indices"], a["values"]))


class Bm25Encoder:
    """fit() on the corpus, encode_document() for indexing (weighted), encode_query() is static."""

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1, self.b = k1, b
        self._idf: dict[str, float] = {}
        self._avgdl: float = 0.0

    def fit(self, texts: list[str]) -> "Bm25Encoder":
        n_docs = len(texts)
        df: Counter[str] = Counter()
        total_len = 0
        for text in texts:
            toks = tokenize(text)
            total_len += len(toks)
            df.update(set(toks))
        self._avgdl = (total_len / n_docs) if n_docs else 0.0
        # Robertson/Spärck-Jones idf with +1 so it stays positive even for very common terms.
        self._idf = {tok: math.log(1 + (n_docs - n + 0.5) / (n + 0.5)) for tok, n in df.items()}
        return self

    def idf(self, token: str) -> float:
        return self._idf.get(token, 0.0)

    def encode_document(self, text: str) -> dict:
        toks = tokenize(text)
        dl = len(toks)
        tf = Counter(toks)
        weights: dict[int, float] = {}
        for tok, f in tf.items():
            idf = self._idf.get(tok, 0.0)
            denom = f + self.k1 * (1 - self.b + self.b * dl / self._avgdl) if self._avgdl else (f + self.k1)
            w = idf * (f * (self.k1 + 1)) / denom if denom else 0.0
            if w > 0:
                idx = term_id(tok)
                weights[idx] = weights.get(idx, 0.0) + w  # hash collision → sum (rare)
        return {"indices": list(weights.keys()), "values": list(weights.values())}

    @staticmethod
    def encode_query(text: str) -> dict:
        """Binary query vector — stateless (no fit needed at query time)."""
        idxs = {term_id(tok) for tok in tokenize(text)}
        return {"indices": list(idxs), "values": [1.0] * len(idxs)}

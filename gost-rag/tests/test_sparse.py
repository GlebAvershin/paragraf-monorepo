"""Unit tests for the BM25 sparse encoder (Stream D1) — pure, no Qdrant/network."""

from __future__ import annotations

from gost_rag.sparse import Bm25Encoder, sparse_dot, term_id, tokenize

DOCS = [
    "Размеры полей документа: левое 20 мм, правое 10 мм.",
    "Размеры шрифтов в документе: 12, 13, 14.",
    "Нумерация страниц документа арабскими цифрами.",
]


def test_tokenize_drops_single_chars_and_lowercases():
    toks = tokenize("Поля A4 — 20 мм")
    assert "поля" in toks and "20" in toks and "мм" in toks
    assert "a4" in toks
    assert all(len(t) > 1 for t in toks)  # the stray "—"/single chars are gone


def test_term_id_is_stable():
    assert term_id("поля") == term_id("поля")
    assert term_id("поля") != term_id("шрифт")


def test_idf_rarer_term_scores_higher():
    enc = Bm25Encoder().fit(DOCS)
    # "документа" appears in all 3 docs; "левое" in 1 → rarer term has higher idf
    assert enc.idf("левое") > enc.idf("документа") > 0


def test_query_vector_is_binary_and_stateless():
    sv = Bm25Encoder.encode_query("левое поле")  # static — no fit needed
    assert set(sv["values"]) == {1.0}
    assert len(sv["indices"]) == len(set(sv["indices"]))


def test_hybrid_score_ranks_doc_with_query_terms_higher():
    enc = Bm25Encoder().fit(DOCS)
    q = Bm25Encoder.encode_query("левое поле")
    d0 = enc.encode_document(DOCS[0])  # contains "левое", "поле"/"полей"
    d1 = enc.encode_document(DOCS[1])  # contains neither
    assert sparse_dot(q, d0) > sparse_dot(q, d1)


def test_unknown_query_term_scores_zero():
    enc = Bm25Encoder().fit(DOCS)
    q = Bm25Encoder.encode_query("безопасность электрооборудования")  # not in corpus
    assert sparse_dot(q, enc.encode_document(DOCS[0])) == 0.0


def test_empty_corpus_does_not_crash():
    enc = Bm25Encoder().fit([])  # no idf, avgdl=0 → zero weights, but must not raise
    assert enc.encode_document("любой текст")["indices"] == []

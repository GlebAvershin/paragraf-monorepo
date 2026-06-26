"""ГОСТ Q&A agent — prototype.

Pluggable pipeline: ingest -> chunk -> index -> retrieve -> generate -> validate,
with two swappable answer strategies (RAG, RLM) behind one interface, plus an
eval harness to compare strategies x models x ablations on quality / cost / latency.
"""

__all__ = ["__version__"]
__version__ = "0.1.0"

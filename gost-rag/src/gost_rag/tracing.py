"""Optional Langfuse tracing — a NO-OP unless langfuse is installed AND LANGFUSE_* env is set.

So the synthetic benchmark runs with zero tracing setup; enable per-call cost/latency
visibility (critical once multi-agent strategies fan out into many sub-calls) with
`uv sync --extra trace` + LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY.

The actual emission is wrapped defensively: the exact Langfuse SDK call differs across
v2/v3, so a signature mismatch silently disables tracing rather than breaking a run.
Verify the payload against your installed langfuse version when you turn this on.
"""

from __future__ import annotations

import os


class _Noop:
    enabled = False

    def generation(self, **_kw) -> None: ...

    def flush(self) -> None: ...


class _Langfuse:
    enabled = True

    def __init__(self, client) -> None:
        self._c = client

    def generation(self, *, name: str, model: str, prompt: str, output: str,
                   prompt_tokens: int, completion_tokens: int, latency_s: float) -> None:
        try:  # best-effort; never let tracing break the actual model call
            self._c.generation(
                name=name, model=model, input=prompt, output=output,
                usage_details={"input": prompt_tokens, "output": completion_tokens},
                metadata={"latency_s": latency_s},
            )
        except Exception:  # noqa: BLE001 — tracing is non-critical
            pass

    def flush(self) -> None:
        try:
            self._c.flush()
        except Exception:  # noqa: BLE001
            pass


def get_tracer():
    """Return a Langfuse tracer if installed + configured, else a no-op."""
    if not (os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")):
        return _Noop()
    try:  # construction included — a misconfigured/incompatible SDK must NOT break model calls
        from langfuse import Langfuse  # type: ignore[import-not-found]

        return _Langfuse(Langfuse())
    except Exception:  # noqa: BLE001 — extra not installed or client init failed
        return _Noop()

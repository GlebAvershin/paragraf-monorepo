#!/usr/bin/env bash
# Smoke-test the Gateway: make a real Claude call through it using a virtual key.
# Usage: VIRTUAL_KEY=sk-... ./scripts/smoke-test.sh

set -euo pipefail

if [ -z "${VIRTUAL_KEY:-}" ]; then
  echo "ERROR: set VIRTUAL_KEY env var (sk-... returned by create-test-key.sh)" >&2
  exit 1
fi

HOST="${LITELLM_HOST:-http://localhost:4000}"

echo "Smoke test: $HOST  model: claude-sonnet"
echo

# NOTE: LiteLLM /v1/messages parses model correctly only when auth comes via
# Authorization: Bearer (not x-api-key). For opencode integration, we'll
# override the Anthropic provider's auth to Bearer when baseURL points here.
curl -sS -X POST "$HOST/v1/messages" \
  -H "Authorization: Bearer $VIRTUAL_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet",
    "max_tokens": 100,
    "messages": [
      {"role": "user", "content": "Скажи коротко (одно предложение) что ты Claude и какая сейчас дата."}
    ]
  }'
echo

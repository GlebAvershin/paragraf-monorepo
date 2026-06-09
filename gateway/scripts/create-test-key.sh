#!/usr/bin/env bash
# Create a test virtual key for smoke testing.
# Usage: ./scripts/create-test-key.sh [budget_usd]
# Default budget: $5

set -euo pipefail

# Load .env
if [ -f .env ]; then
  set -o allexport
  # shellcheck source=/dev/null
  source .env
  set +o allexport
fi

if [ -z "${LITELLM_MASTER_KEY:-}" ]; then
  echo "ERROR: LITELLM_MASTER_KEY not set. Source .env first or set in shell." >&2
  exit 1
fi

BUDGET="${1:-5}"
USER_ID="${USER_ID:-test-user-$(date +%s)}"
HOST="${LITELLM_HOST:-http://localhost:4000}"

echo "Creating virtual key:"
echo "  host:      $HOST"
echo "  user_id:   $USER_ID"
echo "  max_budget: \$$BUDGET"
echo

curl -sS -X POST "$HOST/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "user_id": "$USER_ID",
  "key_alias": "smoke-test-$USER_ID",
  "max_budget": $BUDGET,
  "budget_duration": "30d",
  "models": ["claude-sonnet", "claude-opus", "claude-haiku", "gpt-4o", "gpt-4o-mini", "gigachat-pro", "gigachat-max", "gigachat-lite"],
  "rpm_limit": 30,
  "tpm_limit": 200000,
  "metadata": {
    "source": "smoke-test"
  }
}
EOF
echo

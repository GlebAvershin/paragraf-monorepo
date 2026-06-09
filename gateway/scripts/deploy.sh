#!/usr/bin/env bash
# gateway/scripts/deploy.sh — обновить и перезапустить Gateway (ТЗ-06).
#
# Используется CI или вручную из SSH:
#   cd /opt/gateway && ./scripts/deploy.sh
#
# Шаги: git pull → docker pull → docker compose up -d --force-recreate → health-check.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "[deploy] git pull"
git pull --ff-only origin prod

echo "[deploy] docker compose pull"
docker compose -f docker-compose.prod.yml --env-file .env.prod pull

echo "[deploy] docker compose up -d --force-recreate"
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate

echo "[deploy] waiting 20s for warm-up..."
sleep 20

# Health-check.
DOMAIN="$(grep -E '^GATEWAY_DOMAIN=' .env.prod | head -n1 | cut -d= -f2)"
HEALTH_URL="https://${DOMAIN}/health/liveliness"
echo "[deploy] health-check: $HEALTH_URL"
if ! curl -fsSL --max-time 10 "$HEALTH_URL" | grep -q -i 'alive'; then
  echo "[deploy] HEALTH-CHECK FAILED — review logs:"
  docker compose -f docker-compose.prod.yml logs --tail=80 litellm
  exit 1
fi

echo "[deploy] OK"

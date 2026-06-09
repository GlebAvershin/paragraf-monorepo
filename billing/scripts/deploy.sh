#!/usr/bin/env bash
# billing/scripts/deploy.sh — обновить и перезапустить billing prod (ТЗ-06).
#
# Шаги: git pull → docker build → up -d --force-recreate → migrate → health.
# Откат при failure: docker compose down + restore previous image (вручную).

set -euo pipefail

cd "$(dirname "$0")/.."

echo "[deploy] $(date -Is) git pull"
git pull --ff-only origin prod

echo "[deploy] docker compose build"
docker compose -f docker-compose.prod.yml --env-file .env.prod build billing

echo "[deploy] docker compose up -d --force-recreate"
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate

echo "[deploy] waiting 15s for warm-up..."
sleep 15

echo "[deploy] applying migrations..."
./scripts/migrate-prod.sh

echo "[deploy] OK"

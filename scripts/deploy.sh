#!/usr/bin/env bash
# scripts/deploy.sh — обновить и перезапустить весь прод-стек монорепо
# (web-статика + engine + billing) на YC-сервере.
#
# Используется CI (deploy.yml) или вручную из SSH:
#   cd /opt/isaak && ./scripts/deploy.sh
#
# Шаги: git pull → собрать web-статику → docker build → up -d --force-recreate
# → миграции billing → health-check. Останавливается на первой ошибке (set -e).
# Откат при failure: `git checkout <previous-sha> && ./scripts/deploy.sh`.

set -euo pipefail
cd "$(dirname "$0")/.."

# Non-interactive SSH-сессии (в т.ч. `ssh host "cmd"` из GitHub Actions deploy.yml)
# НЕ грузят ~/.bashrc → bun не резолвится в PATH ("command not found"), скрипт
# падает на build-static.sh сразу после git pull (поймано на первом реальном
# автодеплое — git pull прошёл, дальше тишина, контейнеры не пересоздались).
export PATH="$HOME/.bun/bin:$HOME/.yc/bin:$PATH"

echo "[deploy] $(date -Is) git pull"
git pull --ff-only origin main

echo "[deploy] ensure shared docker network exists (idempotent)"
docker network create isaak_shared 2>/dev/null || true

# Секреты — источник правды в YC Lockbox (см. DEPLOY.md §9), .env.prod на диске
# лишь материализуется перед каждым деплоем. Если Lockbox недоступен (сеть/yc
# не настроен) — деградируем на уже лежащий .env.prod, а не роняем деплой.
echo "[deploy] fetching secrets from YC Lockbox"
if ./scripts/env-from-yc-lockbox.sh e6qivjcq5hr65l6qui8p > .env.prod.new 2>/tmp/lockbox-fetch.err; then
  mv .env.prod.new .env.prod
  chmod 600 .env.prod
  echo "[deploy] .env.prod refreshed from Lockbox"
else
  rm -f .env.prod.new
  echo "[deploy] WARNING: Lockbox fetch failed, keeping existing .env.prod:"
  cat /tmp/lockbox-fetch.err >&2 || true
fi

echo "[deploy] build web static"
./scripts/build-static.sh

echo "[deploy] docker compose build"
docker compose -f docker-compose.prod.yml --env-file .env.prod build

echo "[deploy] docker compose up -d --force-recreate"
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate

echo "[deploy] waiting 15s for warm-up..."
sleep 15

echo "[deploy] applying migrations + health-check..."
./scripts/migrate-prod.sh

echo "[deploy] OK"

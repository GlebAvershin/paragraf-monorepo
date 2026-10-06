#!/usr/bin/env bash
# scripts/migrate-prod.sh — применить billing-миграции к prod-БД + health-check.
#
# КРИТИЧНО (урок из CLAUDE.md): миграция, не применённая к prod-БД, роняет
# эндпоинты в 500. ОБЯЗАН быть в deploy-pipeline (см. deploy.sh).
#
# Engine схему создаёт сам при старте (initSchema, CREATE TABLE IF NOT EXISTS) —
# отдельного шага не требует.

set -euo pipefail
cd "$(dirname "$0")/.."

# Non-interactive SSH-сессии не грузят ~/.bashrc → bun не в PATH (см. deploy.sh).
# Здесь bunx фактически не используется на хосте (запускается внутри контейнера
# через docker compose exec), но держим для консистентности/автономного запуска.
export PATH="$HOME/.bun/bin:$PATH"

set -a; source .env.prod; set +a

echo "[migrate] $(date -Is) start"

# 1. Drizzle авто-миграции (если есть — db:push --force в проде НЕ запускаем,
#    он сносит данные; только generate+migrate).
if [ -d "./billing/drizzle" ] && ls ./billing/drizzle/*.sql >/dev/null 2>&1; then
  echo "[migrate] applying drizzle migrations..."
  docker compose -f docker-compose.prod.yml exec -T billing \
    bunx drizzle-kit migrate || {
      echo "[migrate] drizzle-kit migrate FAILED"
      exit 2
    }
fi

# 2. Manual SQL миграции (billing/drizzle/manual/*.sql), по дате имени файла.
if [ -d "./billing/drizzle/manual" ]; then
  for sql in $(ls -1 ./billing/drizzle/manual/*.sql 2>/dev/null | sort); do
    NAME=$(basename "$sql")
    echo "[migrate] applying manual: $NAME"
    docker compose -f docker-compose.prod.yml exec -T postgres_billing \
      psql -U billing -d billing -v ON_ERROR_STOP=1 < "$sql" >/dev/null || {
        echo "[migrate] manual migration FAILED: $NAME"
        exit 3
      }
  done
fi

# 3. Refresh tariff catalog and virtual-key model access for existing users.
echo "[migrate] refreshing model catalog and virtual-key access..."
docker compose -f docker-compose.prod.yml exec -T billing bun run db:seed
docker compose -f docker-compose.prod.yml exec -T billing bun run sync-model-access

# 4. Verify health — через внутреннюю docker-сеть (не зависит от готовности
#    DNS/TLS на публичном домене на момент миграции).
echo "[migrate] verifying readiness..."
sleep 3

if ! docker compose -f docker-compose.prod.yml exec -T billing \
    curl -fsS http://localhost:3000/health/readiness | grep -q '"ok"'; then
  echo "[migrate] billing readiness FAILED — review logs:"
  docker compose -f docker-compose.prod.yml logs --tail=80 billing
  exit 4
fi

if ! docker compose -f docker-compose.prod.yml exec -T engine \
    curl -fsS http://localhost:4096/health/liveliness | grep -qi 'alive'; then
  echo "[migrate] engine readiness FAILED — review logs:"
  docker compose -f docker-compose.prod.yml logs --tail=80 engine
  exit 5
fi

echo "[migrate] OK"

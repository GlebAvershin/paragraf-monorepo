#!/usr/bin/env bash
# billing/scripts/migrate-prod.sh — применить миграции к prod-БД (ТЗ-06 §5).
#
# КРИТИЧНО (урок из CLAUDE.md): миграция, не применённая к prod-БД, роняет
# эндпоинты в 500. Этот скрипт ОБЯЗАН быть в deploy-pipeline.
#
# Подход:
#   - drizzle-kit для автоматических миграций (drizzle/*.sql)
#   - manual SQL для нестандартных (drizzle/manual/*.sql, применяются по дате)
#
# После — verify health.

set -euo pipefail

cd "$(dirname "$0")/.."

set -a; source .env.prod; set +a

echo "[migrate] $(date -Is) start"

# 1. Drizzle авто-миграции через drizzle-kit (если используются).
#    db:push --force в проде НЕ запускаем — он сносит данные. Только generate+migrate.
if [ -d "./drizzle" ] && ls ./drizzle/*.sql >/dev/null 2>&1; then
  echo "[migrate] applying drizzle migrations..."
  docker compose -f docker-compose.prod.yml exec -T billing \
    bunx drizzle-kit migrate || {
      echo "[migrate] drizzle-kit migrate FAILED"
      exit 2
    }
fi

# 2. Manual SQL миграции (drizzle/manual/*.sql). Применяются по дате имени файла.
#    Идемпотентность — на ответственности автора SQL (CREATE TABLE IF NOT EXISTS, и т.п.).
if [ -d "./drizzle/manual" ]; then
  for sql in $(ls -1 ./drizzle/manual/*.sql 2>/dev/null | sort); do
    NAME=$(basename "$sql")
    echo "[migrate] applying manual: $NAME"
    docker compose -f docker-compose.prod.yml exec -T postgres \
      psql -U billing -d billing -v ON_ERROR_STOP=1 < "$sql" >/dev/null || {
        echo "[migrate] manual migration FAILED: $NAME"
        exit 3
      }
  done
fi

# 3. Verify health.
echo "[migrate] verifying readiness..."
sleep 3
DOMAIN="$(grep -E '^BILLING_DOMAIN=' .env.prod | head -n1 | cut -d= -f2)"
HEALTH_URL="https://${DOMAIN}/health/readiness"
if ! curl -fsSL --max-time 10 "$HEALTH_URL" | grep -q '"ok"'; then
  echo "[migrate] readiness FAILED — review logs:"
  docker compose -f docker-compose.prod.yml logs --tail=80 billing
  exit 4
fi

echo "[migrate] OK"

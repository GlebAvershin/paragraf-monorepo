#!/usr/bin/env bash
# scripts/backup.sh — pg_dump БД billing + engine → S3 (РФ!).
#
# КРИТИЧНО: бэкапы содержат ПДн (billing: users.email/payments.*; engine: сырая
# история чатов). Уезжают только на РФ-S3 (Selectel/Yandex). НИКОГДА не на
# зарубежные провайдеры.
#
# Запуск из cron (ежедневно):
#   0 2 * * * cd /opt/isaak && ./scripts/backup.sh >> /var/log/isaak-backup.log 2>&1
#
# Ретеншн: 30 дней локально, 90 дней в S3 (152-ФЗ).

set -euo pipefail
cd "$(dirname "$0")/.."

set -a; source .env.prod; set +a

STAMP=$(date +%Y-%m-%d_%H-%M-%S)

dump_db() {
  local service="$1" db="$2" user="$3"
  local dir="./backups/$db"
  local file="$dir/${db}_${STAMP}.sql.gz"
  mkdir -p "$dir"

  echo "[$(date -Is)] backup $db: $file"
  docker compose -f docker-compose.prod.yml exec -T "$service" \
    pg_dump -U "$user" -d "$db" --no-owner --no-acl \
    | gzip -9 > "$file"

  local size
  size=$(du -h "$file" | cut -f1)
  echo "[$(date -Is)] $db dump done, size=$size"

  # Sanity-check — базовая проверка непустого дампа.
  if ! gzip -dc "$file" | grep -q 'CREATE TABLE'; then
    echo "[$(date -Is)] ERROR: $db dump has no CREATE TABLE — failing!"
    exit 2
  fi

  if [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
    AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" \
      AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
      aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
      s3 cp "$file" "s3://$BACKUP_S3_BUCKET/$db/$(basename "$file")"
    echo "[$(date -Is)] uploaded to s3://$BACKUP_S3_BUCKET/$db/"
  else
    echo "[$(date -Is)] WARN: S3 not configured, dump kept locally only"
  fi

  find "$dir" -type f -name "${db}_*.sql.gz" -mtime +30 -delete
}

dump_db postgres_billing billing billing
dump_db postgres_engine engine engine

echo "[$(date -Is)] backup done"

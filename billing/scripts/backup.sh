#!/usr/bin/env bash
# billing/scripts/backup.sh — pg_dump БД billing → S3 (РФ!) (ТЗ-06 §5).
#
# КРИТИЧНО: бэкапы содержат ПДн (users.email, payments.*, magic_link_tokens).
# Уезжают только на РФ-S3 (Selectel/Yandex). НИКОГДА не на зарубежные провайдеры.
#
# Запуск из cron (ежедневно):
#   0 2 * * * cd /opt/billing && ./scripts/backup.sh >> /var/log/billing-backup.log 2>&1
#
# Ретеншн: 30 дней локально, 90 дней в S3 (по требованию 152-ФЗ согласие пересмотра).

set -euo pipefail

cd "$(dirname "$0")/.."

set -a; source .env.prod; set +a

STAMP=$(date +%Y-%m-%d_%H-%M-%S)
DUMP_DIR="./backups"
DUMP_FILE="$DUMP_DIR/billing_${STAMP}.sql.gz"

mkdir -p "$DUMP_DIR"

echo "[$(date -Is)] billing backup: $DUMP_FILE"

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U billing -d billing --no-owner --no-acl \
  | gzip -9 > "$DUMP_FILE"

SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "[$(date -Is)] dump done, size=$SIZE"

# Sanity-check: проверка что в бэкапе есть ожидаемые таблицы.
if ! gzip -dc "$DUMP_FILE" | grep -q 'CREATE TABLE.*users'; then
  echo "[$(date -Is)] ERROR: dump does not contain users table — failing!"
  exit 2
fi

# Upload в РФ-S3.
if [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
  AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
    aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
    s3 cp "$DUMP_FILE" "s3://$BACKUP_S3_BUCKET/billing/$(basename "$DUMP_FILE")"
  echo "[$(date -Is)] uploaded to s3://$BACKUP_S3_BUCKET/billing/"
else
  echo "[$(date -Is)] WARN: S3 not configured, dump kept locally only"
fi

# Локальный ретеншн — 30 дней.
find "$DUMP_DIR" -type f -name "billing_*.sql.gz" -mtime +30 -delete

echo "[$(date -Is)] backup done"

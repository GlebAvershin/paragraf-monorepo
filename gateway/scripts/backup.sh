#!/usr/bin/env bash
# gateway/scripts/backup.sh — pg_dump → S3 (ТЗ-06 §4).
#
# Запуск из cron (ежедневно):
#   0 3 * * * cd /opt/gateway && ./scripts/backup.sh >> /var/log/gateway-backup.log 2>&1
#
# Требования: docker, awscli/rclone (для S3 upload), .env.prod.
#
# Бэкапы хранятся 30 дней — скрипт удаляет старые.

set -euo pipefail

cd "$(dirname "$0")/.."

# Загружаем env
set -a; source .env.prod; set +a

STAMP=$(date +%Y-%m-%d_%H-%M-%S)
DUMP_DIR="./backups"
DUMP_FILE="$DUMP_DIR/litellm_${STAMP}.sql.gz"

mkdir -p "$DUMP_DIR"

echo "[$(date -Is)] gateway backup: $DUMP_FILE"

# pg_dump через docker exec (контейнер уже живой)
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U litellm -d litellm --no-owner --no-acl \
  | gzip -9 > "$DUMP_FILE"

SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "[$(date -Is)] dump done, size=$SIZE"

# Upload в S3 (вне РФ — gateway не содержит ПДн).
if [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
  AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" \
    aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
    s3 cp "$DUMP_FILE" "s3://$BACKUP_S3_BUCKET/litellm/$(basename "$DUMP_FILE")"
  echo "[$(date -Is)] uploaded to s3://$BACKUP_S3_BUCKET/"
else
  echo "[$(date -Is)] S3 not configured, dump kept locally only"
fi

# Чистка старых локальных бэкапов (>30 дней)
find "$DUMP_DIR" -type f -name "litellm_*.sql.gz" -mtime +30 -delete

echo "[$(date -Is)] backup done"

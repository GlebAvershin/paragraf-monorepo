#!/usr/bin/env bash
# scripts/env-from-yc-lockbox.sh — собрать .env.prod из секрета YC Lockbox.
#
# Секреты живут в YC Lockbox (не в файле на диске как единственная копия) —
# при деплое достаём их и материализуем в .env.prod непосредственно перед
# `docker compose up`. docker-compose.prod.yml/deploy.sh как читали .env.prod,
# так и продолжают — эта прослойка их не касается.
#
# Требует авторизованный `yc` CLI на машине, где запускается (см. DEPLOY.md §9):
#   yc config set service-account-key <путь к JSON-ключу sa isaac-deploy-lockbox>
#
# Секреты НЕ содержат ключей с пустым значением (Lockbox их не принимает) —
# если переменная в .env.prod.example опциональна и не задана, её просто нет
# в секрете. Это эквивалентно отсутствию в .env.prod (код читает через ??).
#
# Использование:
#   ./scripts/env-from-yc-lockbox.sh <secret-id> > .env.prod

set -euo pipefail

SECRET_ID="${1:?Usage: env-from-yc-lockbox.sh <secret-id> > .env.prod}"

export PATH="$HOME/.yc/bin:$PATH"

if ! command -v yc >/dev/null 2>&1; then
  echo "[env-from-yc-lockbox] ERROR: yc CLI не найден в PATH (\$HOME/.yc/bin)." >&2
  exit 1
fi

yc lockbox payload get --id "$SECRET_ID" --format json | python3 -c '
import json, sys

data = json.load(sys.stdin)
for entry in data.get("entries", []):
    key = entry.get("key", "")
    value = entry.get("text_value", "")
    if not key:
        continue
    print(f"{key}={value}")
'

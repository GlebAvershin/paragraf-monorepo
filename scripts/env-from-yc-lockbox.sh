#!/usr/bin/env bash
# scripts/env-from-yc-lockbox.sh — собрать .env.prod из секретов YC Lockbox.
#
# ⚠️ ЗАГОТОВКА, НЕ ПРОВЕРЕНА ЖИВЬЁМ — писалась без доступа к YC (нет аккаунта/CLI
# на момент написания). Перед первым реальным использованием прогнать вручную и
# свериться построчно с .env.prod.example — команда `yc lockbox payload get`
# может отличаться версией CLI/форматом вывода.
#
# Идея: секреты живут в YC Lockbox (а не в файле на диске/GitHub Secrets), этот
# скрипт на каждый деплой достаёт их и материализует в .env.prod непосредственно
# перед `docker compose up` — сам docker-compose.prod.yml/deploy.sh переписывать
# не нужно, они как читали .env.prod, так и продолжают.
#
# Подготовка (сделать один раз, руками, когда будет доступ к YC):
#   1. yc lockbox secret create --name isaak-prod-env
#   2. Добавить в секрет по одному ключу на каждую переменную из .env.prod.example
#      (yc lockbox secret add-version --name isaak-prod-env --payload '[{"key":"JWT_SECRET","text_value":"..."}]')
#   3. Дать сервисному аккаунту деплоя роль lockbox.payloadViewer на секрет.
#   4. Прописать YC_LOCKBOX_SECRET_ID в GitHub Secrets (id секрета, не сами значения).
#
# Использование (перед deploy.sh, требует установленный+авторизованный `yc` CLI
# на сервере или в CI-раннере с сервисным ключом):
#   ./scripts/env-from-yc-lockbox.sh > .env.prod

set -euo pipefail

SECRET_ID="${YC_LOCKBOX_SECRET_ID:?Не задан YC_LOCKBOX_SECRET_ID}"

if ! command -v yc >/dev/null 2>&1; then
  echo "[env-from-yc-lockbox] ERROR: yc CLI не найден. Установка:" >&2
  echo "  curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash" >&2
  exit 1
fi

echo "[env-from-yc-lockbox] fetching payload for secret $SECRET_ID" >&2

# yc lockbox payload get отдаёт JSON {"entries":[{"key":"...","text_value":"..."}]}.
# Формат ключей: KEY=value, по одной переменной на строку.
yc lockbox payload get --id "$SECRET_ID" --format json \
  | grep -oE '"key":\s*"[^"]*"\s*,\s*"text_value":\s*"[^"]*"' \
  | sed -E 's/"key":\s*"([^"]*)"\s*,\s*"text_value":\s*"([^"]*)"/\1=\2/'

echo "[env-from-yc-lockbox] done — проверить вывод построчно перед первым прод-запуском" >&2

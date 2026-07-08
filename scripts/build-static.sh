#!/usr/bin/env bash
# scripts/build-static.sh — собрать web-статику перед docker compose up.
#
# Caddy отдаёт web/packages/app/dist напрямую с хоста (volume-mount в
# docker-compose.prod.yml), поэтому сборка идёт ВНЕ Docker — быстрее и не
# требует node_modules внутри caddy-образа.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "[build-static] $(date -Is) bun install (web workspace)"
bun install --cwd web --frozen-lockfile

# Vite запекает VITE_*-переменные в бандл на этапе сборки (не runtime) —
# .env.prod лежит в корне монорепо, а не в web/packages/app, и раньше не
# прокидывался сюда вовсе, поэтому VITE_SENTRY_DSN и любые другие VITE_*
# из Lockbox молча игнорировались сборкой. Найдено 2026-07-08.
echo "[build-static] vite build (web/packages/app)"
if [ -f .env.prod ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.prod
  set +a
fi
bun run --cwd web/packages/app build

echo "[build-static] OK → web/packages/app/dist"

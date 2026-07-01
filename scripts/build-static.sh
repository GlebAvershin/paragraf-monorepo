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

echo "[build-static] vite build (web/packages/app)"
bun run --cwd web/packages/app build

echo "[build-static] OK → web/packages/app/dist"

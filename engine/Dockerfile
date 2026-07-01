# Engine — multi-stage bun production image. Тот же паттерн, что billing/Dockerfile.
#
# Схема БД создаётся сервисом при старте (initSchema, CREATE TABLE IF NOT EXISTS) —
# отдельного migrate-шага, в отличие от billing, не требуется.

# === Stage 1: deps ===
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# === Stage 2: build ===
FROM deps AS build
COPY . .
RUN bun build src/index.ts --outdir dist --target bun --minify

# === Stage 3: runtime ===
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache curl tini

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

ENV NODE_ENV=production
EXPOSE 4096

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD curl -fsS http://localhost:4096/health/liveliness || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "dist/index.js"]

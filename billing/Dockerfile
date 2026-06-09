# Billing service — multi-stage bun production image (ТЗ-06).
#
# Stage 1: deps install (кэшируется по bun.lock)
# Stage 2: minimal runtime — только built bundle + node_modules для drizzle-kit
#
# Размер: ~150MB. На проде запускается через docker-compose.prod.yml.

# === Stage 1: deps ===
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production=false

# === Stage 2: build (drizzle-kit нужен для миграций в runtime) ===
FROM deps AS build
COPY . .
# Bun сам резолвит TS — компиляция не нужна, но проверим типы.
# tsc --noEmit запускаем вне Docker (на CI), здесь только bundle.
RUN bun build src/index.ts --outdir dist --target bun --minify

# === Stage 3: runtime ===
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

# bun-runtime alpine + curl для healthcheck.
RUN apk add --no-cache curl tini

# Копируем production deps + bundle.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/package.json ./package.json

# Драйверы Postgres bun-native.
ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD curl -fsS http://localhost:3000/health/liveliness || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "dist/index.js"]

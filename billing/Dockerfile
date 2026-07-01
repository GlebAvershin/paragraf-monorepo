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
RUN bun install --frozen-lockfile

# === Stage 2: build (drizzle-kit нужен для миграций в runtime) ===
FROM deps AS build
COPY . .
# Bun сам резолвит TS — компиляция не нужна, но проверим типы.
# tsc --noEmit запускаем вне Docker (на CI), здесь только bundle.
# Три entry-точки: сам сервис + 2 воркера (etl/recurrent-retry, см.
# docker-compose.prod.yml — команды billing_etl_worker/billing_retry_worker
# запускают dist/worker/*.js, раньше бандлился только index.ts → "Module not
# found" сразу при старте воркеров).
RUN bun build src/index.ts src/worker/etl.ts src/worker/recurrent-retry.ts \
  --outdir dist --target bun --minify

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
# src/scripts — НЕ бандлится в dist/, но нужен в рантайме: `bun run create-user`
# (провижн кабинетов, см. DEPLOY.md) запускает bun напрямую по TS-исходнику.
COPY --from=build /app/src/scripts ./src/scripts

# Драйверы Postgres bun-native.
ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD curl -fsS http://localhost:3000/health/liveliness || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "dist/index.js"]

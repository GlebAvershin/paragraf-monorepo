/**
 * ETL worker — превращает LiteLLM spend logs в usage_events + списание кредитов.
 *
 * Запуск:
 *   bun run src/worker/etl.ts                   # одна итерация и выход
 *   bun run src/worker/etl.ts --loop --interval=30   # цикл с интервалом 30 сек
 *
 * Алгоритм каждой итерации:
 *   1. Прочитать `last_processed_at` из settings_kv (default = 1 час назад)
 *   2. Запросить /spend/logs у LiteLLM с этой даты
 *   3. Для каждой записи:
 *      - найти subscription по `apiKey` (litellm_key)
 *      - найти model_rate по `model`
 *      - вычислить credits = computeCredits(...)
 *      - вызвать chargeCredits() — атомарно списать
 *   4. Обновить `last_processed_at`
 *
 * Идемпотентность: chargeCredits проверяет existing usage_events.requestId.
 * Если воркер упал/перезапустился — повторное чтение того же лога не страшно.
 *
 * Production-deploy: запустить как systemd service / pm2 / Docker sidecar
 * с интервалом 30-60 сек. Также можно подключить LiteLLM webhook,
 * но pull-модель проще для MVP и устойчивее к downtime.
 */
import { createHash } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { litellm, type SpendLog } from "../litellm/client.ts"
import { chargeCredits, computeCredits } from "../lib/credits.ts"
import { logger } from "../lib/logger.ts"
import { invalidateLimitsCache } from "../routes/limits.ts"

const SETTING_KEY = "etl.spend.last_processed_at"
const DEFAULT_LOOKBACK_HOURS = 1
const MAX_BATCH_LOOKBACK_HOURS = 24

interface SettingsRow {
  key: string
  value: { value: string }
}

async function getLastProcessedAt(): Promise<Date> {
  const rows = await db.execute(
    sql`SELECT key, value FROM settings_kv WHERE key = ${SETTING_KEY}`,
  )
  const arr = (rows as unknown as SettingsRow[]) ?? []
  const stored = arr[0]?.value?.value
  if (stored) {
    const d = new Date(stored)
    if (!Number.isNaN(d.getTime())) {
      // Защита от слишком длинного lookback (если воркер долго не работал) —
      // ограничиваем 24 часами, чтобы не унести БД одним батчем.
      const maxBack = new Date(Date.now() - MAX_BATCH_LOOKBACK_HOURS * 3600_000)
      return d < maxBack ? maxBack : d
    }
  }
  return new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 3600_000)
}

async function setLastProcessedAt(at: Date): Promise<void> {
  await db.execute(sql`
    INSERT INTO settings_kv (key, value, updated_at)
    VALUES (${SETTING_KEY}, ${JSON.stringify({ value: at.toISOString() })}::jsonb, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = now()
  `)
}

interface RatesCacheEntry {
  multiplier: number
  tier: string
  pricePer1kInputMicroCenti: number
  pricePer1kOutputMicroCenti: number
  provider: string
}

const ratesCache = new Map<string, RatesCacheEntry>()
let ratesCacheLoadedAt = 0
const RATES_CACHE_TTL_MS = 5 * 60_000

async function loadRates(): Promise<void> {
  if (Date.now() - ratesCacheLoadedAt < RATES_CACHE_TTL_MS) return
  const rows = await db.select().from(schema.modelRates).where(eq(schema.modelRates.isActive, true))
  ratesCache.clear()
  for (const r of rows) {
    ratesCache.set(r.modelCode, {
      multiplier: Number(r.multiplier),
      tier: r.tier,
      pricePer1kInputMicroCenti: r.providerPricePer1kInputUsdMicroCenti,
      pricePer1kOutputMicroCenti: r.providerPricePer1kOutputUsdMicroCenti,
      provider: r.provider,
    })
  }
  ratesCacheLoadedAt = Date.now()
}

interface SubRef {
  subId: string
  userId: string
}

/**
 * Карта sha256(litellmKey) → {subId, userId}.
 *
 * LiteLLM в spend-логах кладёт `api_key` как sha256-хеш виртуального ключа
 * (НЕ сам ключ). Поэтому матчим по хешу, а не по plain litellmKey.
 * Проверено: sha256("sk-...") hex === api_key в /spend/logs.
 * userId нужен для инвалидации кэша /limits после списания.
 */
async function buildKeyHashMap(): Promise<Map<string, SubRef>> {
  const rows = await db
    .select({
      id: schema.subscriptions.id,
      userId: schema.subscriptions.userId,
      key: schema.subscriptions.litellmKey,
    })
    .from(schema.subscriptions)
  const map = new Map<string, SubRef>()
  for (const r of rows) {
    if (!r.key) continue
    const hash = createHash("sha256").update(r.key).digest("hex")
    map.set(hash, { subId: r.id, userId: r.userId })
  }
  return map
}

async function processLog(
  log: SpendLog,
  keyHashMap: Map<string, SubRef>,
): Promise<"skipped" | "charged" | "error"> {
  if (!log.apiKey) return "skipped"
  if (log.status !== "ok") return "skipped" // failure-запросы не списываем

  // log.apiKey — это sha256-хеш виртуального ключа (см. buildKeyHashMap).
  const ref = keyHashMap.get(log.apiKey)
  if (!ref) {
    logger.warn({ apiKeyHash: log.apiKey.slice(0, 12) }, "ETL: subscription not found for litellm key hash")
    return "skipped"
  }
  const sub = { id: ref.subId }

  // model_group — это алиас model_name из litellm-config (= наш model_rates.modelCode,
  // напр. "gigachat-lite"). log.model = внутреннее имя LiteLLM ("gigachat/GigaChat"),
  // которое НЕ матчится с тарифами. Поэтому для rate-lookup и записи берём modelGroup.
  const rateKey = log.modelGroup ?? log.model
  const rate = ratesCache.get(rateKey)
  if (!rate) {
    logger.warn({ model: rateKey }, "ETL: model rate not configured — falling back to 1 credit")
    await chargeCredits({
      subscriptionId: sub.id,
      credits: 1,
      model: rateKey,
      provider: log.provider,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      costUsdMicroCenti: Math.round(log.spendUsd * 1_000_000),
      requestId: log.requestId || null,
    })
    // Сбросить кэш баланса — иначе сайдбар показывает старый остаток до 60с.
    invalidateLimitsCache(ref.userId)
    return "charged"
  }

  const credits = computeCredits({
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    pricePer1kInputMicroCenti: rate.pricePer1kInputMicroCenti,
    pricePer1kOutputMicroCenti: rate.pricePer1kOutputMicroCenti,
    multiplier: rate.multiplier,
    // embedding-тир (gost-rag-ретрив): по факту, без пола 1 кредит — иначе каждый /retrieve
    // снимал бы скрытый кредит (deep-режим — до 5) при себестоимости ~$0.000002.
    floorCredits: rate.tier === "embedding" ? 0 : 1,
  })

  await chargeCredits({
    subscriptionId: sub.id,
    credits,
    model: rateKey,
    provider: rate.provider,
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    costUsdMicroCenti: Math.round(log.spendUsd * 1_000_000),
    requestId: log.requestId || null,
  })

  // Сбросить кэш баланса — иначе сайдбар показывает старый остаток до 60с.
  invalidateLimitsCache(ref.userId)
  return "charged"
}

async function runOnce(): Promise<{ processed: number; charged: number }> {
  await loadRates()
  const from = await getLastProcessedAt()
  const to = new Date()

  // ВАЖНО: НЕ передаём start_date/end_date — с ними LiteLLM /spend/logs
  // возвращает ДНЕВНОЙ АГРЕГАТ (без request_id/api_key), а нам нужны
  // per-request логи. Без date-параметров приходит детальный список.
  // Фильтруем по startedAt клиентски ниже.
  const logs = await litellm.getSpendLogs({ pageSize: 1000 })

  const keyHashMap = await buildKeyHashMap()

  let charged = 0
  let processed = 0
  for (const log of logs) {
    // Клиентский фильтр по времени: обрабатываем только новые с прошлого прохода.
    if (log.startedAt && new Date(log.startedAt) <= from) continue
    processed++
    const result = await processLog(log, keyHashMap).catch((err) => {
      logger.error({ err, requestId: log.requestId }, "ETL: processLog failed")
      return "error" as const
    })
    if (result === "charged") charged++
  }

  await setLastProcessedAt(to)
  return { processed, charged }
}

async function main() {
  const args = process.argv.slice(2)
  const loop = args.includes("--loop")
  const interval = (() => {
    const flag = args.find((a) => a.startsWith("--interval="))
    return flag ? Math.max(5, Number(flag.split("=")[1] ?? 30)) : 30
  })()

  if (!loop) {
    const result = await runOnce()
    logger.info(result, "ETL: one-shot run complete")
    process.exit(0)
  }

  logger.info({ interval }, "ETL: starting loop")
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await runOnce()
      logger.info(result, "ETL: tick complete")
    } catch (err) {
      logger.error({ err }, "ETL: tick failed")
    }
    await new Promise((r) => setTimeout(r, interval * 1000))
  }
}

main().catch((err) => {
  logger.error({ err }, "ETL: fatal")
  process.exit(1)
})

/**
 * Credits routes:
 *   GET  /credits/rates                 — каталог моделей с множителями (для UI dropdown)
 *   POST /credits/preview               — оценка стоимости запроса перед запуском
 *
 * Формула оценки:
 *   credits = ceil(
 *     ((inputTokens / 1000) × providerPriceInputPer1k +
 *      (outputTokens / 1000) × providerPriceOutputPer1k)
 *     / calibrationCostPerCredit
 *     × multiplier
 *   )
 *
 * Где calibrationCostPerCredit — наша внутренняя цена 1 кредита в USD-микроцентах
 * (привязана к Lite-модели как anchor). После пилота калибруется так, чтобы маржа
 * держалась 30-40% над провайдерскими расходами.
 *
 * UI использует это перед `Send` чтобы показать «~12 кредитов · Sonnet 1.5×».
 */
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { requireSession } from "../lib/middleware.ts"

export const creditsRoutes = new Hono()

// Anchor: сколько USD-micro-centi стоит 1 кредит в нашей экономике.
// Калибровка: GigaChat Lite × 1500 in + 500 out tokens ≈ 1 кредит.
// 1500/1000 × 20 + 500/1000 × 60 = 30 + 30 = 60 micro-cents → 0.06 cents = $0.0006
// Округляем до удобного anchor: 1 кредит = 60 micro-cents = $0.0006.
// (После пилота заменим на динамическое значение из таблицы settings.)
const CALIBRATION_COST_PER_CREDIT_MICRO_CENTI = 60

/**
 * Вернуть каталог активных моделей для отображения в UI dropdown.
 * Группирует по tier для удобного рендера.
 */
creditsRoutes.get("/rates", requireSession, async (c) => {
  const rates = await db
    .select()
    .from(schema.modelRates)
    .where(eq(schema.modelRates.isActive, true))

  const grouped: Record<string, Array<{ code: string; nameRu: string; provider: string; multiplier: string }>> = {
    lite: [],
    mid: [],
    top: [],
  }
  for (const r of rates) {
    const bucket = grouped[r.tier]
    if (!bucket) continue // неизвестный tier — пропускаем (защита от рассинхрона enum)
    bucket.push({
      code: r.modelCode,
      nameRu: r.displayNameRu,
      provider: r.provider,
      multiplier: r.multiplier,
    })
  }

  return c.json({
    tiers: {
      lite: { label: "Базовые", description: "Быстрые и дешёвые. Подойдут для коротких задач.", models: grouped.lite },
      mid: {
        label: "Стандарт",
        description: "Универсальные. Подойдут для большинства документов.",
        models: grouped.mid,
      },
      top: {
        label: "Топовые",
        description: "Самые мощные. Для сложного анализа и больших документов.",
        models: grouped.top,
      },
    },
    calibration: {
      tokensPerCredit: { input: 1500, output: 500 },
      note: "1 кредит ≈ обработка ~1 500 токенов входа + 500 токенов ответа на базовой модели",
    },
  })
})

interface PreviewBody {
  modelCode: string
  inputTokens?: number // если не передан — используется calibration default
  outputTokens?: number
}

creditsRoutes.post("/preview", requireSession, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as PreviewBody
  const { modelCode } = body
  if (!modelCode || typeof modelCode !== "string") {
    return c.json({ error: "modelCode_required" }, 400)
  }

  const rateRows = await db
    .select()
    .from(schema.modelRates)
    .where(eq(schema.modelRates.modelCode, modelCode))
    .limit(1)
  const rate = rateRows[0]
  if (!rate || !rate.isActive) {
    return c.json({ error: "model_not_supported" }, 404)
  }

  const inputTokens = body.inputTokens ?? rate.calibrationTokensIn
  const outputTokens = body.outputTokens ?? rate.calibrationTokensOut

  // Провайдерская стоимость запроса в USD micro-centi.
  const providerCost =
    (inputTokens / 1000) * rate.providerPricePer1kInputUsdMicroCenti +
    (outputTokens / 1000) * rate.providerPricePer1kOutputUsdMicroCenti

  // Внутренняя оценка в кредитах с множителем модели.
  const multiplierNum = Number(rate.multiplier)
  const credits = Math.max(
    1,
    Math.ceil((providerCost / CALIBRATION_COST_PER_CREDIT_MICRO_CENTI) * multiplierNum),
  )

  return c.json({
    modelCode,
    tier: rate.tier,
    multiplier: rate.multiplier,
    estimate: {
      credits,
      inputTokens,
      outputTokens,
    },
    providerCostUsd: Number((providerCost / 1_000_000).toFixed(6)),
    note:
      body.inputTokens === undefined
        ? "Оценка по калибровке (точную узнаем после отправки запроса)"
        : "Оценка по переданным токенам",
  })
})

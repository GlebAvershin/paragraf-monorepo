/**
 * Credits ledger — атомарное списание кредитов с подписки.
 *
 * Алгоритм (FIFO по expiresAt):
 *   1. Берём pg advisory lock на subscription (защита от race).
 *   2. Читаем активные credit_grants подписки, сортируем по expiresAt ASC
 *      (сначала те, что скоро сгорят — чтобы юзер не терял оплаченное).
 *   3. Идём по списку, списываем remainingCredits до полного покрытия N.
 *   4. Если grant исчерпался → consumedAt = now.
 *   5. Если кредитов не хватает — пишем negative usage_event с пометкой
 *      'overspend', возвращаем { shortfall: N }.
 *
 * Не блокирует запросы — это post-hoc списание после того как LiteLLM уже
 * выполнил запрос. Hard-cap на абуз — `max_budget` на virtual_key (страховка).
 */
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { logger } from "./logger.ts"

export interface ChargeInput {
  subscriptionId: string
  credits: number // округлённое неотрицательное целое
  /** Доп. метаданные для usage_event. */
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  costUsdMicroCenti: number
  requestId: string | null
  scenarioId?: string | null
}

export interface ChargeResult {
  /** Сколько в итоге списано (может быть < credits если не хватило баланса). */
  charged: number
  /** Сколько не хватило кредитов (0 если списали полностью). */
  shortfall: number
  /** Гранты, с которых списали (для диагностики/возврата). */
  consumedFromGrants: Array<{ grantId: string; amount: number }>
}

/**
 * Списать кредиты с активных грантов подписки. Идемпотентно по requestId
 * (если уже было списание с тем же requestId — no-op).
 */
export async function chargeCredits(input: ChargeInput): Promise<ChargeResult> {
  if (!Number.isInteger(input.credits) || input.credits < 0) {
    throw new Error(`chargeCredits: invalid credits=${input.credits}`)
  }

  return await db.transaction(async (tx) => {
    // Advisory lock per subscription. Хешируем UUID → bigint.
    // Используем hashtext (Postgres builtin) для стабильного хеша.
    // drizzle sql-template (не {sql,args} — тот формат не поддерживается).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.subscriptionId})::bigint)`)

    // Идемпотентность: если usage_event с таким requestId уже есть — выходим.
    if (input.requestId) {
      const existing = await tx
        .select({ creditsCharged: schema.usageEvents.creditsCharged })
        .from(schema.usageEvents)
        .where(eq(schema.usageEvents.requestId, input.requestId))
        .limit(1)
      if (existing[0]) {
        return {
          charged: existing[0].creditsCharged,
          shortfall: 0,
          consumedFromGrants: [],
        }
      }
    }

    if (input.credits === 0) {
      // Бесплатная операция — пишем usage_event без списания (для аналитики).
      await tx.insert(schema.usageEvents).values({
        subscriptionId: input.subscriptionId,
        model: input.model,
        provider: input.provider,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costUsdMicroCenti: input.costUsdMicroCenti,
        creditsCharged: 0,
        scenarioId: input.scenarioId ?? null,
        requestId: input.requestId,
        status: "ok",
      })
      return { charged: 0, shortfall: 0, consumedFromGrants: [] }
    }

    const now = new Date()
    const grants = await tx
      .select()
      .from(schema.creditGrants)
      .where(
        and(
          eq(schema.creditGrants.subscriptionId, input.subscriptionId),
          isNull(schema.creditGrants.consumedAt),
          or(isNull(schema.creditGrants.expiresAt), gt(schema.creditGrants.expiresAt, now)),
          gt(schema.creditGrants.remainingCredits, 0),
        ),
      )
      .orderBy(asc(schema.creditGrants.expiresAt), asc(schema.creditGrants.createdAt))

    let remaining = input.credits
    const consumed: Array<{ grantId: string; amount: number }> = []

    for (const grant of grants) {
      if (remaining <= 0) break
      const takeFrom = Math.min(remaining, grant.remainingCredits)
      const newRemaining = grant.remainingCredits - takeFrom

      await tx
        .update(schema.creditGrants)
        .set({
          remainingCredits: newRemaining,
          consumedAt: newRemaining === 0 ? now : null,
        })
        .where(eq(schema.creditGrants.id, grant.id))

      consumed.push({ grantId: grant.id, amount: takeFrom })
      remaining -= takeFrom
    }

    const charged = input.credits - remaining
    const shortfall = remaining

    if (shortfall > 0) {
      logger.warn(
        {
          subscriptionId: input.subscriptionId,
          requested: input.credits,
          charged,
          shortfall,
        },
        "Credits overspend — LiteLLM hard-cap should have caught this",
      )
    }

    await tx.insert(schema.usageEvents).values({
      subscriptionId: input.subscriptionId,
      model: input.model,
      provider: input.provider,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsdMicroCenti: input.costUsdMicroCenti,
      creditsCharged: charged,
      scenarioId: input.scenarioId ?? null,
      requestId: input.requestId,
      status: shortfall > 0 ? "overspend" : "ok",
    })

    return { charged, shortfall, consumedFromGrants: consumed }
  })
}

/**
 * Конвертирует токены × прайс провайдера × множитель → кредиты.
 *
 * Anchor: 1 кредит = 60 USD-micro-centi (см. routes/credits.ts).
 * Эта функция должна совпадать с расчётом в /credits/preview.
 */
export function computeCredits(input: {
  inputTokens: number
  outputTokens: number
  pricePer1kInputMicroCenti: number
  pricePer1kOutputMicroCenti: number
  multiplier: number
  /** Кв. кредита в micro-centi USD. Default 60. */
  calibrationPerCreditMicroCenti?: number
}): number {
  const cal = input.calibrationPerCreditMicroCenti ?? 60
  const providerCost =
    (input.inputTokens / 1000) * input.pricePer1kInputMicroCenti +
    (input.outputTokens / 1000) * input.pricePer1kOutputMicroCenti
  return Math.max(1, Math.ceil((providerCost / cal) * input.multiplier))
}

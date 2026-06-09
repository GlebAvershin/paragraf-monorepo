/**
 * Общие хелперы биллинга: выдача кредитов и синхронизация LiteLLM hardcap.
 *
 * Переиспользуются в:
 *   - routes/payments.ts      (докупка кредитов)
 *   - routes/webhooks.ts      (продление подписки по рекурренту)
 *   - routes/subscriptions.ts (смена тарифа)
 *   - worker/recurrent-retry.ts
 *
 * Деньги — копейки (RUB). Кредиты — целые. Бюджет LiteLLM — USD.
 */
import { eq } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { litellm } from "../litellm/client.ts"
import { logger } from "./logger.ts"
import type { Plan } from "../db/schema.ts"

/** Каталог пакетов докупки кредитов (топ-ап). Цены в копейках. */
export interface TopupPackage {
  code: string
  credits: number
  amountKopeck: number
  titleRu: string
}

export const TOPUP_PACKAGES: Record<string, TopupPackage> = {
  p500: { code: "p500", credits: 500, amountKopeck: 129000, titleRu: "500 кредитов" },
  p1000: { code: "p1000", credits: 1000, amountKopeck: 239000, titleRu: "1 000 кредитов" },
  p2000: { code: "p2000", credits: 2000, amountKopeck: 449000, titleRu: "2 000 кредитов" },
}

export function getTopupPackage(code: string): TopupPackage | null {
  return TOPUP_PACKAGES[code] ?? null
}

/** 30 дней в миллисекундах — шаг периода подписки. */
export const PERIOD_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Сколько USD-hardcap-бюджета LiteLLM соответствует 1 кредиту для данного плана.
 * Берём пропорцию из плана (monthlyBudgetUsdCenti / monthlyCredits), чтобы
 * hardcap всегда оставался согласованным с выданными кредитами (включая запас
 * маржи/FX, заложенный в план). Фоллбек — anchor $0.0006/кредит.
 */
export function usdPerCredit(plan: Pick<Plan, "monthlyBudgetUsdCenti" | "monthlyCredits">): number {
  if (plan.monthlyCredits > 0 && plan.monthlyBudgetUsdCenti > 0) {
    return plan.monthlyBudgetUsdCenti / 100 / plan.monthlyCredits
  }
  return 0.0006
}

/**
 * Увеличить hardcap LiteLLM-ключа на эквивалент `credits` кредитов.
 * Не критично для отказа платежа — логируем и не бросаем (best-effort),
 * т.к. источник правды по балансу — credit_grants, а LiteLLM hardcap страховка.
 */
export async function bumpLiteLLMBudgetForCredits(
  litellmKey: string | null,
  plan: Pick<Plan, "monthlyBudgetUsdCenti" | "monthlyCredits">,
  credits: number,
): Promise<void> {
  if (!litellmKey) return
  try {
    const info = await litellm.getKeyInfo(litellmKey)
    const current = info.maxBudget ?? plan.monthlyBudgetUsdCenti / 100
    const delta = usdPerCredit(plan) * credits
    const next = Math.round((current + delta) * 100) / 100
    await litellm.updateKey(litellmKey, { maxBudgetUsd: next })
  } catch (err) {
    logger.warn({ err }, "bumpLiteLLMBudgetForCredits failed (non-fatal)")
  }
}

/**
 * Суммарный остаток активных кредитов подписки (для ответа UI «newBalance»).
 */
export async function currentRemainingCredits(subscriptionId: string): Promise<number> {
  const now = new Date()
  const grants = await db
    .select()
    .from(schema.creditGrants)
    .where(eq(schema.creditGrants.subscriptionId, subscriptionId))
  let total = 0
  for (const g of grants) {
    if (g.consumedAt) continue
    if (g.expiresAt && g.expiresAt <= now) continue
    total += g.remainingCredits
  }
  return total
}

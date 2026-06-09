/**
 * GET /limits — баланс кредитов пользователя для индикатора в сайдбаре.
 *
 * Source of truth — `credit_grants.remainingCredits` суммарно по активной подписке.
 * LiteLLM hardcap (`max_budget` в $) — страховочный слой, не отображается юзеру.
 *
 * Кэш 60 сек чтобы не дёргать БД на каждый рендер.
 */
import { Hono } from "hono"
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { litellm } from "../litellm/client.ts"
import { requireSession } from "../lib/middleware.ts"
import { logger } from "../lib/logger.ts"

export const limitsRoutes = new Hono()

interface CacheEntry {
  expiresAt: number
  value: unknown
}
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000

limitsRoutes.get("/", requireSession, async (c) => {
  const { sub: userId } = c.get("session")

  const cached = cache.get(userId)
  if (cached && cached.expiresAt > Date.now()) {
    return c.json(cached.value)
  }

  const subRows = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1)
  const sub = subRows[0]
  if (!sub) {
    return c.json({ error: "no_active_subscription" }, 404)
  }

  const planRows = await db
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.code, sub.planCode))
    .limit(1)
  const plan = planRows[0]
  if (!plan) {
    return c.json({ error: "plan_not_found" }, 500)
  }

  // Суммируем активные (не сгоревшие, не исчерпанные) гранты подписки.
  // `expiresAt IS NULL` = бессрочный (триал/промо без срока).
  const now = new Date()
  const activeGrants = await db
    .select({
      reason: schema.creditGrants.reason,
      amount: sql<number>`SUM(${schema.creditGrants.amountCredits})::int`,
      remaining: sql<number>`SUM(${schema.creditGrants.remainingCredits})::int`,
    })
    .from(schema.creditGrants)
    .where(
      and(
        eq(schema.creditGrants.subscriptionId, sub.id),
        isNull(schema.creditGrants.consumedAt),
        or(isNull(schema.creditGrants.expiresAt), gt(schema.creditGrants.expiresAt, now)),
      ),
    )
    .groupBy(schema.creditGrants.reason)

  let subscriptionRemaining = 0
  let subscriptionTotal = 0
  let topupRemaining = 0
  let topupTotal = 0
  let bonusRemaining = 0

  for (const row of activeGrants) {
    const remaining = row.remaining ?? 0
    const total = row.amount ?? 0
    if (row.reason === "subscription_monthly") {
      subscriptionRemaining += remaining
      subscriptionTotal += total
    } else if (row.reason === "topup") {
      topupRemaining += remaining
      topupTotal += total
    } else {
      bonusRemaining += remaining
    }
  }

  const totalRemaining = subscriptionRemaining + topupRemaining + bonusRemaining

  // LiteLLM hardcap — straховочный слой, отдаём для админ-дебага.
  let gatewayInfo: { usedUsd: number; budgetUsd: number; blocked: boolean } | null = null
  if (sub.litellmKey) {
    try {
      const info = await litellm.getKeyInfo(sub.litellmKey)
      gatewayInfo = {
        usedUsd: Number(info.spend.toFixed(4)),
        budgetUsd: info.maxBudget ?? plan.monthlyBudgetUsdCenti / 100,
        blocked: info.blocked,
      }
    } catch (err) {
      logger.warn({ err, userId }, "LiteLLM getKeyInfo failed (non-fatal)")
    }
  }

  const payload = {
    credits: {
      remaining: totalRemaining,
      // Главный знаменатель для UI (текущая подписка).
      monthlyTotal: plan.monthlyCredits,
      breakdown: {
        subscription: {
          remaining: subscriptionRemaining,
          total: subscriptionTotal,
        },
        topup: {
          remaining: topupRemaining,
          total: topupTotal,
        },
        bonus: {
          remaining: bonusRemaining,
        },
      },
    },
    plan: {
      code: plan.code,
      titleRu: plan.titleRu,
    },
    period: {
      currentPeriodEnd: sub.currentPeriodEnd,
    },
    status: {
      subscription: sub.status,
      // Если LiteLLM hardcap сработал — это сигнал бага в учёте кредитов.
      gatewayBlocked: gatewayInfo?.blocked ?? false,
    },
    gateway: gatewayInfo, // null если LiteLLM недоступен; UI это не показывает
  }

  cache.set(userId, { value: payload, expiresAt: Date.now() + CACHE_TTL_MS })
  return c.json(payload)
})

// Удаление из кэша после операций, изменяющих баланс (списание, докупка).
export function invalidateLimitsCache(userId: string) {
  cache.delete(userId)
}

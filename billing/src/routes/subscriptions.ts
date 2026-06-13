/**
 * Subscription routes + init helper.
 * Phase 1: only the Free plan, auto-created on signup.
 */
import { Hono } from "hono"
import { eq, desc, and } from "drizzle-orm"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db, schema } from "../db/client.ts"
import { litellm } from "../litellm/client.ts"
import { requireSession } from "../lib/middleware.ts"
import { logger } from "../lib/logger.ts"
import {
  cloudpayments,
  CloudPaymentsError,
  kopeckToRub,
} from "../lib/cloudpayments.ts"
import { bumpLiteLLMBudgetForCredits } from "../lib/grants.ts"
import { planChangedEmail, sendEmail } from "../lib/email.ts"
import { invalidateLimitsCache } from "./limits.ts"

export const subscriptionRoutes = new Hono()

/**
 * Create a Free subscription + virtual key in LiteLLM for a new user.
 * Called from auth.ts on first email verification.
 */
export async function initSubscription(userId: string): Promise<void> {
  // Load Free plan.
  const planRows = await db.select().from(schema.plans).where(eq(schema.plans.code, "free")).limit(1)
  const plan = planRows[0]
  if (!plan) {
    throw new Error("Free plan not seeded — run db:seed first")
  }

  const now = new Date()
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

  // Insert subscription without key first.
  const inserted = await db
    .insert(schema.subscriptions)
    .values({
      userId,
      planCode: plan.code,
      status: "trial",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialEndsAt: periodEnd,
    })
    .returning()
  const sub = inserted[0]!

  // Create virtual key in LiteLLM.
  try {
    const { key } = await litellm.createKey({
      userId,
      maxBudgetUsd: plan.monthlyBudgetUsdCenti / 100,
      models: plan.allowedModels,
      durationDays: 30,
      // НЕ ставим tpm/rpm-лимиты: в LiteLLM 1.85.x (main-stable) v3 rate-лимитер
      // при наличии tpm/rpm на ключе протекает внутренними полями
      // (_litellm_*_reserved_*) в запрос к Anthropic → Claude падает с 400
      // "Extra inputs are not permitted". Лимитируем расход через maxBudgetUsd
      // (жёсткий cap LiteLLM) + кредитную систему billing. Вернуть rpm/tpm можно
      // после фикса/пина версии LiteLLM.
      alias: `user-${userId.slice(0, 8)}-${plan.code}`,
      metadata: { plan: plan.code, sub: sub.id },
    })

    await db
      .update(schema.subscriptions)
      .set({ litellmKey: key, updatedAt: new Date() })
      .where(eq(schema.subscriptions.id, sub.id))

    // Триал-грант — кредиты со сроком жизни до конца триал-периода.
    // Без этого юзер увидит «0 / N» сразу после регистрации.
    if (plan.monthlyCredits > 0) {
      await db.insert(schema.creditGrants).values({
        subscriptionId: sub.id,
        amountCredits: plan.monthlyCredits,
        remainingCredits: plan.monthlyCredits,
        reason: "trial",
        expiresAt: periodEnd,
      })
    }

    await db.insert(schema.auditLog).values({
      actor: "system",
      action: "subscription.create",
      targetType: "subscription",
      targetId: sub.id,
      metadata: { plan: plan.code, credits: plan.monthlyCredits },
    })
  } catch (err) {
    logger.error({ err, userId, subId: sub.id }, "Failed to create LiteLLM key — subscription stuck")
    // The subscription exists but has no key. A retry job should pick it up.
    // For now we just log; Phase 2 will add a retry worker.
    throw err
  }
}

/** GET /subscriptions/current — current active subscription for the session user. */
subscriptionRoutes.get("/current", requireSession, async (c) => {
  const { sub: userId } = c.get("session")
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1)
  const subRow = rows[0]
  if (!subRow) {
    return c.json({ error: "no_subscription" }, 404)
  }
  // Don't leak the LiteLLM key in this endpoint — clients use /me for that.
  const { litellmKey, ...safe } = subRow
  return c.json(safe)
})

// ===== POST /subscriptions/change-plan — смена тарифа =====
//
// Upgrade (дороже): пропорциональная доплата за остаток периода + доп. кредиты.
// Downgrade (дешевле): без возврата денег, применяется с начала след. периода
//   через subscriptions.pendingPlanCode.

const changePlanInput = z.object({
  newPlanCode: z.string().min(1),
})

const DAY_MS = 24 * 60 * 60 * 1000

subscriptionRoutes.post(
  "/change-plan",
  requireSession,
  zValidator("json", changePlanInput),
  async (c) => {
    const { sub: userId } = c.get("session")
    const { newPlanCode } = c.req.valid("json")

    // Текущая подписка.
    const subRows = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, userId))
      .orderBy(desc(schema.subscriptions.createdAt))
      .limit(1)
    const sub = subRows[0]
    if (!sub) {
      return c.json({ error: "no_subscription" }, 404)
    }
    if (sub.planCode === newPlanCode) {
      return c.json({ error: "same_plan" }, 400)
    }

    // Планы.
    const planRows = await db.select().from(schema.plans)
    const currentPlan = planRows.find((p) => p.code === sub.planCode)
    const newPlan = planRows.find((p) => p.code === newPlanCode)
    if (!currentPlan || !newPlan) {
      return c.json({ error: "plan_not_found" }, 404)
    }

    const now = new Date()
    const daysLeft = Math.max(0, Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / DAY_MS))
    const prorationRatio = Math.min(1, daysLeft / 30)

    const userEmail = (
      await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1)
    )[0]?.email

    // ---------- DOWNGRADE ----------
    if (newPlan.priceRubKopeck < currentPlan.priceRubKopeck) {
      await db
        .update(schema.subscriptions)
        .set({ pendingPlanCode: newPlan.code, updatedAt: now })
        .where(eq(schema.subscriptions.id, sub.id))

      await db.insert(schema.auditLog).values({
        actor: `user:${userId}`,
        action: "subscription.downgrade_scheduled",
        targetType: "subscription",
        targetId: sub.id,
        metadata: { from: currentPlan.code, to: newPlan.code, effective: sub.currentPeriodEnd },
      })

      if (userEmail) {
        sendEmail(
          planChangedEmail({
            to: userEmail,
            fromTitleRu: currentPlan.titleRu,
            toTitleRu: newPlan.titleRu,
            immediate: false,
            effectiveDate: sub.currentPeriodEnd,
          }),
        ).catch((err) => logger.warn({ err }, "downgrade email failed"))
      }

      return c.json({
        status: "downgrade_scheduled",
        newPlanCode: newPlan.code,
        effectiveAt: sub.currentPeriodEnd,
      })
    }

    // ---------- UPGRADE ----------
    // Пропорциональная доплата за остаток текущего периода, в копейках.
    const surchargeKopeck = Math.round(
      (newPlan.priceRubKopeck - currentPlan.priceRubKopeck) * prorationRatio,
    )
    // Доп. кредиты — пропорционально разнице месячных норм.
    const extraCredits = Math.max(
      0,
      Math.floor((newPlan.monthlyCredits - currentPlan.monthlyCredits) * prorationRatio),
    )

    if (!cloudpayments.configured) {
      return c.json({ error: "payments_not_configured" }, 503)
    }

    // Карта по умолчанию для доплаты.
    const cardRows = await db
      .select()
      .from(schema.paymentMethods)
      .where(
        and(eq(schema.paymentMethods.userId, userId), eq(schema.paymentMethods.isDefault, true)),
      )
      .limit(1)
    const card = cardRows[0]
    if (!card) {
      return c.json({ error: "no_card_attached" }, 400)
    }

    const invoiceId = `upgrade_${crypto.randomUUID()}`

    // Списываем доплату (если она > 0; при daysLeft=0 доплата может быть 0).
    if (surchargeKopeck > 0) {
      let charge
      try {
        charge = await cloudpayments.tokensCharge({
          amountRub: kopeckToRub(surchargeKopeck),
          token: card.cloudpaymentsToken,
          accountId: userId,
          invoiceId,
          description: `Смена тарифа «Параграф»: ${currentPlan.titleRu} → ${newPlan.titleRu}`,
          email: userEmail ?? undefined,
          jsonData: { kind: "upgrade", planCode: newPlan.code, subscriptionId: sub.id },
        })
      } catch (err) {
        if (err instanceof CloudPaymentsError) {
          logger.error({ status: err.status, userId }, "Upgrade charge acquirer error")
          return c.json({ error: "acquirer_error", message: "Ошибка эквайринга" }, 502)
        }
        throw err
      }

      if (!charge.Success) {
        const reason = charge.Message ?? charge.Model?.Reason ?? "Платёж отклонён"
        await db.insert(schema.payments).values({
          userId,
          subscriptionId: sub.id,
          amountKopeck: surchargeKopeck,
          status: "failed",
          kind: "subscription",
          cloudpaymentsInvoiceId: invoiceId,
          isRecurrent: true,
          failureReason: reason,
          metadata: { invoiceId, planCode: newPlan.code, kind: "upgrade" },
        })
        return c.json({ error: "payment_failed", message: reason }, 402)
      }

      const txnId = charge.Model?.TransactionId != null ? String(charge.Model.TransactionId) : null
      await db.insert(schema.payments).values({
        userId,
        subscriptionId: sub.id,
        amountKopeck: surchargeKopeck,
        status: "success",
        kind: "subscription",
        cloudpaymentsInvoiceId: invoiceId,
        cloudpaymentsTransactionId: txnId,
        isRecurrent: true,
        paidAt: now,
        metadata: { invoiceId, planCode: newPlan.code, kind: "upgrade", creditsAdded: extraCredits },
      })
    }

    // Применяем upgrade сразу: новый план + доп. кредиты до конца периода.
    await db.transaction(async (tx) => {
      await tx
        .update(schema.subscriptions)
        .set({ planCode: newPlan.code, pendingPlanCode: null, status: "active", updatedAt: now })
        .where(eq(schema.subscriptions.id, sub.id))

      if (extraCredits > 0) {
        await tx.insert(schema.creditGrants).values({
          subscriptionId: sub.id,
          amountCredits: extraCredits,
          remainingCredits: extraCredits,
          reason: "subscription_monthly",
          expiresAt: sub.currentPeriodEnd,
        })
      }

      await tx.insert(schema.auditLog).values({
        actor: `user:${userId}`,
        action: "subscription.upgrade",
        targetType: "subscription",
        targetId: sub.id,
        metadata: {
          from: currentPlan.code,
          to: newPlan.code,
          surchargeKopeck,
          extraCredits,
        },
      })
    })

    // LiteLLM: расширяем список моделей под новый план и поднимаем hardcap.
    if (sub.litellmKey) {
      try {
        await litellm.updateKey(sub.litellmKey, { models: newPlan.allowedModels })
      } catch (err) {
        logger.warn({ err }, "updateKey models on upgrade failed")
      }
    }
    await bumpLiteLLMBudgetForCredits(sub.litellmKey, newPlan, extraCredits)
    invalidateLimitsCache(userId)

    if (userEmail) {
      sendEmail(
        planChangedEmail({
          to: userEmail,
          fromTitleRu: currentPlan.titleRu,
          toTitleRu: newPlan.titleRu,
          immediate: true,
        }),
      ).catch((err) => logger.warn({ err }, "upgrade email failed"))
    }

    return c.json({
      status: "upgraded",
      newPlanCode: newPlan.code,
      surchargeKopeck,
      extraCredits,
    })
  },
)

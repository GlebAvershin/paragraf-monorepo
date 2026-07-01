/**
 * Worker: повтор неудачных рекуррентных списаний за подписку (ТЗ-02 §4.4).
 *
 * Раз в час сканирует подписки в статусе `past_due`, у которых последняя попытка
 * списания была более суток назад, и пробует списать оплату повторно.
 *
 * Правила:
 *   - До 3 попыток в течение 7 дней.
 *   - Успех  → продлеваем период, выдаём месячный грант, статус → active.
 *   - 3-я неудача ИЛИ истекли 7 дней с past_due → статус → expired, блок ключа.
 *
 * Запуск:
 *   bun run src/worker/recurrent-retry.ts          # один проход (для внешнего cron)
 *   bun run src/worker/recurrent-retry.ts --loop   # бесконечный цикл (раз в час)
 *
 * Идемпотентность: каждое списание идёт с уникальным InvoiceId. Если CloudPayments
 * параллельно пришлёт Pay-webhook на тот же InvoiceId — повторного начисления не
 * будет (гард по payments.cloudpaymentsInvoiceId).
 */
import { and, desc, eq } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { logger } from "../lib/logger.ts"
import { cloudpayments, kopeckToRub } from "../lib/cloudpayments.ts"
import { litellm } from "../litellm/client.ts"
import { bumpLiteLLMBudgetForCredits, PERIOD_MS } from "../lib/grants.ts"
import {
  paymentFailedEmail,
  paymentSucceededEmail,
  subscriptionExpiredEmail,
  sendEmail,
} from "../lib/email.ts"
import { invalidateLimitsCache } from "../routes/limits.ts"

const MAX_RECURRENT_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000 // не чаще раза в сутки
const PAST_DUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 дней до expired

async function getUserEmail(userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)
  return rows[0]?.email ?? null
}

/** Один проход воркера: обработать все past_due подписки, готовые к ретраю. */
export async function runRecurrentRetryPass(): Promise<{ processed: number }> {
  const now = new Date()
  const retryBefore = new Date(now.getTime() - RETRY_BACKOFF_MS)

  const dueSubs = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.status, "past_due"))

  let processed = 0

  for (const sub of dueSubs) {
    // Последняя неудачная подписочная попытка.
    const lastFailRows = await db
      .select()
      .from(schema.payments)
      .where(
        and(
          eq(schema.payments.subscriptionId, sub.id),
          eq(schema.payments.kind, "subscription"),
          eq(schema.payments.status, "failed"),
        ),
      )
      .orderBy(desc(schema.payments.createdAt))
      .limit(1)
    const lastFail = lastFailRows[0]

    // Бэкофф: пробуем не чаще раза в сутки.
    if (lastFail && lastFail.createdAt > retryBefore) continue

    const failCount = await countRecurrentFails(sub.id)
    const pastDueSince = sub.pastDueSince ?? lastFail?.createdAt ?? now
    const windowExceeded = now.getTime() - pastDueSince.getTime() > PAST_DUE_WINDOW_MS

    // Достигнут лимит попыток или окно 7 дней — переводим в expired.
    if (failCount >= MAX_RECURRENT_ATTEMPTS || windowExceeded) {
      await expireSubscription(sub, "retry_limit_or_window")
      processed++
      continue
    }

    const plan = (
      await db.select().from(schema.plans).where(eq(schema.plans.code, sub.planCode)).limit(1)
    )[0]
    if (!plan) {
      logger.error({ subId: sub.id }, "retry: plan not found")
      continue
    }

    const card = (
      await db
        .select()
        .from(schema.paymentMethods)
        .where(
          and(eq(schema.paymentMethods.userId, sub.userId), eq(schema.paymentMethods.isDefault, true)),
        )
        .limit(1)
    )[0]
    if (!card) {
      // Нет карты — ретрай невозможен; ждём окно, потом expired.
      logger.info({ subId: sub.id }, "retry: no card, skipping until window expires")
      continue
    }

    if (!cloudpayments.configured) {
      logger.warn("retry: CloudPayments not configured, skipping pass")
      break
    }

    const invoiceId = `recur_${sub.id}_${Date.now()}`
    const attemptNumber = failCount + 1
    const email = await getUserEmail(sub.userId)

    let charge
    try {
      charge = await cloudpayments.tokensCharge({
        amountRub: kopeckToRub(plan.priceRubKopeck),
        token: card.cloudpaymentsToken,
        accountId: sub.userId,
        invoiceId,
        description: `Продление подписки Isaac — ${plan.titleRu}`,
        email: email ?? undefined,
        jsonData: { kind: "subscription", planCode: plan.code, subscriptionId: sub.id },
      })
    } catch (err) {
      logger.error({ err, subId: sub.id }, "retry: charge request error")
      continue
    }

    if (charge.Success) {
      await renewOnSuccess(sub, plan, plan.priceRubKopeck, invoiceId, charge.Model?.TransactionId)
      if (email) {
        await sendEmail(
          paymentSucceededEmail({
            to: email,
            amountKopeck: plan.priceRubKopeck,
            description: `Продление подписки «${plan.titleRu}».`,
            creditsAdded: plan.monthlyCredits,
          }),
        ).catch(() => {})
      }
      logger.info({ subId: sub.id, attemptNumber }, "retry: charge succeeded, subscription renewed")
    } else {
      const reason = charge.Message ?? charge.Model?.Reason ?? "Платёж отклонён"
      await db.insert(schema.payments).values({
        userId: sub.userId,
        subscriptionId: sub.id,
        amountKopeck: plan.priceRubKopeck,
        status: "failed",
        kind: "subscription",
        cloudpaymentsInvoiceId: invoiceId,
        isRecurrent: true,
        attemptNumber,
        failureReason: reason,
        metadata: { invoiceId, retry: true },
      })

      if (attemptNumber >= MAX_RECURRENT_ATTEMPTS) {
        await expireSubscription(sub, "max_attempts")
      } else if (email) {
        await sendEmail(
          paymentFailedEmail({ to: email, amountKopeck: plan.priceRubKopeck, reason, attemptNumber }),
        ).catch(() => {})
      }
      logger.info({ subId: sub.id, attemptNumber, reason }, "retry: charge failed")
    }
    processed++
  }

  return { processed }
}

async function countRecurrentFails(subscriptionId: string): Promise<number> {
  const rows = await db
    .select()
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.subscriptionId, subscriptionId),
        eq(schema.payments.kind, "subscription"),
        eq(schema.payments.status, "failed"),
      ),
    )
  return rows.length
}

/** Успешное продление: период + месячный грант + active. */
async function renewOnSuccess(
  sub: typeof schema.subscriptions.$inferSelect,
  plan: typeof schema.plans.$inferSelect,
  amountKopeck: number,
  invoiceId: string,
  transactionId: number | undefined,
): Promise<void> {
  const now = new Date()
  const base = sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now
  const newPeriodEnd = new Date(base.getTime() + PERIOD_MS)
  // Применяем отложенный downgrade, если был запланирован.
  const effectivePlan = sub.pendingPlanCode
    ? (await db.select().from(schema.plans).where(eq(schema.plans.code, sub.pendingPlanCode)).limit(1))[0] ?? plan
    : plan

  await db.transaction(async (tx) => {
    await tx.insert(schema.payments).values({
      userId: sub.userId,
      subscriptionId: sub.id,
      amountKopeck,
      status: "success",
      kind: "subscription",
      cloudpaymentsInvoiceId: invoiceId,
      cloudpaymentsTransactionId: transactionId != null ? String(transactionId) : null,
      isRecurrent: true,
      paidAt: now,
      metadata: { invoiceId, planCode: effectivePlan.code, creditsAdded: effectivePlan.monthlyCredits },
    })

    await tx
      .update(schema.subscriptions)
      .set({
        planCode: effectivePlan.code,
        pendingPlanCode: null,
        status: "active",
        pastDueSince: null,
        currentPeriodStart: base,
        currentPeriodEnd: newPeriodEnd,
        updatedAt: now,
      })
      .where(eq(schema.subscriptions.id, sub.id))

    if (effectivePlan.monthlyCredits > 0) {
      await tx.insert(schema.creditGrants).values({
        subscriptionId: sub.id,
        amountCredits: effectivePlan.monthlyCredits,
        remainingCredits: effectivePlan.monthlyCredits,
        reason: "subscription_monthly",
        expiresAt: newPeriodEnd,
      })
    }

    await tx.insert(schema.auditLog).values({
      actor: "system",
      action: "subscription.renew_retry",
      targetType: "subscription",
      targetId: sub.id,
      metadata: { planCode: effectivePlan.code, invoiceId },
    })
  })

  if (sub.litellmKey) {
    try {
      await litellm.unblockKey(sub.litellmKey)
    } catch (err) {
      logger.warn({ err }, "retry: unblockKey failed")
    }
  }
  await bumpLiteLLMBudgetForCredits(sub.litellmKey, effectivePlan, effectivePlan.monthlyCredits)
  invalidateLimitsCache(sub.userId)
}

/** Перевод подписки в expired + блокировка ключа + письмо. */
async function expireSubscription(
  sub: typeof schema.subscriptions.$inferSelect,
  cause: string,
): Promise<void> {
  const now = new Date()
  await db
    .update(schema.subscriptions)
    .set({ status: "expired", updatedAt: now })
    .where(eq(schema.subscriptions.id, sub.id))

  await db.insert(schema.auditLog).values({
    actor: "system",
    action: "subscription.expire",
    targetType: "subscription",
    targetId: sub.id,
    metadata: { cause },
  })

  if (sub.litellmKey) {
    try {
      await litellm.blockKey(sub.litellmKey)
    } catch (err) {
      logger.warn({ err }, "retry: blockKey on expire failed")
    }
  }
  invalidateLimitsCache(sub.userId)

  const email = await getUserEmail(sub.userId)
  if (email) {
    const planTitle = (
      await db.select({ titleRu: schema.plans.titleRu }).from(schema.plans).where(eq(schema.plans.code, sub.planCode)).limit(1)
    )[0]?.titleRu ?? sub.planCode
    await sendEmail(subscriptionExpiredEmail({ to: email, planTitleRu: planTitle })).catch(() => {})
  }
  logger.info({ subId: sub.id, cause }, "retry: subscription expired")
}

// ===== Entry point =====

async function main() {
  const loop = process.argv.includes("--loop")
  if (loop) {
    logger.info("recurrent-retry worker started in loop mode (every 1h)")
    // Первый проход сразу, далее раз в час.
    for (;;) {
      try {
        const { processed } = await runRecurrentRetryPass()
        logger.info({ processed }, "recurrent-retry pass complete")
      } catch (err) {
        logger.error({ err }, "recurrent-retry pass failed")
      }
      await new Promise((r) => setTimeout(r, 60 * 60 * 1000))
    }
  } else {
    const { processed } = await runRecurrentRetryPass()
    logger.info({ processed }, "recurrent-retry single pass complete")
    process.exit(0)
  }
}

// Запуск только при прямом вызове файла (не при импорте из тестов).
if (import.meta.main) {
  main().catch((err) => {
    logger.error({ err }, "recurrent-retry fatal")
    process.exit(1)
  })
}

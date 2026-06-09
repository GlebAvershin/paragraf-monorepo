/**
 * Payment routes (ТЗ-02):
 *   POST /payments/method   — привязка карты (cards/auth 1 ₽ + void, сохраняем токен)
 *   POST /payments/topup    — разовая докупка пакета кредитов по сохранённому токену
 *   GET  /payments/history  — история платежей для страницы /credits
 *
 * Деньги в БД — копейки (RUB). В CloudPayments API — рубли (см. cloudpayments.ts).
 */
import { Hono } from "hono"
import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db, schema } from "../db/client.ts"
import { requireSession } from "../lib/middleware.ts"
import { logger } from "../lib/logger.ts"
import {
  cloudpayments,
  CloudPaymentsError,
  normalizeCardBrand,
  kopeckToRub,
} from "../lib/cloudpayments.ts"
import {
  getTopupPackage,
  bumpLiteLLMBudgetForCredits,
  currentRemainingCredits,
  PERIOD_MS,
  TOPUP_PACKAGES,
} from "../lib/grants.ts"
import { paymentSucceededEmail } from "../lib/email.ts"
import { sendEmail } from "../lib/email.ts"
import { invalidateLimitsCache } from "./limits.ts"

export const paymentRoutes = new Hono()

/** Последняя (текущая) подписка пользователя. */
async function getActiveSubscription(userId: string) {
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1)
  return rows[0] ?? null
}

async function getUserEmail(userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)
  return rows[0]?.email ?? null
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  const xff = c.req.header("x-forwarded-for")
  if (xff) return xff.split(",")[0]!.trim()
  return c.req.header("x-real-ip") ?? "127.0.0.1"
}

// ===== POST /payments/method — привязка карты =====

const attachCardInput = z.object({
  cryptogram: z.string().min(1),
})

paymentRoutes.post("/method", requireSession, zValidator("json", attachCardInput), async (c) => {
  const { sub: userId } = c.get("session")
  const { cryptogram } = c.req.valid("json")

  if (!cloudpayments.configured) {
    return c.json({ error: "payments_not_configured" }, 503)
  }

  const email = (await getUserEmail(userId)) ?? undefined
  const invoiceId = `cardbind_${crypto.randomUUID()}`

  try {
    // 1. Валидируем карту тестовым холдом на 1 ₽ с сохранением токена.
    const auth = await cloudpayments.cardsAuth({
      amountRub: 1,
      cryptogram,
      accountId: userId,
      description: "Привязка карты для «Параграфа»",
      invoiceId,
      ipAddress: clientIp(c),
      email,
      saveCard: true,
    })

    if (!auth.Success || !auth.Model?.Token) {
      // Карта не прошла валидацию (отказ банка / требуется 3DS на стороне виджета).
      logger.info({ userId, reason: auth.Message }, "Card binding declined")
      return c.json(
        { error: "card_declined", message: auth.Message ?? "Карта не прошла проверку" },
        402,
      )
    }

    const model = auth.Model
    const token = model.Token!

    // 2. Сразу отменяем холд (возвращаем 1 ₽).
    if (model.TransactionId != null) {
      try {
        await cloudpayments.voidPayment(model.TransactionId)
      } catch (err) {
        // Не критично — холд истечёт сам. Логируем.
        logger.warn({ err, userId }, "Void after card binding failed (hold will expire)")
      }
    }

    // 3. Парсим срок действия карты (MM/YY → дата конца месяца).
    let expiresAt: Date | null = null
    if (model.CardExpDate && /^\d{2}\/\d{2}$/.test(model.CardExpDate)) {
      const parts = model.CardExpDate.split("/")
      const mm = parseInt(parts[0]!, 10)
      const yy = parseInt(parts[1]!, 10)
      // Последний день месяца действия.
      expiresAt = new Date(Date.UTC(2000 + yy, mm, 0, 23, 59, 59))
    }

    const cardLast4 = model.CardLastFour ?? null
    const cardBrand = normalizeCardBrand(model.CardType)

    // 4. Сохраняем способ оплаты. Делаем его дефолтным, прочие — снимаем дефолт.
    const saved = await db.transaction(async (tx) => {
      await tx
        .update(schema.paymentMethods)
        .set({ isDefault: false })
        .where(eq(schema.paymentMethods.userId, userId))

      const inserted = await tx
        .insert(schema.paymentMethods)
        .values({
          userId,
          cloudpaymentsToken: token,
          cardLast4,
          cardBrand,
          isDefault: true,
          expiresAt,
        })
        .returning({ id: schema.paymentMethods.id })

      await tx.insert(schema.auditLog).values({
        actor: `user:${userId}`,
        action: "payment_method.attach",
        targetType: "payment_method",
        targetId: inserted[0]!.id,
        metadata: { cardLast4, cardBrand },
      })
      return inserted[0]!
    })

    return c.json({ id: saved.id, cardLast4, cardBrand })
  } catch (err) {
    if (err instanceof CloudPaymentsError) {
      logger.error({ status: err.status }, "CloudPayments cards/auth error")
      return c.json({ error: "acquirer_error", message: "Ошибка эквайринга" }, 502)
    }
    throw err
  }
})

// ===== POST /payments/topup — докупка пакета кредитов =====

const topupInput = z.object({
  package: z.string().min(1),
})

paymentRoutes.post("/topup", requireSession, zValidator("json", topupInput), async (c) => {
  const { sub: userId } = c.get("session")
  const { package: packageCode } = c.req.valid("json")

  const pkg = getTopupPackage(packageCode)
  if (!pkg) {
    return c.json({ error: "unknown_package", packages: Object.keys(TOPUP_PACKAGES) }, 400)
  }

  if (!cloudpayments.configured) {
    return c.json({ error: "payments_not_configured" }, 503)
  }

  const sub = await getActiveSubscription(userId)
  if (!sub) {
    return c.json({ error: "no_subscription" }, 404)
  }

  // Карта по умолчанию.
  const cardRows = await db
    .select()
    .from(schema.paymentMethods)
    .where(and(eq(schema.paymentMethods.userId, userId), eq(schema.paymentMethods.isDefault, true)))
    .limit(1)
  const card = cardRows[0]
  if (!card) {
    return c.json({ error: "no_card_attached" }, 400)
  }

  const plan = (
    await db.select().from(schema.plans).where(eq(schema.plans.code, sub.planCode)).limit(1)
  )[0]
  if (!plan) {
    return c.json({ error: "plan_not_found" }, 500)
  }

  const email = (await getUserEmail(userId)) ?? undefined
  const invoiceId = `topup_${crypto.randomUUID()}`

  // 1. Списание по токену.
  let charge
  try {
    charge = await cloudpayments.tokensCharge({
      amountRub: kopeckToRub(pkg.amountKopeck),
      token: card.cloudpaymentsToken,
      accountId: userId,
      invoiceId,
      description: `Докупка кредитов «Параграф» — ${pkg.titleRu}`,
      email,
      jsonData: { kind: "topup", package: pkg.code, subscriptionId: sub.id },
    })
  } catch (err) {
    if (err instanceof CloudPaymentsError) {
      logger.error({ status: err.status, userId }, "CloudPayments tokens/charge error")
      return c.json({ error: "acquirer_error", message: "Ошибка эквайринга" }, 502)
    }
    throw err
  }

  // 2. Отказ списания → пишем failed payment, отдаём 402.
  if (!charge.Success) {
    const reason = charge.Message ?? charge.Model?.Reason ?? "Платёж отклонён"
    await db.insert(schema.payments).values({
      userId,
      subscriptionId: sub.id,
      amountKopeck: pkg.amountKopeck,
      status: "failed",
      kind: "topup",
      cloudpaymentsInvoiceId: invoiceId,
      cloudpaymentsTransactionId:
        charge.Model?.TransactionId != null ? String(charge.Model.TransactionId) : null,
      isRecurrent: true,
      failureReason: reason,
      metadata: { invoiceId, package: pkg.code },
    })
    return c.json({ error: "payment_failed", message: reason }, 402)
  }

  // 3. Успех → платёж + грант кредитов в одной транзакции (идемпотентно по InvoiceId).
  const now = new Date()
  // Топ-ап «не сгорает до конца следующего месяца» — даём срок = period_end + 30 дней.
  const expiresAt = new Date(sub.currentPeriodEnd.getTime() + PERIOD_MS)
  const txnId =
    charge.Model?.TransactionId != null ? String(charge.Model.TransactionId) : null

  const paymentId = await db.transaction(async (tx) => {
    const insertedPayment = await tx
      .insert(schema.payments)
      .values({
        userId,
        subscriptionId: sub.id,
        amountKopeck: pkg.amountKopeck,
        status: "success",
        kind: "topup",
        cloudpaymentsInvoiceId: invoiceId,
        cloudpaymentsTransactionId: txnId,
        isRecurrent: true,
        paidAt: now,
        metadata: { invoiceId, package: pkg.code, creditsAdded: pkg.credits },
      })
      .returning({ id: schema.payments.id })
    const pid = insertedPayment[0]!.id

    await tx.insert(schema.creditGrants).values({
      subscriptionId: sub.id,
      amountCredits: pkg.credits,
      remainingCredits: pkg.credits,
      reason: "topup",
      paymentId: pid,
      expiresAt,
    })

    await tx.insert(schema.auditLog).values({
      actor: `user:${userId}`,
      action: "payment.topup",
      targetType: "payment",
      targetId: pid,
      metadata: { package: pkg.code, credits: pkg.credits, amountKopeck: pkg.amountKopeck },
    })
    return pid
  })

  // 4. LiteLLM hardcap + инвалидация кэша баланса.
  await bumpLiteLLMBudgetForCredits(sub.litellmKey, plan, pkg.credits)
  invalidateLimitsCache(userId)

  const newBalance = await currentRemainingCredits(sub.id)

  // 5. Email-уведомление (best-effort).
  if (email) {
    sendEmail(
      paymentSucceededEmail({
        to: email,
        amountKopeck: pkg.amountKopeck,
        description: `Докупка кредитов — ${pkg.titleRu}.`,
        creditsAdded: pkg.credits,
        newBalance,
      }),
    ).catch((err) => logger.warn({ err }, "topup email failed"))
  }

  return c.json({ paymentId, creditsAdded: pkg.credits, newBalance })
})

// ===== GET /payments/history — история платежей =====

paymentRoutes.get("/history", requireSession, async (c) => {
  const { sub: userId } = c.get("session")

  const rows = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.userId, userId))
    .orderBy(desc(schema.payments.createdAt))
    .limit(100)

  // Подтягиваем названия планов для подписочных платежей.
  const planRows = await db.select().from(schema.plans)
  const planTitleByCode = new Map(planRows.map((p) => [p.code, p.titleRu]))

  const items = rows.map((p) => {
    const meta = (p.metadata ?? {}) as Record<string, unknown>
    const planCode = typeof meta.planCode === "string" ? meta.planCode : null
    const creditsAdded = typeof meta.creditsAdded === "number" ? meta.creditsAdded : null
    return {
      id: p.id,
      amountKopeck: p.amountKopeck,
      status: p.status,
      kind: p.kind,
      planTitleRu: planCode ? (planTitleByCode.get(planCode) ?? null) : null,
      creditsAdded,
      failureReason: p.failureReason,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
    }
  })

  return c.json({ items, total: items.length })
})

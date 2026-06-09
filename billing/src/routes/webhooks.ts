/**
 * CloudPayments webhook receiver (ТЗ-02).
 *
 *   POST /webhooks/cloudpayments
 *
 * CloudPayments шлёт уведомления нескольких типов. В личном кабинете для каждого
 * типа задаётся URL — рекомендуется указывать с query-параметром `type`:
 *   .../webhooks/cloudpayments?type=pay
 *   .../webhooks/cloudpayments?type=fail
 *   .../webhooks/cloudpayments?type=recurrent
 *   .../webhooks/cloudpayments?type=receipt
 * Если `type` не передан — пытаемся вывести его из полей уведомления.
 *
 * Безопасность: тело подписано HMAC-SHA256 (base64) в заголовке Content-HMAC.
 * Проверяем подпись по СЫРОМУ телу до парсинга. Невалидные запросы → 401.
 *
 * Идемпотентность: все операции привязаны к InvoiceId. Повторное уведомление
 * (CloudPayments ретраит, пока не получит {code:0}) не должно повторно начислить
 * кредиты или продлить период. Гард — запись в `payments` по InvoiceId +
 * advisory-lock на хеш InvoiceId.
 *
 * Любой успешно принятый webhook возвращает { code: 0 } — иначе CloudPayments
 * будет ретраить.
 */
import { Hono } from "hono"
import { desc, eq, sql } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { config } from "../config.ts"
import { logger } from "../lib/logger.ts"
import { verifyHmac } from "../lib/hmac.ts"
import { litellm } from "../litellm/client.ts"
import {
  PERIOD_MS,
  bumpLiteLLMBudgetForCredits,
} from "../lib/grants.ts"
import {
  paymentFailedEmail,
  paymentSucceededEmail,
  subscriptionExpiredEmail,
  sendEmail,
} from "../lib/email.ts"
import { invalidateLimitsCache } from "./limits.ts"

export const webhookRoutes = new Hono()

const MAX_RECURRENT_ATTEMPTS = 3

type Notification = Record<string, string>

/** Парсинг тела: CloudPayments по умолчанию шлёт form-urlencoded, но поддержим и JSON. */
function parseBody(rawBody: string, contentType: string | undefined): Notification {
  if (contentType?.includes("application/json")) {
    try {
      const obj = JSON.parse(rawBody) as Record<string, unknown>
      const out: Notification = {}
      for (const [k, v] of Object.entries(obj)) out[k] = v == null ? "" : String(v)
      return out
    } catch {
      return {}
    }
  }
  const params = new URLSearchParams(rawBody)
  const out: Notification = {}
  for (const [k, v] of params.entries()) out[k] = v
  return out
}

/** Определить тип уведомления из query-параметра или эвристикой по полям. */
function detectType(typeParam: string | undefined, n: Notification): string {
  if (typeParam) return typeParam.toLowerCase()
  if (n.Type) return n.Type.toLowerCase()
  if (n.Amount && n.Email && !n.TransactionId && n.Id) return "receipt"
  if (n.Reason || n.ReasonCode) return "fail"
  if (n.Status && n.Id && !n.TransactionId) return "recurrent"
  return "pay"
}

/** Текущая (последняя) подписка пользователя. */
async function getSubscriptionByUser(userId: string) {
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1)
  return rows[0] ?? null
}

webhookRoutes.post("/cloudpayments", async (c) => {
  const secret = config.CLOUDPAYMENTS_WEBHOOK_SECRET || config.CLOUDPAYMENTS_API_SECRET || ""
  if (!secret) {
    logger.error("Webhook secret not configured — rejecting")
    return c.json({ error: "not_configured" }, 503)
  }

  const rawBody = await c.req.text()
  const signature = c.req.header("Content-HMAC") ?? c.req.header("X-Content-HMAC")

  if (!verifyHmac(rawBody, signature, secret)) {
    logger.warn({ path: c.req.path }, "Webhook HMAC verification failed")
    return c.json({ error: "invalid_signature" }, 401)
  }

  const contentType = c.req.header("content-type") ?? undefined
  const n = parseBody(rawBody, contentType)
  const type = detectType(c.req.query("type"), n)

  logger.info({ type, invoiceId: n.InvoiceId, transactionId: n.TransactionId }, "CloudPayments webhook")

  try {
    switch (type) {
      case "pay":
        await handlePay(n)
        break
      case "fail":
        await handleFail(n)
        break
      case "recurrent":
        await handleRecurrent(n)
        break
      case "receipt":
        await handleReceipt(n)
        break
      default:
        logger.warn({ type }, "Unknown webhook type — acknowledging")
    }
  } catch (err) {
    logger.error({ err, type }, "Webhook handler error")
    // Возвращаем code:13 — CloudPayments повторит позже (не теряем событие).
    return c.json({ code: 13 })
  }

  return c.json({ code: 0 })
})

/**
 * Pay — успешный платёж (включая рекуррент за подписку).
 * Идемпотентно по InvoiceId: если платёж уже success — no-op.
 */
async function handlePay(n: Notification): Promise<void> {
  const invoiceId = n.InvoiceId
  const userId = n.AccountId
  const amountKopeck = Math.round(parseFloat(n.Amount || "0") * 100)
  const txnId = n.TransactionId || null
  const isSubscriptionRenewal = Boolean(n.SubscriptionId) || jsonField(n, "kind") === "subscription"

  await db.transaction(async (tx) => {
    // Сериализуем обработку одного InvoiceId (drizzle sql-template, не {sql,args}).
    if (invoiceId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoiceId})::bigint)`)
    }

    // Идемпотентность: уже обработанный успешный платёж — выходим.
    if (invoiceId) {
      const existing = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.cloudpaymentsInvoiceId, invoiceId))
        .limit(1)
      if (existing[0]?.status === "success") {
        return // уже начислено (например, синхронный topup или повторный webhook)
      }
    }

    if (!userId) {
      logger.warn({ invoiceId }, "Pay webhook without AccountId — cannot map to user")
      return
    }
    const sub = await getSubscriptionByUser(userId)
    if (!sub) {
      logger.warn({ userId }, "Pay webhook: subscription not found")
      return
    }

    if (!isSubscriptionRenewal) {
      // Разовый платёж (topup), который ещё не зафиксирован синхронно — запишем.
      await upsertSuccessPayment(tx, {
        userId,
        subscriptionId: sub.id,
        amountKopeck,
        kind: "topup",
        invoiceId,
        txnId,
      })
      return
    }

    // ----- Рекуррент за подписку: продление периода + месячный грант -----
    // Применяем отложенный downgrade, если запланирован.
    const effectivePlanCode = sub.pendingPlanCode ?? sub.planCode
    const plan = (
      await tx.select().from(schema.plans).where(eq(schema.plans.code, effectivePlanCode)).limit(1)
    )[0]
    if (!plan) {
      logger.error({ effectivePlanCode }, "Pay webhook: plan not found")
      return
    }

    const now = new Date()
    const base = sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now
    const newPeriodStart = base
    const newPeriodEnd = new Date(base.getTime() + PERIOD_MS)

    await upsertSuccessPayment(tx, {
      userId,
      subscriptionId: sub.id,
      amountKopeck,
      kind: "subscription",
      invoiceId,
      txnId,
      isRecurrent: true,
      metadata: { planCode: plan.code, creditsAdded: plan.monthlyCredits, invoiceId },
    })

    await tx
      .update(schema.subscriptions)
      .set({
        planCode: plan.code,
        pendingPlanCode: null,
        status: "active",
        pastDueSince: null,
        currentPeriodStart: newPeriodStart,
        currentPeriodEnd: newPeriodEnd,
        updatedAt: now,
      })
      .where(eq(schema.subscriptions.id, sub.id))

    // Месячный грант — сгорает в конце нового периода.
    if (plan.monthlyCredits > 0) {
      await tx.insert(schema.creditGrants).values({
        subscriptionId: sub.id,
        amountCredits: plan.monthlyCredits,
        remainingCredits: plan.monthlyCredits,
        reason: "subscription_monthly",
        expiresAt: newPeriodEnd,
      })
    }

    await tx.insert(schema.auditLog).values({
      actor: "webhook:cloudpayments",
      action: "subscription.renew",
      targetType: "subscription",
      targetId: sub.id,
      metadata: { planCode: plan.code, credits: plan.monthlyCredits, invoiceId },
    })

    // Сайд-эффекты вне транзакции — через переменные ниже.
    pendingSideEffects.push(async () => {
      await bumpLiteLLMBudgetForCredits(sub.litellmKey, plan, plan.monthlyCredits)
      // Если ключ был заблокирован в past_due — разблокируем.
      if (sub.litellmKey) {
        try {
          await litellm.unblockKey(sub.litellmKey)
        } catch (err) {
          logger.warn({ err }, "unblockKey after renewal failed")
        }
      }
      invalidateLimitsCache(userId)
      const email = await getUserEmail(userId)
      if (email) {
        await sendEmail(
          paymentSucceededEmail({
            to: email,
            amountKopeck,
            description: `Продление подписки «${plan.titleRu}».`,
            creditsAdded: plan.monthlyCredits,
          }),
        ).catch(() => {})
      }
    })
  })

  await flushSideEffects()
}

/**
 * Fail — неудачный платёж. Для рекуррента: increment attemptNumber,
 * перевод в past_due, после 3 попыток — expired.
 */
async function handleFail(n: Notification): Promise<void> {
  const invoiceId = n.InvoiceId
  const userId = n.AccountId
  const amountKopeck = Math.round(parseFloat(n.Amount || "0") * 100)
  const reason = n.Reason || n.Message || `code ${n.ReasonCode ?? "?"}`
  const isSubscriptionRenewal = Boolean(n.SubscriptionId) || jsonField(n, "kind") === "subscription"

  await db.transaction(async (tx) => {
    if (invoiceId) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${invoiceId})::bigint)`)
    }
    if (!userId) {
      logger.warn({ invoiceId }, "Fail webhook without AccountId")
      return
    }
    const sub = await getSubscriptionByUser(userId)
    if (!sub) return

    // Сколько уже было неудачных попыток по этой подписке (для attemptNumber).
    const failedSoFar = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.subscriptionId, sub.id))
    const recurrentFails = failedSoFar.filter(
      (p) => p.kind === "subscription" && p.status === "failed",
    ).length
    const attemptNumber = recurrentFails + 1

    await tx.insert(schema.payments).values({
      userId,
      subscriptionId: sub.id,
      amountKopeck,
      status: "failed",
      kind: isSubscriptionRenewal ? "subscription" : "topup",
      cloudpaymentsInvoiceId: invoiceId || null,
      cloudpaymentsTransactionId: n.TransactionId || null,
      isRecurrent: true,
      attemptNumber,
      failureReason: reason,
      metadata: { invoiceId, reasonCode: n.ReasonCode },
    })

    if (isSubscriptionRenewal) {
      const now = new Date()
      const reachedLimit = attemptNumber >= MAX_RECURRENT_ATTEMPTS
      await tx
        .update(schema.subscriptions)
        .set({
          status: reachedLimit ? "expired" : "past_due",
          pastDueSince: sub.pastDueSince ?? now,
          updatedAt: now,
        })
        .where(eq(schema.subscriptions.id, sub.id))

      await tx.insert(schema.auditLog).values({
        actor: "webhook:cloudpayments",
        action: reachedLimit ? "subscription.expire" : "subscription.past_due",
        targetType: "subscription",
        targetId: sub.id,
        metadata: { attemptNumber, reason },
      })

      pendingSideEffects.push(async () => {
        invalidateLimitsCache(userId)
        const email = await getUserEmail(userId)
        if (reachedLimit) {
          const planTitle = await getPlanTitle(sub.planCode)
          if (sub.litellmKey) {
            try {
              await litellm.blockKey(sub.litellmKey)
            } catch (err) {
              logger.warn({ err }, "blockKey on expire failed")
            }
          }
          if (email) {
            await sendEmail(subscriptionExpiredEmail({ to: email, planTitleRu: planTitle })).catch(
              () => {},
            )
          }
        } else if (email) {
          await sendEmail(
            paymentFailedEmail({ to: email, amountKopeck, reason, attemptNumber }),
          ).catch(() => {})
        }
      })
    }
  })

  await flushSideEffects()
}

/**
 * Recurrent — изменение статуса подписки на стороне CloudPayments.
 * Status: Active | PastDue | Cancelled | Rejected | Expired.
 */
async function handleRecurrent(n: Notification): Promise<void> {
  const userId = n.AccountId
  if (!userId) return
  const status = (n.Status || "").toLowerCase()

  const sub = await getSubscriptionByUser(userId)
  if (!sub) return

  let newStatus: "active" | "past_due" | "expired" | "canceled" | null = null
  if (status === "active") newStatus = "active"
  else if (status === "pastdue") newStatus = "past_due"
  else if (status === "cancelled" || status === "canceled") newStatus = "canceled"
  else if (status === "rejected" || status === "expired") newStatus = "expired"

  if (!newStatus) {
    logger.info({ status }, "Recurrent webhook: unmapped status, acknowledging")
    return
  }

  const now = new Date()
  await db
    .update(schema.subscriptions)
    .set({
      status: newStatus,
      pastDueSince: newStatus === "past_due" ? (sub.pastDueSince ?? now) : null,
      updatedAt: now,
    })
    .where(eq(schema.subscriptions.id, sub.id))

  await db.insert(schema.auditLog).values({
    actor: "webhook:cloudpayments",
    action: "subscription.recurrent_status",
    targetType: "subscription",
    targetId: sub.id,
    metadata: { status: newStatus },
  })

  invalidateLimitsCache(userId)

  if ((newStatus === "expired" || newStatus === "canceled") && sub.litellmKey) {
    try {
      await litellm.blockKey(sub.litellmKey)
    } catch (err) {
      logger.warn({ err }, "blockKey on recurrent status failed")
    }
  }
}

/** Receipt — фискальный чек создан. Только аудит. */
async function handleReceipt(n: Notification): Promise<void> {
  await db.insert(schema.auditLog).values({
    actor: "webhook:cloudpayments",
    action: "receipt.created",
    targetType: "payment",
    targetId: n.InvoiceId || null,
    metadata: { invoiceId: n.InvoiceId, amount: n.Amount },
  })
}

// ===== Внутренние утилиты =====

/**
 * Сайд-эффекты (LiteLLM, email, cache) копим во время транзакции и выполняем
 * после коммита — чтобы внешние сбои не откатывали БД и наоборот.
 * Простой module-scope буфер достаточен: webhook'и обрабатываются последовательно
 * на запрос, а каждая функция вызывает flush в конце.
 */
const pendingSideEffects: Array<() => Promise<void>> = []

async function flushSideEffects(): Promise<void> {
  const effects = pendingSideEffects.splice(0, pendingSideEffects.length)
  for (const fn of effects) {
    try {
      await fn()
    } catch (err) {
      logger.warn({ err }, "webhook side-effect failed (non-fatal)")
    }
  }
}

interface UpsertPaymentInput {
  userId: string
  subscriptionId: string
  amountKopeck: number
  kind: "subscription" | "topup" | "refund"
  invoiceId: string | undefined
  txnId: string | null
  isRecurrent?: boolean
  metadata?: Record<string, unknown>
}

/**
 * Создать или обновить платёж до статуса success по InvoiceId.
 * Вызывается уже под advisory-lock и после проверки идемпотентности.
 */
async function upsertSuccessPayment(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: UpsertPaymentInput,
): Promise<void> {
  const now = new Date()
  if (input.invoiceId) {
    const existing = await tx
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.cloudpaymentsInvoiceId, input.invoiceId))
      .limit(1)
    if (existing[0]) {
      await tx
        .update(schema.payments)
        .set({
          status: "success",
          cloudpaymentsTransactionId: input.txnId,
          paidAt: now,
          failureReason: null,
        })
        .where(eq(schema.payments.id, existing[0].id))
      return
    }
  }
  await tx.insert(schema.payments).values({
    userId: input.userId,
    subscriptionId: input.subscriptionId,
    amountKopeck: input.amountKopeck,
    status: "success",
    kind: input.kind,
    cloudpaymentsInvoiceId: input.invoiceId || null,
    cloudpaymentsTransactionId: input.txnId,
    isRecurrent: input.isRecurrent ?? false,
    paidAt: now,
    metadata: input.metadata ?? { invoiceId: input.invoiceId },
  })
}

async function getUserEmail(userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)
  return rows[0]?.email ?? null
}

async function getPlanTitle(planCode: string): Promise<string> {
  const rows = await db
    .select({ titleRu: schema.plans.titleRu })
    .from(schema.plans)
    .where(eq(schema.plans.code, planCode))
    .limit(1)
  return rows[0]?.titleRu ?? planCode
}

/** Достать поле из присланного JsonData/Data (CloudPayments кладёт наш JsonData в Data). */
function jsonField(n: Notification, key: string): string | null {
  const raw = n.Data || n.JsonData
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const v = obj[key]
    return v == null ? null : String(v)
  } catch {
    return null
  }
}

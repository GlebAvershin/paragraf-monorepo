/**
 * Integration-тест платёжного флоу CloudPayments (ТЗ-02).
 *
 * Поднимает in-process mock CloudPayments API и прогоняет реальный код billing
 * (роуты /payments/*, /webhooks/cloudpayments) через app.fetch — без сети,
 * без реального эквайринга, без регистрации в CloudPayments.
 *
 * Покрывает: привязку карты, докупку, отказ карты, неизвестный пакет,
 * webhook HMAC (валидный/невалидный), идемпотентность webhook.
 *
 * ВАЖНО: этот тест нашёл реальный баг — tx.execute({sql,args}) вместо
 * drizzle sql-template падал в рантайме (advisory lock). Регрессионная защита.
 *
 * Требует: запущенный Postgres billing (docker compose up -d).
 * Запуск:  bun test test/payments-flow.test.ts
 *
 * NB: config.ts читает process.env при импорте, а ES-import'ы hoisted —
 * поэтому ВСЕ модули, тянущие config, импортируются ДИНАМИЧЕСКИ в beforeAll,
 * уже после установки env ниже.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { Hono } from "hono"

// ── env ДО любого config-зависимого импорта ──────────────────────────────────
process.env.NODE_ENV = "test"
process.env.CLOUDPAYMENTS_PUBLIC_ID = "test_pub"
process.env.CLOUDPAYMENTS_API_SECRET = "test_secret"
process.env.CLOUDPAYMENTS_WEBHOOK_SECRET = "test_webhook_secret"
process.env.CLOUDPAYMENTS_API_URL = "http://localhost:9998"

const WEBHOOK_SECRET = "test_webhook_secret"

// ── in-process mock CloudPayments ────────────────────────────────────────────
const mock = new Hono()
let mockTxn = 5000

mock.post("/payments/cards/auth", async (c) => {
  const b = (await c.req.json()) as Record<string, unknown>
  if (String(b.CardCryptogramPacket ?? "").includes("decline")) {
    return c.json({ Success: false, Message: "Карта отклонена (mock)", Model: null })
  }
  const id = mockTxn++
  return c.json({
    Success: true,
    Model: { TransactionId: id, Token: `tok_${id}`, CardLastFour: "4242", CardType: "Visa", CardExpDate: "12/30" },
  })
})
mock.post("/payments/void", (c) => c.json({ Success: true }))
mock.post("/payments/tokens/charge", async (c) => {
  const b = (await c.req.json()) as Record<string, unknown>
  if (String(b.Token ?? "").includes("decline")) {
    return c.json({ Success: false, Message: "Недостаточно средств (mock)", Model: { Reason: "InsufficientFunds" } })
  }
  return c.json({ Success: true, Model: { TransactionId: mockTxn++ } })
})

// ── состояние, заполняется в beforeAll (динамические импорты) ─────────────────
let mockServer: ReturnType<typeof Bun.serve> | undefined
let appFetch: (req: Request) => Response | Promise<Response>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let schema: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let eqFn: any

const TEST_EMAIL = `payflow-${Date.now()}@test.local`
let userId = ""
let subId = ""
let token = ""

function signBody(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("base64")
}
function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

beforeAll(async () => {
  mockServer = Bun.serve({ port: 9998, fetch: mock.fetch })

  // Динамические импорты — config читает уже установленные выше env.
  const drizzle = await import("drizzle-orm")
  eqFn = drizzle.eq
  const client = await import("../src/db/client.ts")
  db = client.db
  schema = client.schema
  const auth = await import("../src/lib/auth.ts")
  const appMod = (await import("../src/index.ts")) as { default: { fetch: typeof appFetch } }
  appFetch = appMod.default.fetch

  const [u] = await db
    .insert(schema.users)
    .values({ email: TEST_EMAIL, emailVerifiedAt: new Date(), lastLoginAt: new Date() })
    .returning({ id: schema.users.id })
  userId = u.id

  const now = new Date()
  const periodEnd = new Date(now.getTime() + 30 * 24 * 3600 * 1000)
  const [s] = await db
    .insert(schema.subscriptions)
    .values({
      userId,
      planCode: "free",
      status: "trial",
      trialEndsAt: periodEnd,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      litellmKey: "sk-test-noop",
    })
    .returning({ id: schema.subscriptions.id })
  subId = s.id

  await db.insert(schema.creditGrants).values({
    subscriptionId: subId,
    amountCredits: 30,
    remainingCredits: 30,
    reason: "trial",
    expiresAt: periodEnd,
  })

  token = await auth.issueSession({ sub: userId, email: TEST_EMAIL })
})

afterAll(async () => {
  // Явный порядок удаления (FK не везде CASCADE): дети → подписка → юзер.
  if (db && userId) {
    try {
      await db.delete(schema.creditGrants).where(eqFn(schema.creditGrants.subscriptionId, subId))
      await db.delete(schema.payments).where(eqFn(schema.payments.userId, userId))
      await db.delete(schema.paymentMethods).where(eqFn(schema.paymentMethods.userId, userId))
      await db.delete(schema.usageEvents).where(eqFn(schema.usageEvents.subscriptionId, subId))
      await db.delete(schema.subscriptions).where(eqFn(schema.subscriptions.userId, userId))
      await db.delete(schema.users).where(eqFn(schema.users.id, userId))
    } catch {
      // best-effort cleanup
    }
  }
  mockServer?.stop(true)
})

// ── тесты ────────────────────────────────────────────────────────────────────

test("баланс до операций = 30", async () => {
  const res = await appFetch(new Request("http://x/limits", { headers: authHeaders() }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { credits: { remaining: number } }
  expect(body.credits.remaining).toBe(30)
})

test("привязка карты: cards/auth → void → токен сохранён", async () => {
  const res = await appFetch(
    new Request("http://x/payments/method", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ cryptogram: "ok_crypto_123" }),
    }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { cardLast4: string; cardBrand: string }
  expect(body.cardLast4).toBe("4242")
  expect(body.cardBrand).toBe("visa")
})

test("докупка p500: +500 кредитов, баланс 530", async () => {
  const res = await appFetch(
    new Request("http://x/payments/topup", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ package: "p500" }),
    }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { creditsAdded: number; newBalance: number }
  expect(body.creditsAdded).toBe(500)
  expect(body.newBalance).toBe(530)
})

test("отказ карты → 402 card_declined (не 5xx)", async () => {
  const res = await appFetch(
    new Request("http://x/payments/method", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ cryptogram: "decline_this_card" }),
    }),
  )
  expect(res.status).toBe(402)
  const body = (await res.json()) as { error: string }
  expect(body.error).toBe("card_declined")
})

test("неизвестный пакет → 400 unknown_package", async () => {
  const res = await appFetch(
    new Request("http://x/payments/topup", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ package: "p9999" }),
    }),
  )
  expect(res.status).toBe(400)
})

test("webhook невалидный HMAC → 401", async () => {
  const body = `TransactionId=1&InvoiceId=bad_${Date.now()}&Amount=990.00&AccountId=${userId}`
  const res = await appFetch(
    new Request("http://x/webhooks/cloudpayments?type=pay", {
      method: "POST",
      headers: { "Content-HMAC": "ZmFrZQ==", "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
  )
  expect(res.status).toBe(401)
})

test("webhook валидный HMAC → code:0, идемпотентность (повтор не дублирует)", async () => {
  const invoiceId = `sub_recur_${Date.now()}`
  const body = `TransactionId=992&InvoiceId=${invoiceId}&Amount=990.00&AccountId=${userId}&Currency=RUB&SubscriptionId=sc_test`
  const headers = {
    "Content-HMAC": signBody(body),
    "Content-Type": "application/x-www-form-urlencoded",
  }

  const r1 = await appFetch(
    new Request("http://x/webhooks/cloudpayments?type=pay", { method: "POST", headers, body }),
  )
  expect(r1.status).toBe(200)
  expect((await r1.json()) as { code: number }).toEqual({ code: 0 })

  const r2 = await appFetch(
    new Request("http://x/webhooks/cloudpayments?type=pay", { method: "POST", headers, body }),
  )
  expect((await r2.json()) as { code: number }).toEqual({ code: 0 })

  const rows = await db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(eqFn(schema.payments.cloudpaymentsInvoiceId, invoiceId))
  expect(rows.length).toBe(1)
})

/**
 * E2E «золотой сценарий» (план §13) — backend-часть через app.fetch.
 *
 * Прогоняет критичный бизнес-путь, как реальный пользователь:
 *   1. Вход по OTP-коду → JWT (существующий юзер с Free-подпиской)
 *   2. Профессия сохраняется в профиле
 *   3. Старт: баланс = 30 кредитов (триал)
 *   4. Запрос к модели → ETL-style списание кредитов (chargeCredits)
 *   5. Баланс уменьшился (30 → 18)
 *   6. Аналитика /usage/summary показывает расход по сценарию/модели
 *   7. Идемпотентность: повтор того же requestId не списывает дважды
 *   8. CSV-экспорт содержит событие
 *
 * НЕ покрывает: реальный gateway-вызов модели (нужен LiteLLM-ключ) и
 * DOCX-экспорт (desktop-функция). Здесь — биллинговая логика, где баги дороже.
 *
 * Требует: запущенный Postgres billing (docker compose up -d).
 * Запуск:  bun run test:e2e
 *
 * NB: ES-import'ы hoisted → config-зависимые модули импортируются ДИНАМИЧЕСКИ
 * в beforeAll, после установки env ниже (тот же приём, что в payments-flow.test.ts).
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"

// -- env до config-зависимых импортов --
// CLOUDPAYMENTS_* выставлены так же, как в payments-flow.test.ts — чтобы при
// совместном запуске (общий `bun test`, один процесс, config-singleton) оба
// файла видели одинаковый config независимо от порядка загрузки.
process.env.NODE_ENV = "test"
process.env.CLOUDPAYMENTS_PUBLIC_ID = "test_pub"
process.env.CLOUDPAYMENTS_API_SECRET = "test_secret"
process.env.CLOUDPAYMENTS_WEBHOOK_SECRET = "test_webhook_secret"
process.env.CLOUDPAYMENTS_API_URL = "http://localhost:9998"

// -- состояние (динамические импорты в beforeAll) --
let appFetch: (req: Request) => Response | Promise<Response>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let schema: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let eqFn: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chargeCredits: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let invalidateLimitsCache: any
// Имитация полного ETL-пути: списать + сбросить кэш баланса (как ETL в проде).
const etlCharge = async (input: Record<string, unknown>) => {
  const r = await chargeCredits(input)
  invalidateLimitsCache(userId)
  return r
}

const TEST_EMAIL = `golden-${Date.now()}@test.local`
const OTP_PLAIN = "424242"
let userId = ""
let subId = ""
let token = ""

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex")

beforeAll(async () => {
  const drizzle = await import("drizzle-orm")
  eqFn = drizzle.eq
  const client = await import("../src/db/client.ts")
  db = client.db
  schema = client.schema
  const credits = await import("../src/lib/credits.ts")
  chargeCredits = credits.chargeCredits
  const limits = await import("../src/routes/limits.ts")
  invalidateLimitsCache = limits.invalidateLimitsCache
  const appMod = (await import("../src/index.ts")) as { default: { fetch: typeof appFetch } }
  appFetch = appMod.default.fetch

  // Юзер + Free-подписка + триал-грант 30 кредитов.
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
      litellmKey: "sk-test-golden",
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
})

afterAll(async () => {
  if (db && userId) {
    try {
      await db.delete(schema.creditGrants).where(eqFn(schema.creditGrants.subscriptionId, subId))
      await db.delete(schema.usageEvents).where(eqFn(schema.usageEvents.subscriptionId, subId))
      await db.delete(schema.magicLinkTokens).where(eqFn(schema.magicLinkTokens.email, TEST_EMAIL))
      await db.delete(schema.subscriptions).where(eqFn(schema.subscriptions.userId, userId))
      await db.delete(schema.users).where(eqFn(schema.users.id, userId))
    } catch {
      // best-effort
    }
  }
})

const authHeaders = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" })

// ── 1. Вход по OTP-коду ──────────────────────────────────────────────────────
test("шаг 1: вход по OTP-коду → JWT", async () => {
  // Кладём magic-link токен с известным OTP (обходим email — plain код не в БД).
  await db.insert(schema.magicLinkTokens).values({
    email: TEST_EMAIL,
    tokenHash: sha256hex(`tok-${Date.now()}`),
    otpHash: sha256hex(OTP_PLAIN),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  })

  const res = await appFetch(
    new Request("http://x/auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, code: OTP_PLAIN }),
    }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { token: string; user: { email: string } }
  expect(body.user.email).toBe(TEST_EMAIL)
  expect(body.token.length).toBeGreaterThan(20)
  token = body.token
})

// ── 2. Персональная профессия ─────────────────────────────────────────────────
test("шаг 2: выбранная профессия сохраняется в профиле", async () => {
  const patch = await appFetch(
    new Request("http://x/me", {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ primaryVertical: "accountant" }),
    }),
  )
  expect(patch.status).toBe(200)
  expect(((await patch.json()) as { user: { primaryVertical: string } }).user.primaryVertical).toBe("accountant")

  const me = await appFetch(new Request("http://x/me", { headers: authHeaders() }))
  expect(me.status).toBe(200)
  expect(((await me.json()) as { user: { primaryVertical: string } }).user.primaryVertical).toBe("accountant")
})

// ── 3. Старт: баланс 30 ──────────────────────────────────────────────────────
test("шаг 3: стартовый баланс = 30 кредитов", async () => {
  const res = await appFetch(new Request("http://x/limits", { headers: authHeaders() }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { credits: { remaining: number; monthlyTotal: number } }
  expect(body.credits.remaining).toBe(30)
})

// ── 4-5. Списание за сценарий → баланс 18 ────────────────────────────────────
test("шаг 4-5: списание 12 кредитов за сценарий → баланс 18", async () => {
  const result = await etlCharge({
    subscriptionId: subId,
    credits: 12,
    model: "minimax/minimax-m3",
    provider: "openrouter",
    inputTokens: 8000,
    outputTokens: 2000,
    costUsdMicroCenti: 120000,
    requestId: "golden-req-1",
    scenarioId: "law.contract.review",
  })
  expect(result.charged).toBe(12)
  expect(result.shortfall).toBe(0)

  const res = await appFetch(new Request("http://x/limits", { headers: authHeaders() }))
  const body = (await res.json()) as { credits: { remaining: number } }
  expect(body.credits.remaining).toBe(18)
})

// ── 6. Аналитика показывает расход ───────────────────────────────────────────
test("шаг 6: /usage/summary показывает расход по сценарию и модели", async () => {
  const res = await appFetch(new Request("http://x/usage/summary", { headers: authHeaders() }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    totalCredits: number
    totalRequests: number
    byModel: Array<{ model: string; credits: number }>
    byScenario: Array<{ scenarioId: string; credits: number }>
  }
  expect(body.totalCredits).toBe(12)
  expect(body.totalRequests).toBe(1)
  expect(body.byModel.find((m) => m.model === "minimax/minimax-m3")?.credits).toBe(12)
  expect(body.byScenario.find((s) => s.scenarioId === "law.contract.review")?.credits).toBe(12)
})

// ── 7. Идемпотентность списания ──────────────────────────────────────────────
test("шаг 7: повтор того же requestId не списывает дважды", async () => {
  await etlCharge({
    subscriptionId: subId,
    credits: 12,
    model: "minimax/minimax-m3",
    provider: "openrouter",
    inputTokens: 8000,
    outputTokens: 2000,
    costUsdMicroCenti: 120000,
    requestId: "golden-req-1", // тот же requestId
    scenarioId: "law.contract.review",
  })

  const res = await appFetch(new Request("http://x/limits", { headers: authHeaders() }))
  const body = (await res.json()) as { credits: { remaining: number } }
  expect(body.credits.remaining).toBe(18) // НЕ 6 — повтор не списал
})

// ── 8. CSV-экспорт ───────────────────────────────────────────────────────────
test("шаг 8: /usage/export.csv содержит событие", async () => {
  const res = await appFetch(new Request("http://x/usage/export.csv", { headers: authHeaders() }))
  expect(res.status).toBe(200)
  const csv = await res.text()
  expect(csv).toContain("minimax/minimax-m3")
  expect(csv).toContain("law.contract.review")
})

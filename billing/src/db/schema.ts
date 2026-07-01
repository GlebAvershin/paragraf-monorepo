/**
 * Drizzle ORM schema for Billing service.
 * Owns: users, subscriptions, plans, payment_methods, payments, usage_events,
 *       credit_grants, audit_log, magic_link_tokens.
 *
 * All PII (email, name, card details) lives here in RU jurisdiction (152-ФЗ).
 */
import { sql } from "drizzle-orm"
import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  bigserial,
  numeric,
} from "drizzle-orm/pg-core"

// ===== Enums =====

export const verticalEnum = pgEnum("vertical", ["lawyer", "accountant", "manager", "other"])
export const userStatusEnum = pgEnum("user_status", ["active", "blocked"])
export const subStatusEnum = pgEnum("sub_status", [
  "trial",
  "active",
  "past_due",
  "canceled",
  "expired",
])
export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "success",
  "failed",
  "refunded",
])
export const paymentKindEnum = pgEnum("payment_kind", [
  "subscription", // подписочное (рекуррентное) списание
  "topup", // разовая докупка пакета кредитов
  "refund", // возврат (заложено на будущее — Phase 3)
])
export const creditReasonEnum = pgEnum("credit_reason", [
  "trial",
  "promo",
  "support_compensation",
  "subscription_monthly", // выдаётся при каждом успешном продлении подписки
  "topup", // докупка вне подписки — переносится на 1 след. месяц
])

export const modelTierEnum = pgEnum("model_tier", ["lite", "mid", "top"])

// ===== Tariff plans (static catalog) =====

export const plans = pgTable("plans", {
  code: text("code").primaryKey(), // "free", "start", "pro", "team"
  titleRu: text("title_ru").notNull(),
  description: text("description"),
  priceRubKopeck: integer("price_rub_kopeck").notNull().default(0),
  // Budget assigned to the virtual_key in LiteLLM, in cents.
  // Derived: monthlyCredits × calibration $/credit + 25% маржа/FX-буфер.
  monthlyBudgetUsdCenti: integer("monthly_budget_usd_centi").notNull(),
  // Главная UI-единица: сколько кредитов начисляется при оплате подписки.
  // 1 кредит ≈ 1500 in + 500 out токенов на Lite-модели.
  monthlyCredits: integer("monthly_credits").notNull().default(0),
  // DEPRECATED 2026-05-24 — оставлено для миграционной обратной совместимости.
  // Новые поля: monthlyCredits. После prod-миграции удалить.
  monthlyTasksTarget: integer("monthly_tasks_target").notNull(),
  allowedModels: jsonb("allowed_models").$type<string[]>().notNull(),
  features: jsonb("features").$type<Record<string, unknown>>().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

// ===== Model rates (множители кредитов) =====
//
// Источник правды множителей: подгоняем так, чтобы маржа держалась 30-40%
// поверх провайдерских цен. Калибровка: 1 кредит = 1500 in + 500 out токенов
// на Lite-модели → провайдерская цена служит anchor'ом.

export const modelRates = pgTable("model_rates", {
  modelCode: text("model_code").primaryKey(), // e.g. "claude-sonnet-4-5", "gigachat-pro"
  provider: text("provider").notNull(), // "anthropic" | "openai" | "gigachat" | "yandex"
  tier: modelTierEnum("tier").notNull(),
  // Множитель списания кредитов. Decimal с 2 знаками после запятой.
  // Lite=1.00, Mid=1.50, Top=2.20 (стартовые гипотезы — корректируются после пилота).
  multiplier: numeric("multiplier", { precision: 4, scale: 2 }).notNull(),
  // Калибровочные параметры — сколько токенов даёт «1 единицу работы».
  calibrationTokensIn: integer("calibration_tokens_in").notNull().default(1500),
  calibrationTokensOut: integer("calibration_tokens_out").notNull().default(500),
  // Провайдерские цены за 1K токенов, в micro-centi USD (для precision).
  // Пример: Claude Sonnet 4.5 input = $3/1M = 300 micro-cents/1K → 300000.
  providerPricePer1kInputUsdMicroCenti: bigint("provider_price_per_1k_input_usd_micro_centi", {
    mode: "number",
  })
    .notNull()
    .default(0),
  providerPricePer1kOutputUsdMicroCenti: bigint("provider_price_per_1k_output_usd_micro_centi", {
    mode: "number",
  })
    .notNull()
    .default(0),
  displayNameRu: text("display_name_ru").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// ===== Users =====

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    name: text("name"),
    // Опциональный пароль — параллельный OTP способ входа (демо/тест-период,
    // 2026-07-01). NULL у обычных пользователей (они входят по OTP).
    passwordHash: text("password_hash"),
    primaryVertical: verticalEnum("primary_vertical"),
    status: userStatusEnum("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_unique").on(t.email),
  }),
)

// ===== Subscriptions =====

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    planCode: text("plan_code")
      .notNull()
      .references(() => plans.code, { onDelete: "restrict" }),
    status: subStatusEnum("status").notNull(),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    // Тариф, на который подписка переключится в начале следующего периода
    // (downgrade применяется отложенно — деньги за разницу не возвращаем).
    pendingPlanCode: text("pending_plan_code").references(() => plans.code, {
      onDelete: "set null",
    }),
    // Момент перехода в past_due (для расчёта 7-дневного окна ретраев → expired).
    pastDueSince: timestamp("past_due_since", { withTimezone: true }),
    // LiteLLM virtual_key string (sk-...) — this is what the desktop app uses.
    // Sensitive: never log in plain text.
    litellmKey: text("litellm_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("subscriptions_user_idx").on(t.userId),
    statusIdx: index("subscriptions_status_idx").on(t.status),
    periodEndIdx: index("subscriptions_period_end_idx").on(t.currentPeriodEnd),
  }),
)

// ===== Payment methods (stored CloudPayments recurrent tokens) =====

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // CloudPayments recurrent token. Encrypted at rest in production.
    cloudpaymentsToken: text("cloudpayments_token").notNull(),
    cardLast4: text("card_last4"),
    cardBrand: text("card_brand"),
    isDefault: boolean("is_default").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("payment_methods_user_idx").on(t.userId),
  }),
)

// ===== Payments (every transaction) =====

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id),
    amountKopeck: integer("amount_kopeck").notNull(),
    currency: text("currency").notNull().default("RUB"),
    status: paymentStatusEnum("status").notNull(),
    // Тип платежа: подписка / докупка / возврат.
    kind: paymentKindEnum("kind").notNull().default("subscription"),
    cloudpaymentsTransactionId: text("cloudpayments_transaction_id"),
    cloudpaymentsInvoiceId: text("cloudpayments_invoice_id"),
    isRecurrent: boolean("is_recurrent").notNull().default(false),
    attemptNumber: integer("attempt_number").notNull().default(1),
    failureReason: text("failure_reason"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // Произвольные метаданные: { invoiceId, planCode, package, creditsAdded, ... }.
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    txnIdx: uniqueIndex("payments_txn_unique")
      .on(t.cloudpaymentsTransactionId)
      .where(sql`${t.cloudpaymentsTransactionId} IS NOT NULL`),
    // Идемпотентность по InvoiceId — повторный webhook/charge не дублирует платёж.
    invoiceIdx: uniqueIndex("payments_invoice_unique")
      .on(t.cloudpaymentsInvoiceId)
      .where(sql`${t.cloudpaymentsInvoiceId} IS NOT NULL`),
    userIdx: index("payments_user_idx").on(t.userId),
  }),
)

// ===== Usage events (mirror from LiteLLM for our analytics) =====

export const usageEvents = pgTable(
  "usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    // Cost in 1/100 cents (4 decimal places of a dollar) for precision.
    costUsdMicroCenti: bigint("cost_usd_micro_centi", { mode: "number" }).notNull().default(0),
    // Credit charge applied to user: round(tokens × multiplier × calibration).
    // 0 для бесплатных операций (health checks, ETL-самозапросы).
    creditsCharged: integer("credits_charged").notNull().default(0),
    scenarioId: text("scenario_id"),
    requestId: text("request_id"),
    status: text("status").notNull().default("ok"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subIdx: index("usage_events_sub_idx").on(t.subscriptionId),
    createdIdx: index("usage_events_created_idx").on(t.createdAt),
    requestIdx: uniqueIndex("usage_events_request_unique")
      .on(t.requestId)
      .where(sql`${t.requestId} IS NOT NULL`),
  }),
)

// ===== Credit grants (trials, promos) =====

export const creditGrants = pgTable(
  "credit_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    // Главное поле — количество выданных кредитов.
    amountCredits: integer("amount_credits").notNull().default(0),
    // DEPRECATED 2026-05-24 — оставлено для совместимости со старыми записями.
    // Новые записи: amountCredits. После prod-миграции удалить.
    amountUsdCenti: integer("amount_usd_centi").notNull().default(0),
    // Остаток (стартует от amountCredits, уменьшается при списании).
    remainingCredits: integer("remaining_credits").notNull().default(0),
    reason: creditReasonEnum("reason").notNull(),
    // Платёж-источник (для topup-grants — ссылка на конкретную оплату докупки).
    paymentId: uuid("payment_id"),
    // expiresAt:
    //   - subscription_monthly: == subscription.currentPeriodEnd (сгорает с подпиской)
    //   - topup: subscription.currentPeriodEnd + 30 days (переносится на 1 месяц)
    //   - trial / promo / support_compensation: по ситуации
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // consumedAt — когда remainingCredits достиг 0 (или истёк).
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    subIdx: index("credit_grants_sub_idx").on(t.subscriptionId),
    // Для FIFO-списания: сначала самые ранние expiresAt (чтобы не сгорело)
    consumeOrderIdx: index("credit_grants_consume_order_idx").on(
      t.subscriptionId,
      t.expiresAt,
      t.createdAt,
    ),
  }),
)

// ===== Audit log (for sensitive operations) =====

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actor: text("actor").notNull(), // 'user:<id>' | 'admin:<id>' | 'system' | 'webhook:cloudpayments'
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
})

// ===== Magic-link tokens (passwordless auth) =====

export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    // sha256 of the actual token sent in email. Plain token never stored.
    tokenHash: text("token_hash").notNull(),
    // sha256 of the 6-digit OTP code (для desktop-входа без deep-link).
    // NULL для строк, созданных до миграции.
    otpHash: text("otp_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // Счётчик неудачных попыток ввода кода. После MAX_OTP_ATTEMPTS (auth.ts)
    // строка считается исчерпанной — защита от перебора 6-значного OTP.
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex("magic_link_token_hash_unique").on(t.tokenHash),
    emailIdx: index("magic_link_email_idx").on(t.email),
  }),
)

// ===== Waitlist (лендинг: менеджеры — Фаза 4) =====

export const waitlistSignups = pgTable(
  "waitlist_signups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** Какую вертикаль ждёт (manager / other). */
    interest: text("interest").notNull().default("manager"),
    /** Источник (utm/страница), на будущее. */
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUnique: uniqueIndex("waitlist_email_unique").on(t.email),
  }),
)

// ===== Type helpers =====

export type User = typeof users.$inferSelect
export type Subscription = typeof subscriptions.$inferSelect
export type Plan = typeof plans.$inferSelect
export type Payment = typeof payments.$inferSelect
export type UsageEvent = typeof usageEvents.$inferSelect
export type CreditGrant = typeof creditGrants.$inferSelect
export type ModelRate = typeof modelRates.$inferSelect

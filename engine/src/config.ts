/**
 * Config движка (fail-fast на отсутствии секретов).
 * JWT_* должны совпадать с billing — движок проверяет ТОТ ЖЕ session-JWT (sub = userId).
 */
const required = (name: string): string => {
  const v = process.env[name]
  if (!v) {
    console.error(`[engine] missing required env: ${name}`)
    process.exit(1)
  }
  return v
}

export const config = {
  PORT: Number(process.env.PORT ?? 4096),
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",

  // Те же значения, что в billing/.env — движок верифицирует billing-JWT.
  JWT_SECRET: required("JWT_SECRET"),
  JWT_ISSUER: process.env.JWT_ISSUER ?? "billing.local",
  JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? "ourapp-desktop",

  // gateway-app (РФ) — движок шлёт СЫРОЙ текст сюда; маскирование/модель/ML — там.
  // Раньше движок ходил прямо в LiteLLM (:4000); теперь между ними app-слой (:4100).
  ANSWER_URL: process.env.ANSWER_URL ?? "http://localhost:4100",
  // Общий секрет с gateway: движок шлёт его заголовком X-Internal-Key, gateway
  // принимает только запросы с ним. Должен совпадать с GATEWAY_API_SECRET шлюза.
  // Пусто → заголовок не шлём (gateway тогда тоже без проверки — dev).
  ANSWER_SECRET: process.env.GATEWAY_API_SECRET ?? "",

  // Billing — движок берёт litellm-ключ юзера (для бюджета/кредитов per-user).
  // 127.0.0.1, НЕ localhost: Bun на Windows не резолвит localhost (как в billing/CLAUDE.md).
  BILLING_URL: process.env.BILLING_URL ?? "http://127.0.0.1:3000",

  // Хранилище сессий/сообщений (РФ-хостинг по 152-ФЗ). Своя БД, как у billing.
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://engine:engine@localhost:5434/engine",

  // Публичный домен веб-фронта (прод CORS-allowlist) — тот же паттерн, что
  // billing/config.ts APP_PUBLIC_URL. Пусто в dev (localhost/127.0.0.1 разрешены
  // всегда через regex ниже в index.ts).
  WEB_PUBLIC_URL: process.env.WEB_PUBLIC_URL ?? "",
} as const

export const isProd = process.env.NODE_ENV === "production"

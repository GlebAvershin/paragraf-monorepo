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

  // gost-rag — база знаний ГОСТ. Помощник инженера ЗАЗЕМЛЯЕТ ответы: движок дёргает /retrieve,
  // подмешивает выдержки в системный промпт и отдаёт источники в metadata. Генерация остаётся на
  // шлюзе с ключом юзера → биллинг считается как обычно. Включается флагом ИЛИ agent==="gost".
  GOST_RAG_URL: process.env.GOST_RAG_URL ?? "http://localhost:8000",
  GOST_RAG_ENABLED: (process.env.GOST_RAG_ENABLED ?? "false") === "true",
  GOST_MIN_SCORE: Number(process.env.GOST_MIN_SCORE ?? 0), // < этого top_score → abstain; 0 = только при пустой выдаче
  GOST_TOP_K: Number(process.env.GOST_TOP_K ?? 8),

  // Хранилище сессий/сообщений (РФ-хостинг по 152-ФЗ). Своя БД, как у billing.
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://engine:engine@localhost:5434/engine",
} as const

export const isProd = process.env.NODE_ENV === "production"

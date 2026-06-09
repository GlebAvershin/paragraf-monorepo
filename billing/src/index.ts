/**
 * Billing service — entry point.
 *
 * Owns user accounts, subscriptions, and the bridge to LiteLLM virtual keys.
 * Deployed in RU jurisdiction (152-ФЗ for PII storage).
 *
 * Endpoints (Phase 1):
 *   POST /auth/magic-link        — request login link by email
 *   GET  /auth/verify?token=...  — exchange for session JWT
 *   GET  /me                     — profile + LiteLLM key for desktop
 *   GET  /limits                 — current credit balance (sidebar indicator)
 *   GET  /credits/rates          — каталог моделей с множителями (UI dropdown)
 *   POST /credits/preview        — оценка стоимости запроса (UI «~12 кредитов»)
 *   GET  /subscriptions/current  — current subscription metadata
 *   POST /subscriptions/change-plan — upgrade (prorated) / downgrade (deferred)
 *   POST /payments/method        — attach card (CloudPayments tokenization)
 *   POST /payments/topup         — one-off credit package purchase
 *   GET  /payments/history       — payment history for /credits UI
 *   POST /webhooks/cloudpayments — CloudPayments notifications (Pay/Fail/Recurrent/Receipt)
 *   GET  /health/liveliness      — process alive
 *   GET  /health/readiness       — process + DB ready
 */
import { Hono } from "hono"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import { secureHeaders } from "hono/secure-headers"
import { config } from "./config.ts"
import { logger } from "./lib/logger.ts"
import { authRoutes } from "./routes/auth.ts"
import { meRoutes } from "./routes/me.ts"
import { limitsRoutes } from "./routes/limits.ts"
import { creditsRoutes } from "./routes/credits.ts"
import { subscriptionRoutes } from "./routes/subscriptions.ts"
import { paymentRoutes } from "./routes/payments.ts"
import { webhookRoutes } from "./routes/webhooks.ts"
import { usageRoutes } from "./routes/usage.ts"
import { healthRoutes } from "./routes/health.ts"
import { waitlistRoutes } from "./routes/waitlist.ts"

const app = new Hono()

// ----- Global middleware -----
// secureHeaders по умолчанию ставит Cross-Origin-Resource-Policy: same-origin,
// что блокирует cross-origin fetch из Electron renderer (127.0.0.1:5173 → localhost:3000).
// Переключаем на cross-origin — это безопасно для API-сервера который и так
// защищён JWT + CORS allowlist.
app.use("*", secureHeaders({ crossOriginResourcePolicy: "cross-origin" }))
// CORS: разрешаем localhost / 127.0.0.1 на любом порту (vite renderer),
// плюс file:// (когда desktop из production-сборки) и конфиг APP_PUBLIC_URL.
// Hono cors.origin принимает function — это позволяет regex-проверки.
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin // same-origin / file://
      if (origin === config.APP_PUBLIC_URL) return origin
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin
      return null
    },
    credentials: true,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
)

// Lightweight request logging.
app.use("*", async (c, next) => {
  const start = Date.now()
  await next()
  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start,
    },
    "request",
  )
})

// ----- Routes -----
app.get("/", (c) => c.json({ service: "billing", version: "0.1.0" }))
app.route("/health", healthRoutes)
app.route("/auth", authRoutes)
app.route("/me", meRoutes)
app.route("/limits", limitsRoutes)
app.route("/credits", creditsRoutes)
app.route("/subscriptions", subscriptionRoutes)
app.route("/payments", paymentRoutes)
app.route("/webhooks", webhookRoutes)
app.route("/usage", usageRoutes)
app.route("/waitlist", waitlistRoutes)

// ----- Error handler -----
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  logger.error({ err, path: c.req.path }, "Unhandled error")
  return c.json({ error: "internal_error" }, 500)
})

// ----- Server -----
logger.info({ port: config.PORT, env: config.NODE_ENV }, "Billing service starting")

export default {
  port: config.PORT,
  fetch: app.fetch,
}

/**
 * Passwordless auth via 6-digit OTP code emailed to the user.
 *
 *   POST /auth/magic-link   { email }            — request code (still named
 *                                                  «magic-link» для совместимости
 *                                                  с frontend-клиентом)
 *   POST /auth/verify-otp   { email, code }      — exchange code for session JWT
 *
 * ВАЖНО (allowlist, 2026-07-01): вход — ТОЛЬКО для заранее заведённых
 * пользователей. Кабинеты создаём вручную (`bun run create-user <email>`).
 * OTP НЕ регистрирует новых юзеров: если email не в таблице `users` (или
 * статус blocked) — код не отправляется и вход невозможен. Это закрывает
 * самозапись любого владельца почты (случайная авторизация + утечка бюджета).
 */
import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { and, eq, gt, isNull, lt } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { generateMagicToken, generateOtpCode, hashToken, issueSession } from "../lib/auth.ts"
import { magicLinkEmail, sendEmail } from "../lib/email.ts"
import { logger } from "../lib/logger.ts"
import { config } from "../config.ts"

export const authRoutes = new Hono()

/** Максимум неудачных попыток ввода кода на один OTP до его блокировки. */
const MAX_OTP_ATTEMPTS = 5

/** Найти активного пользователя по email (только он может войти). */
async function findActiveUser(email: string) {
  const rows = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.email, email), eq(schema.users.status, "active")))
    .limit(1)
  return rows[0]
}

const magicLinkInput = z.object({
  email: z.string().email(),
})

/**
 * Request a login code.
 * Всегда возвращает 204 — не раскрываем, какие email существуют/активны.
 * Код отправляется ТОЛЬКО заранее заведённому активному пользователю.
 */
authRoutes.post("/magic-link", zValidator("json", magicLinkInput), async (c) => {
  const { email } = c.req.valid("json")

  const user = await findActiveUser(email)
  if (!user) {
    // Молча выходим: не создаём юзера, не шлём код, не палим отсутствие аккаунта.
    logger.info({ email }, "OTP requested for unknown/inactive email — ignored")
    return c.body(null, 204)
  }

  // Гасим прежние невыданные коды этого email — в любой момент валиден максимум
  // один код (сужает окно перебора). consumedAt=now помечает их использованными.
  await db
    .update(schema.magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(schema.magicLinkTokens.email, email), isNull(schema.magicLinkTokens.consumedAt)))

  // token — легаси-поле (web-callback удалён), храним хэш для совместимости схемы.
  const token = generateMagicToken()
  const tokenHash = await hashToken(token)
  const otp = generateOtpCode()
  const otpHash = await hashToken(otp)
  const expiresAt = new Date(Date.now() + config.MAGIC_LINK_TTL_MINUTES * 60_000)

  await db.insert(schema.magicLinkTokens).values({ email, tokenHash, otpHash, expiresAt })

  // Email отправляем fire-and-forget: ответ НЕ должен блокироваться на SMTP
  // (медленная доставка/verify раньше держала запрос ~16с → таймаут клиента).
  void sendEmail(magicLinkEmail(email, otp)).catch((err) =>
    logger.error({ err, email }, "Failed to send OTP email"),
  )
  return c.body(null, 204)
})

const verifyOtpInput = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
})

/**
 * Exchange a 6-digit OTP code for a session JWT.
 * НЕ создаёт пользователя — только вход существующего активного (allowlist).
 */
authRoutes.post("/verify-otp", zValidator("json", verifyOtpInput), async (c) => {
  const { email, code } = c.req.valid("json")
  const now = new Date()

  // 1. Пользователь должен существовать и быть активным. Неизвестный/blocked →
  //    тот же ответ, что и неверный код (не раскрываем существование аккаунта).
  const user = await findActiveUser(email)
  if (!user) {
    return c.json({ error: "invalid_or_expired_code" }, 400)
  }

  // 2. Берём последний живой невыданный код с не исчерпанными попытками.
  const otpHash = await hashToken(code)
  const liveRows = await db
    .select()
    .from(schema.magicLinkTokens)
    .where(
      and(
        eq(schema.magicLinkTokens.email, email),
        gt(schema.magicLinkTokens.expiresAt, now),
        isNull(schema.magicLinkTokens.consumedAt),
        lt(schema.magicLinkTokens.attempts, MAX_OTP_ATTEMPTS),
      ),
    )
    .limit(1)

  const record = liveRows[0]
  if (!record) {
    return c.json({ error: "invalid_or_expired_code" }, 400)
  }

  // 3. Код неверный → инкремент попыток; при достижении лимита код гасится.
  if (record.otpHash !== otpHash) {
    const attempts = record.attempts + 1
    await db
      .update(schema.magicLinkTokens)
      .set({ attempts, consumedAt: attempts >= MAX_OTP_ATTEMPTS ? now : null })
      .where(eq(schema.magicLinkTokens.id, record.id))
    return c.json({ error: "invalid_or_expired_code" }, 400)
  }

  // 4. Верный код — гасим строку, обновляем время входа. Юзера НЕ создаём.
  await db
    .update(schema.magicLinkTokens)
    .set({ consumedAt: now })
    .where(eq(schema.magicLinkTokens.id, record.id))

  await db
    .update(schema.users)
    .set({ lastLoginAt: now, emailVerifiedAt: user.emailVerifiedAt ?? now })
    .where(eq(schema.users.id, user.id))

  const jwt = await issueSession({ sub: user.id, email: user.email })
  return c.json({ token: jwt, user: { id: user.id, email: user.email } })
})

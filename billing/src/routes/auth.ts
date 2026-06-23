/**
 * Passwordless auth via 6-digit OTP code emailed to the user.
 *
 *   POST /auth/magic-link   { email }            — request code (still named
 *                                                  «magic-link» для совместимости
 *                                                  с frontend-клиентом)
 *   POST /auth/verify-otp   { email, code }      — exchange code for session JWT
 */
import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { and, eq, gt, isNull } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { generateMagicToken, generateOtpCode, hashToken, issueSession } from "../lib/auth.ts"
import { magicLinkEmail, sendEmail } from "../lib/email.ts"
import { logger } from "../lib/logger.ts"
import { config } from "../config.ts"
import { initSubscription } from "./subscriptions.ts"

export const authRoutes = new Hono()

const magicLinkInput = z.object({
  email: z.string().email(),
})

/**
 * Request a magic-link.
 * Always returns 204 to avoid leaking which emails exist.
 */
authRoutes.post("/magic-link", zValidator("json", magicLinkInput), async (c) => {
  const { email } = c.req.valid("json")

  // Параллельно: длинный URL-токен (для web-callback в будущем) и 6-значный OTP
  // (основной путь для desktop-приложения).
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
 * Same logic as /verify, but matches by (email, otp_hash) instead of token.
 * Используется desktop-приложением — не требует кликабельных deep-link'ов.
 */
authRoutes.post("/verify-otp", zValidator("json", verifyOtpInput), async (c) => {
  const { email, code } = c.req.valid("json")
  const otpHash = await hashToken(code)

  const now = new Date()
  const found = await db
    .select()
    .from(schema.magicLinkTokens)
    .where(
      and(
        eq(schema.magicLinkTokens.email, email),
        eq(schema.magicLinkTokens.otpHash, otpHash),
        gt(schema.magicLinkTokens.expiresAt, now),
        isNull(schema.magicLinkTokens.consumedAt),
      ),
    )
    .limit(1)

  const record = found[0]
  if (!record) {
    return c.json({ error: "invalid_or_expired_code" }, 400)
  }

  await db
    .update(schema.magicLinkTokens)
    .set({ consumedAt: now })
    .where(eq(schema.magicLinkTokens.id, record.id))

  // Upsert user (та же логика, что в /verify).
  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, record.email))
    .limit(1)

  let user = existing[0]
  if (!user) {
    const inserted = await db
      .insert(schema.users)
      .values({ email: record.email, emailVerifiedAt: now, lastLoginAt: now })
      .returning()
    user = inserted[0]!
    await initSubscription(user.id)
  } else {
    await db
      .update(schema.users)
      .set({ lastLoginAt: now, emailVerifiedAt: user.emailVerifiedAt ?? now })
      .where(eq(schema.users.id, user.id))
  }

  const jwt = await issueSession({ sub: user.id, email: user.email })
  return c.json({ token: jwt, user: { id: user.id, email: user.email } })
})


/**
 * Magic-link auth + session JWT helpers.
 *
 * Flow:
 *   1. POST /auth/magic-link { email } → server stores hash(token), emails the raw token.
 *   2. User clicks link → GET /auth/verify?token=... → exchange for session JWT.
 *   3. Subsequent calls send `Authorization: Bearer <jwt>`.
 */
import { SignJWT, jwtVerify } from "jose"
import { config } from "../config.ts"

const jwtSecretKey = new TextEncoder().encode(config.JWT_SECRET)

export interface SessionClaims {
  /** users.id */
  sub: string
  email: string
}

export async function issueSession(claims: SessionClaims, ttlDays = 30): Promise<string> {
  return await new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlDays}d`)
    .sign(jwtSecretKey)
}

export async function verifySession(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, jwtSecretKey, {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  })
  if (!payload.sub || typeof payload.email !== "string") {
    throw new Error("Malformed session claims")
  }
  return { sub: payload.sub, email: payload.email }
}

/** Generate a high-entropy magic-link token (URL-safe). */
export function generateMagicToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

/**
 * Сгенерировать 6-значный OTP-код для desktop-входа.
 * Используем crypto.getRandomValues для энтропии — НЕ Math.random.
 * Дублирующиеся цифры (000000, 111111) исключаем.
 */
export function generateOtpCode(): string {
  while (true) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    const n = buf[0]! % 1_000_000
    const code = n.toString().padStart(6, "0")
    // Не выпускаем тривиальные коды
    if (/^(\d)\1{5}$/.test(code)) continue
    return code
  }
}

/** Hash a magic-link token or OTP (we never store the raw value). */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return Buffer.from(hash).toString("hex")
}

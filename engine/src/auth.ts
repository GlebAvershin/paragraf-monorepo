/**
 * Аутентификация движка: проверяем тот же session-JWT, что выдаёт billing.
 * `sub` = userId → по нему изолируем сессии/сообщения (один общий сервис на всех).
 *
 * Рендерер шлёт токен либо как `Authorization: Bearer <jwt>`, либо как Basic
 * (механизм authToken в opencode-SDK: `Authorization: Basic base64(:<jwt>)`).
 */
import type { Context, Next } from "hono"
import { jwtVerify } from "jose"
import { config } from "./config.ts"

const secret = new TextEncoder().encode(config.JWT_SECRET)

export interface Session {
  userId: string
  email: string
}

/** Извлечь сырой JWT из заголовка Authorization (Bearer или Basic с паролем=JWT). */
function extractToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  if (header.startsWith("Bearer ")) return header.slice(7).trim()
  if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8")
      // opencode authToken: "username:password", JWT кладётся в password.
      const idx = decoded.indexOf(":")
      return idx >= 0 ? decoded.slice(idx + 1) : decoded
    } catch {
      return undefined
    }
  }
  return undefined
}

export async function verifyToken(token: string): Promise<Session> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  })
  if (!payload.sub || typeof payload.email !== "string") throw new Error("malformed claims")
  return { userId: payload.sub, email: payload.email }
}

/** Hono-middleware: кладёт Session в c.var.session или отдаёт 401. */
export async function requireSession(c: Context, next: Next) {
  const token = extractToken(c.req.header("authorization"))
  if (!token) return c.json({ error: "unauthorized" }, 401)
  try {
    c.set("session", await verifyToken(token))
    c.set("token", token) // сырой JWT — для вызова billing /me от имени юзера
  } catch {
    return c.json({ error: "invalid_token" }, 401)
  }
  return next()
}

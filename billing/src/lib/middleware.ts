/**
 * Hono middleware: session auth.
 */
import type { MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { verifySession, type SessionClaims } from "./auth.ts"
import { config } from "../config.ts"

declare module "hono" {
  interface ContextVariableMap {
    session: SessionClaims
  }
}

export const requireSession: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization")
  if (!header?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Missing or malformed Authorization header" })
  }
  const token = header.slice("Bearer ".length)
  try {
    const claims = await verifySession(token)
    c.set("session", claims)
  } catch {
    throw new HTTPException(401, { message: "Invalid or expired session" })
  }
  await next()
}

// Гейт для /admin/* — отдельный секрет (не пользовательский JWT), для внутреннего
// просмотра данных разработчиками. Пусто в конфиге ⇒ 503, а не "открыто без пароля".
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (!config.ADMIN_TOKEN) throw new HTTPException(503, { message: "admin_disabled" })
  if (c.req.header("x-admin-token") !== config.ADMIN_TOKEN) {
    throw new HTTPException(401, { message: "unauthorized" })
  }
  await next()
}

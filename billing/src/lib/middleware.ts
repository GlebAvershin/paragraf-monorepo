/**
 * Hono middleware: session auth.
 */
import type { MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { eq } from "drizzle-orm"
import { verifySession, type SessionClaims } from "./auth.ts"
import { db, schema } from "../db/client.ts"
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

/**
 * Гейт для /manager/* — сессия + роль manager в БД.
 *
 * Роль проверяем ПО БАЗЕ, а не по claim в JWT: токен живёт 30 дней, и если
 * менеджера разжаловали (или аккаунт заблокировали), старый токен не должен
 * продолжать открывать чужой расход. Цена — один SELECT на запрос.
 */
export const requireManager: MiddlewareHandler = async (c, next) => {
  const { sub: userId } = c.get("session")
  const rows = await db
    .select({ role: schema.users.role, status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)
  const user = rows[0]
  if (!user || user.status !== "active") {
    throw new HTTPException(403, { message: "forbidden" })
  }
  if (user.role !== "manager") {
    throw new HTTPException(403, { message: "not_a_manager" })
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

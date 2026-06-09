/**
 * Hono middleware: session auth.
 */
import type { MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { verifySession, type SessionClaims } from "./auth.ts"

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

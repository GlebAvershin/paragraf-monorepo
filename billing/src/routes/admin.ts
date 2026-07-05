/**
 * GET /admin/users — список всех пользователей (id/email) для внутренней админ-панели
 * разработчиков. Движок хранит сессии/сообщения только по user_id (без email) — эта
 * ручка нужна фронту, чтобы сопоставить user_id из engine с email из billing.
 *
 * Гейтится requireAdmin (отдельный секрет ADMIN_TOKEN), не пользовательским JWT.
 */
import { Hono } from "hono"
import { db, schema } from "../db/client.ts"
import { requireAdmin } from "../lib/middleware.ts"

export const adminRoutes = new Hono()

adminRoutes.get("/users", requireAdmin, async (c) => {
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      status: schema.users.status,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
  return c.json({ users: rows })
})

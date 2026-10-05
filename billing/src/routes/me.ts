/**
 * GET /me — full profile bundle for the web app.
 * Returns: user and current subscription metadata.
 */
import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { desc, eq, and } from "drizzle-orm"
import { z } from "zod"
import { db, schema } from "../db/client.ts"
import { requireSession } from "../lib/middleware.ts"
import { config } from "../config.ts"

export const meRoutes = new Hono()
const PrimaryVerticalSchema = z.object({
  primaryVertical: z.enum(["lawyer", "accountant"]),
})

meRoutes.get("/", requireSession, async (c) => {
  const { sub: userId } = c.get("session")

  const userRows = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  const user = userRows[0]
  if (!user) {
    return c.json({ error: "user_not_found" }, 404)
  }

  const subRows = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1)
  const sub = subRows[0] ?? null

  const planRows = sub
    ? await db.select().from(schema.plans).where(eq(schema.plans.code, sub.planCode)).limit(1)
    : []
  const plan = planRows[0] ?? null

  // Привязанная карта по умолчанию (для отображения на странице /credits).
  const cardRows = await db
    .select()
    .from(schema.paymentMethods)
    .where(and(eq(schema.paymentMethods.userId, userId), eq(schema.paymentMethods.isDefault, true)))
    .orderBy(desc(schema.paymentMethods.createdAt))
    .limit(1)
  const card = cardRows[0] ?? null

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      primaryVertical: user.primaryVertical,
      role: user.role,
      managerId: user.managerId,
      // Менеджером может стать только тот, кто завёлся сам. Созданный менеджером
      // сотрудник — нет (иначе иерархия команд разъезжается).
      canBecomeManager: user.role === "employee" && user.managerId === null,
    },
    subscription: sub
      ? {
          id: sub.id,
          planCode: sub.planCode,
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd,
          trialEndsAt: sub.trialEndsAt,
          pendingPlanCode: sub.pendingPlanCode,
          // The desktop app uses this as Bearer token / apiKey to LiteLLM.
          litellmKey: sub.litellmKey,
        }
      : null,
    paymentMethod: card
      ? { id: card.id, cardLast4: card.cardLast4, cardBrand: card.cardBrand }
      : null,
    plan: plan
      ? {
          code: plan.code,
          titleRu: plan.titleRu,
          monthlyCredits: plan.monthlyCredits,
          // DEPRECATED — оставлено для совместимости со старым desktop-клиентом.
          monthlyTasksTarget: plan.monthlyTasksTarget,
          allowedModels: plan.allowedModels,
        }
      : null,
    gateway: {
      baseUrl: config.LITELLM_BASE_URL,
    },
  })
})

meRoutes.patch("/", requireSession, zValidator("json", PrimaryVerticalSchema), async (c) => {
  const { sub: userId } = c.get("session")
  const { primaryVertical } = c.req.valid("json")
  const rows = await db
    .update(schema.users)
    .set({ primaryVertical })
    .where(eq(schema.users.id, userId))
    .returning({ id: schema.users.id, primaryVertical: schema.users.primaryVertical })
  const user = rows[0]
  if (!user) return c.json({ error: "user_not_found" }, 404)
  return c.json({ user })
})

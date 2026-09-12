/**
 * Кабинет менеджера (2026-09-11).
 *
 *   POST /manager/activate             — стать менеджером (самому, один раз)
 *   GET  /manager/team?from&to         — сотрудники: баланс + расход за период
 *   POST /manager/team                 — завести сотрудника (email + пароль)
 *   POST /manager/team/:id/credits     — перевести сотруднику кредиты со своего баланса
 *   GET  /manager/team/:id/usage       — история запросов сотрудника (метаданные)
 *
 * Модель ролей:
 *   - любой аккаунт стартует как `employee` и ничем не ограничен;
 *   - `employee` с manager_id IS NULL может сам стать `manager`;
 *   - сотрудник, заведённый менеджером (manager_id заполнен), работает так же
 *     свободно, но менеджером стать не может, а его расход виден создателю.
 *
 * Аналитика — ТОЛЬКО цифры и метаданные (модель, сценарий, токены, кредиты,
 * время). Текстов переписки менеджер не видит: содержимое диалогов лежит в
 * движке и сюда сознательно не проксируется (решение продукта + 152-ФЗ).
 */
import { Hono } from "hono"
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { db, schema } from "../db/client.ts"
import { requireManager, requireSession } from "../lib/middleware.ts"
import { logger } from "../lib/logger.ts"
import {
  InsufficientCreditsError,
  balancesBySubscription,
  latestSubscription,
  listTeam,
  transferCredits,
} from "../lib/manager.ts"
import { bumpLiteLLMBudgetForCredits } from "../lib/grants.ts"
import { initSubscription } from "./subscriptions.ts"
import { parseRange, type DateRange } from "./usage.ts"
import { invalidateLimitsCache } from "./limits.ts"

export const managerRoutes = new Hono()

/** Сотрудник менеджера или 404 — единая проверка владения для всех /team/:id. */
async function requireOwnEmployee(managerId: string, employeeId: string) {
  const rows = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, employeeId), eq(schema.users.managerId, managerId)))
    .limit(1)
  return rows[0] ?? null
}

// ===== POST /manager/activate =====

managerRoutes.post("/activate", requireSession, async (c) => {
  const { sub: userId } = c.get("session")
  const rows = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  const user = rows[0]
  if (!user) return c.json({ error: "user_not_found" }, 404)

  // Созданный менеджером сотрудник менеджером стать не может — это и есть
  // единственное отличие «своего» сотрудника от самостоятельного.
  if (user.managerId) {
    return c.json({ error: "created_by_manager" }, 403)
  }
  if (user.role === "manager") {
    return c.json({ role: "manager", alreadyManager: true })
  }

  await db
    .update(schema.users)
    .set({ role: "manager", updatedAt: new Date() })
    .where(eq(schema.users.id, userId))

  await db.insert(schema.auditLog).values({
    actor: `user:${userId}`,
    action: "manager.activate",
    targetType: "user",
    targetId: userId,
    metadata: {},
  })

  return c.json({ role: "manager", alreadyManager: false })
})

// ===== GET /manager/team =====

managerRoutes.get("/team", requireSession, requireManager, async (c) => {
  const { sub: managerId } = c.get("session")
  let range: DateRange
  try {
    range = parseRange(Object.fromEntries(new URL(c.req.url).searchParams))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "invalid_range" }, 400)
  }

  const team = await listTeam(managerId)
  const subIds = team.map((m) => m.subscriptionId).filter((id): id is string => !!id)
  const balances = await balancesBySubscription(subIds)

  // Расход за период по каждому сотруднику. Фильтр по датам — в ON у LEFT JOIN,
  // иначе сотрудник без запросов за период выпадет из выборки (тот же урок,
  // что с generate_series в usage.ts).
  const usageByUser = new Map<
    string,
    { credits: number; requests: number; tokens: number; lastRequestAt: Date | null }
  >()
  if (subIds.length > 0) {
    // Таблицы БЕЗ алиасов: drizzle-фильтр (inArray) рендерится как
    // "subscriptions"."id", и при `FROM subscriptions s` Postgres ругается
    // «invalid reference to FROM-clause entry» — поймано на первом же прогоне.
    const subFilter = inArray(schema.subscriptions.id, subIds)
    const rows = await db.execute<{
      userId: string
      credits: number
      requests: number
      tokens: number
      lastRequestAt: Date | null
    }>(sql`
      SELECT subscriptions.user_id AS "userId",
             COALESCE(SUM(usage_events.credits_charged), 0)::int AS credits,
             COUNT(usage_events.id)::int AS requests,
             COALESCE(SUM(usage_events.input_tokens + usage_events.output_tokens), 0)::int AS tokens,
             MAX(usage_events.created_at) AS "lastRequestAt"
      FROM subscriptions
      LEFT JOIN usage_events
        ON usage_events.subscription_id = subscriptions.id
        AND usage_events.created_at >= ${range.from.toISOString()}
        AND usage_events.created_at <= ${range.to.toISOString()}
      WHERE ${subFilter}
      GROUP BY subscriptions.user_id
    `)
    for (const row of rows) {
      usageByUser.set(row.userId, {
        credits: row.credits,
        requests: row.requests,
        tokens: row.tokens,
        lastRequestAt: row.lastRequestAt,
      })
    }
  }

  const managerSub = await latestSubscription(managerId)
  const managerBalance = managerSub
    ? ((await balancesBySubscription([managerSub.id])).get(managerSub.id) ?? 0)
    : 0

  const members = team.map((m) => {
    const usage = usageByUser.get(m.userId)
    return {
      userId: m.userId,
      email: m.email,
      name: m.name,
      status: m.status,
      createdAt: m.createdAt,
      lastLoginAt: m.lastLoginAt,
      balance: m.subscriptionId ? (balances.get(m.subscriptionId) ?? 0) : 0,
      usage: {
        credits: usage?.credits ?? 0,
        requests: usage?.requests ?? 0,
        tokens: usage?.tokens ?? 0,
        lastRequestAt: usage?.lastRequestAt ?? null,
      },
    }
  })

  return c.json({
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    managerBalance,
    totals: {
      employees: members.length,
      credits: members.reduce((s, m) => s + m.usage.credits, 0),
      requests: members.reduce((s, m) => s + m.usage.requests, 0),
      tokens: members.reduce((s, m) => s + m.usage.tokens, 0),
    },
    members,
  })
})

// ===== POST /manager/team — завести сотрудника =====

const createEmployeeInput = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().trim().max(200).optional(),
  /** Сколько кредитов сразу перевести со своего баланса (0 — не переводить). */
  initialCredits: z.number().int().min(0).max(1_000_000).optional(),
})

managerRoutes.post(
  "/team",
  requireSession,
  requireManager,
  zValidator("json", createEmployeeInput),
  async (c) => {
    const { sub: managerId } = c.get("session")
    const body = c.req.valid("json")
    const email = body.email.trim().toLowerCase()
    const initialCredits = body.initialCredits ?? 0

    const managerSub = await latestSubscription(managerId)
    if (!managerSub) return c.json({ error: "manager_has_no_subscription" }, 400)

    // Баланс проверяем ДО создания аккаунта: иначе при нехватке кредитов
    // сотрудник уже заведён, а перевод упал — менеджер видит непонятную ошибку
    // при, казалось бы, успешном создании.
    if (initialCredits > 0) {
      const available = (await balancesBySubscription([managerSub.id])).get(managerSub.id) ?? 0
      if (available < initialCredits) {
        return c.json({ error: "insufficient_credits", available, requested: initialCredits }, 400)
      }
    }

    const existingRows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1)
    const existing = existingRows[0]

    let employeeId: string
    if (existing) {
      // Повторный вызов после сбоя LiteLLM: аккаунт уже есть, но подписки нет —
      // дозаводим её вместо бессмысленного 409 (initSubscription идемпотентен
      // только на уровне «создать», поэтому проверяем наличие подписки сами).
      const isMine = existing.managerId === managerId
      const hasSub = !!(await latestSubscription(existing.id))
      if (!isMine || hasSub) {
        return c.json({ error: "email_taken" }, 409)
      }
      employeeId = existing.id
    } else {
      const now = new Date()
      const inserted = await db
        .insert(schema.users)
        .values({
          email,
          name: body.name?.trim() || null,
          status: "active",
          role: "employee",
          managerId,
          emailVerifiedAt: now,
          passwordHash: await Bun.password.hash(body.password),
        })
        .returning()
      employeeId = inserted[0]!.id
    }

    try {
      await initSubscription(employeeId)
    } catch (err) {
      logger.error({ err, employeeId }, "initSubscription failed for new employee")
      return c.json({ error: "provisioning_failed", userId: employeeId }, 502)
    }

    let transferred = 0
    if (initialCredits > 0) {
      const employeeSub = await latestSubscription(employeeId)
      if (employeeSub) {
        try {
          await transferCredits({
            fromSubscriptionId: managerSub.id,
            toSubscriptionId: employeeSub.id,
            credits: initialCredits,
            actorUserId: managerId,
            targetUserId: employeeId,
          })
          transferred = initialCredits
          await bumpLiteLLMBudgetForCredits(
            employeeSub.litellmKey,
            await planFor(employeeSub.planCode),
            initialCredits,
          )
          invalidateLimitsCache(employeeId)
          invalidateLimitsCache(managerId)
        } catch (err) {
          // Аккаунт уже создан и рабочий — не откатываем его из-за перевода,
          // просто сообщаем, что кредиты не ушли (менеджер повторит вручную).
          logger.warn({ err, employeeId }, "initial credits transfer failed")
        }
      }
    }

    await db.insert(schema.auditLog).values({
      actor: `user:${managerId}`,
      action: "manager.employee.create",
      targetType: "user",
      targetId: employeeId,
      metadata: { email, initialCredits: transferred },
    })

    return c.json({ userId: employeeId, email, creditsTransferred: transferred }, 201)
  },
)

// ===== POST /manager/team/:id/credits — перевод кредитов =====

const transferInput = z.object({
  credits: z.number().int().positive().max(1_000_000),
})

managerRoutes.post(
  "/team/:id/credits",
  requireSession,
  requireManager,
  zValidator("json", transferInput),
  async (c) => {
    const { sub: managerId } = c.get("session")
    const employeeId = c.req.param("id")
    const { credits } = c.req.valid("json")

    const employee = await requireOwnEmployee(managerId, employeeId)
    if (!employee) return c.json({ error: "employee_not_found" }, 404)

    const [managerSub, employeeSub] = await Promise.all([
      latestSubscription(managerId),
      latestSubscription(employeeId),
    ])
    if (!managerSub) return c.json({ error: "manager_has_no_subscription" }, 400)
    if (!employeeSub) return c.json({ error: "employee_has_no_subscription" }, 400)

    try {
      await transferCredits({
        fromSubscriptionId: managerSub.id,
        toSubscriptionId: employeeSub.id,
        credits,
        actorUserId: managerId,
        targetUserId: employeeId,
      })
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return c.json(
          { error: "insufficient_credits", available: err.available, requested: err.requested },
          400,
        )
      }
      throw err
    }

    // Hardcap LiteLLM поднимаем только получателю. Менеджеру НЕ опускаем: это
    // страховочный слой, источник правды по балансу — credit_grants, а снижение
    // cap'а могло бы срезать уже летящий запрос менеджера.
    await bumpLiteLLMBudgetForCredits(
      employeeSub.litellmKey,
      await planFor(employeeSub.planCode),
      credits,
    )
    invalidateLimitsCache(employeeId)
    invalidateLimitsCache(managerId)

    const balances = await balancesBySubscription([managerSub.id, employeeSub.id])
    return c.json({
      transferred: credits,
      managerBalance: balances.get(managerSub.id) ?? 0,
      employeeBalance: balances.get(employeeSub.id) ?? 0,
    })
  },
)

// ===== GET /manager/team/:id/usage — история запросов сотрудника =====

managerRoutes.get("/team/:id/usage", requireSession, requireManager, async (c) => {
  const { sub: managerId } = c.get("session")
  const employeeId = c.req.param("id")
  const params = Object.fromEntries(new URL(c.req.url).searchParams)

  const employee = await requireOwnEmployee(managerId, employeeId)
  if (!employee) return c.json({ error: "employee_not_found" }, 404)

  let range: DateRange
  try {
    range = parseRange(params)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "invalid_range" }, 400)
  }
  const limit = Math.min(parseInt(params.limit ?? "100", 10) || 100, 500)
  const offset = Math.max(parseInt(params.offset ?? "0", 10) || 0, 0)

  const sub = await latestSubscription(employeeId)
  if (!sub) return c.json({ items: [], total: 0 })

  const items = await db
    .select()
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.subscriptionId, sub.id),
        gte(schema.usageEvents.createdAt, range.from),
        lte(schema.usageEvents.createdAt, range.to),
      ),
    )
    .orderBy(desc(schema.usageEvents.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({
    employee: { id: employee.id, email: employee.email, name: employee.name },
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    // Только метаданные — тексты запросов/ответов живут в движке и менеджеру
    // намеренно не отдаются.
    items: items.map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      model: e.model,
      provider: e.provider,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      creditsCharged: e.creditsCharged,
      scenarioId: e.scenarioId,
      status: e.status,
    })),
    pagination: { limit, offset },
  })
})

/** План по коду (для пересчёта hardcap'а LiteLLM при переводе). */
async function planFor(planCode: string) {
  const rows = await db.select().from(schema.plans).where(eq(schema.plans.code, planCode)).limit(1)
  const plan = rows[0]
  // Фоллбек на нули → usdPerCredit() вернёт anchor-значение, а не упадёт.
  return plan ?? { monthlyBudgetUsdCenti: 0, monthlyCredits: 0 }
}

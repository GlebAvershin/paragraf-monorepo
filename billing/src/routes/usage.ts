/**
 * Usage routes (ТЗ-05) — аналитика расхода кредитов для дашборда.
 *
 *   GET /usage/summary?from=&to=     — агрегированная сводка
 *   GET /usage/events?from=&to=&...  — постраничный список событий
 *   GET /usage/export.csv?from=&to=  — выгрузка для бухгалтерии фирмы
 *
 * Данные — из usage_events (заполняется ETL-воркером из LiteLLM spend logs).
 * Часовые пояса — все запросы в UTC, агрегация по дню по UTC. Frontend
 * перерисует в локальной TZ при отображении.
 */
import { Hono } from "hono"
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { requireSession } from "../lib/middleware.ts"

export const usageRoutes = new Hono()

interface DateRange {
  from: Date
  to: Date
}

function parseRange(query: Record<string, string | undefined>): DateRange {
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) // -30 дней
  const fromParam = query.from
  const toParam = query.to
  const from = fromParam ? new Date(fromParam) : defaultFrom
  const to = toParam ? new Date(toParam) : now
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new Error("invalid_range")
  }
  // Защита от слишком широкого диапазона.
  const maxDays = 366
  if ((to.getTime() - from.getTime()) / 86400000 > maxDays) {
    throw new Error("range_too_wide")
  }
  return { from, to }
}

/** Все subscription_id текущего пользователя (обычно одна, но может быть история). */
async function userSubscriptionIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.subscriptions.id })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
  return rows.map((r) => r.id)
}

// ===== GET /usage/summary =====

usageRoutes.get("/summary", requireSession, async (c) => {
  const { sub: userId } = c.get("session")
  let range: DateRange
  try {
    range = parseRange(Object.fromEntries(new URL(c.req.url).searchParams))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "invalid_range" }, 400)
  }

  const subIds = await userSubscriptionIds(userId)
  if (subIds.length === 0) {
    return c.json({
      totalCredits: 0,
      totalRequests: 0,
      avgCreditsPerRequest: 0,
      byDay: [],
      byModel: [],
      byScenario: [],
    })
  }

  // drizzle inArray → безопасный параметризованный IN (без SQL-инъекций,
  // без проблем сериализации массива из одного элемента). Встраивается в raw sql.
  const subFilter = inArray(schema.usageEvents.subscriptionId, subIds)

  // Общая сводка.
  const [total] = await db.execute<{ credits: number; requests: number }>(sql`
    SELECT COALESCE(SUM(credits_charged), 0)::int AS credits,
           COUNT(*)::int AS requests
    FROM usage_events
    WHERE ${subFilter}
      AND created_at >= ${range.from.toISOString()}
      AND created_at <= ${range.to.toISOString()}
  `)

  const totalCredits = total?.credits ?? 0
  const totalRequests = total?.requests ?? 0

  // Разбивка по дням.
  const byDayRows = await db.execute<{ day: string; credits: number; requests: number }>(sql`
    SELECT date_trunc('day', created_at)::date::text AS day,
           COALESCE(SUM(credits_charged), 0)::int AS credits,
           COUNT(*)::int AS requests
    FROM usage_events
    WHERE ${subFilter}
      AND created_at >= ${range.from.toISOString()}
      AND created_at <= ${range.to.toISOString()}
    GROUP BY 1
    ORDER BY 1 ASC
  `)

  // Разбивка по моделям.
  const byModelRows = await db.execute<{ model: string; credits: number; requests: number }>(sql`
    SELECT model,
           COALESCE(SUM(credits_charged), 0)::int AS credits,
           COUNT(*)::int AS requests
    FROM usage_events
    WHERE ${subFilter}
      AND created_at >= ${range.from.toISOString()}
      AND created_at <= ${range.to.toISOString()}
    GROUP BY model
    ORDER BY credits DESC
  `)

  // Разбивка по сценариям (только те, у кого scenario_id заполнен).
  const byScenarioRows = await db.execute<{ scenarioId: string; credits: number; requests: number }>(sql`
    SELECT scenario_id AS "scenarioId",
           COALESCE(SUM(credits_charged), 0)::int AS credits,
           COUNT(*)::int AS requests
    FROM usage_events
    WHERE ${subFilter}
      AND created_at >= ${range.from.toISOString()}
      AND created_at <= ${range.to.toISOString()}
      AND scenario_id IS NOT NULL
    GROUP BY scenario_id
    ORDER BY credits DESC
    LIMIT 20
  `)

  return c.json({
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    totalCredits,
    totalRequests,
    avgCreditsPerRequest: totalRequests > 0 ? Math.round((totalCredits / totalRequests) * 10) / 10 : 0,
    byDay: byDayRows,
    byModel: byModelRows,
    byScenario: byScenarioRows,
  })
})

// ===== GET /usage/events =====

usageRoutes.get("/events", requireSession, async (c) => {
  const { sub: userId } = c.get("session")
  const params = Object.fromEntries(new URL(c.req.url).searchParams)
  let range: DateRange
  try {
    range = parseRange(params)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "invalid_range" }, 400)
  }
  const limit = Math.min(parseInt(params.limit ?? "100", 10) || 100, 1000)
  const offset = Math.max(parseInt(params.offset ?? "0", 10) || 0, 0)

  const subIds = await userSubscriptionIds(userId)
  if (subIds.length === 0) {
    return c.json({ items: [], total: 0 })
  }

  const items = await db
    .select()
    .from(schema.usageEvents)
    .where(
      and(
        inArray(schema.usageEvents.subscriptionId, subIds),
        gte(schema.usageEvents.createdAt, range.from),
        lte(schema.usageEvents.createdAt, range.to),
      ),
    )
    .orderBy(desc(schema.usageEvents.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({
    items: items.map((e) => ({
      id: e.id,
      model: e.model,
      provider: e.provider,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      creditsCharged: e.creditsCharged,
      scenarioId: e.scenarioId,
      status: e.status,
      createdAt: e.createdAt,
    })),
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    pagination: { limit, offset },
  })
})

// ===== GET /usage/export.csv =====
// Выгрузка для бухгалтерии фирмы — все события за период в CSV.

usageRoutes.get("/export.csv", requireSession, async (c) => {
  const { sub: userId } = c.get("session")
  let range: DateRange
  try {
    range = parseRange(Object.fromEntries(new URL(c.req.url).searchParams))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "invalid_range" }, 400)
  }
  const subIds = await userSubscriptionIds(userId)
  if (subIds.length === 0) {
    return c.body("created_at,model,provider,credits,input_tokens,output_tokens,scenario_id,status\n", 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="usage-empty.csv"`,
    })
  }

  const events = await db
    .select()
    .from(schema.usageEvents)
    .where(
      and(
        inArray(schema.usageEvents.subscriptionId, subIds),
        gte(schema.usageEvents.createdAt, range.from),
        lte(schema.usageEvents.createdAt, range.to),
      ),
    )
    .orderBy(desc(schema.usageEvents.createdAt))
    .limit(10000)

  const rows = ["created_at,model,provider,credits,input_tokens,output_tokens,scenario_id,status"]
  for (const e of events) {
    rows.push(
      [
        e.createdAt.toISOString(),
        csvEscape(e.model),
        csvEscape(e.provider),
        e.creditsCharged.toString(),
        e.inputTokens.toString(),
        e.outputTokens.toString(),
        csvEscape(e.scenarioId ?? ""),
        csvEscape(e.status),
      ].join(","),
    )
  }

  const filename = `usage-${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}.csv`
  // BOM \uFEFF — для корректного открытия в Excel с кириллицей.
  return c.body("\uFEFF" + rows.join("\n") + "\n", 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  })
})

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`
  }
  return value
}

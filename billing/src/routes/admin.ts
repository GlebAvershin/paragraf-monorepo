/**
 * GET /admin/users — список всех пользователей (id/email) для внутренней админ-панели
 * разработчиков. Движок хранит сессии/сообщения только по user_id (без email) — эта
 * ручка нужна фронту, чтобы сопоставить user_id из engine с email из billing.
 *
 * GET /admin/events, /admin/events/summary — клик-аналитика (2026-07-09) для
 * коллеги-аналитика: /admin/events/summary отдаёт агрегаты под 5 конкретных вопросов
 * (история — кликают ли вообще/куда/насколько старую сессию открывают; «начать новую
 * задачу»; сценарии; просмотр side-панели документа; клики по вкладкам чата),
 * /admin/events — сырой постраничный фид для точечного разбора (join на email).
 *
 * Гейтится requireAdmin (отдельный секрет ADMIN_TOKEN), не пользовательским JWT.
 */
import { Hono } from "hono"
import { desc, eq, sql } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { requireAdmin } from "../lib/middleware.ts"
import { parseRange, type DateRange } from "./usage.ts"
import { EVENT_TYPES } from "./events.ts"

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

// ===== Клик-аналитика =====

// Бакеты «насколько старую сессию открыли» (ageMs — от клика до её последней
// активности). Порядок — фиксированный, не зависит от GROUP BY.
const AGE_BUCKETS = ["<1ч", "1-24ч", "1-7д", "7-30д", ">30д"] as const

adminRoutes.get("/events/summary", requireAdmin, async (c) => {
  let range: DateRange
  try {
    range = parseRange(Object.fromEntries(new URL(c.req.url).searchParams))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "invalid_range" }, 400)
  }
  const fromIso = range.from.toISOString()
  const toIso = range.to.toISOString()

  const byType = await db.execute<{ eventType: string; count: number }>(sql`
    SELECT event_type AS "eventType", COUNT(*)::int AS count
    FROM ui_events
    WHERE created_at >= ${fromIso} AND created_at <= ${toIso}
    GROUP BY event_type
    ORDER BY count DESC
  `)

  // История — три источника (сайдбар, кап 8; «Продолжить работу» на главной,
  // кап 200; страница /history, без капа) — различаем по metadata.source.
  // Для каждого: сколько раз кликали, по какому rank (позиция в видимом
  // списке) и насколько старую (по времени последней активности сессии на
  // момент клика) сессию открыли. rank считаем ОТДЕЛЬНО по источнику — иначе
  // безлимитная /history размывает гистограмму 8-капнутого сайдбара и портит
  // ответ на «хватает ли восьми видимых сессий».
  const historyBySource = await db.execute<{ source: string; count: number }>(sql`
    SELECT metadata->>'source' AS source, COUNT(*)::int AS count
    FROM ui_events
    WHERE event_type = 'history_click' AND created_at BETWEEN ${fromIso} AND ${toIso}
    GROUP BY source
  `)
  const historyByRank = await db.execute<{ source: string; rank: number; count: number }>(sql`
    SELECT metadata->>'source' AS source, (metadata->>'rank')::int AS rank, COUNT(*)::int AS count
    FROM ui_events
    WHERE event_type = 'history_click' AND created_at BETWEEN ${fromIso} AND ${toIso}
      AND metadata ? 'rank'
    GROUP BY source, rank
    ORDER BY source ASC, rank ASC
  `)
  const historyByAgeRaw = await db.execute<{ bucket: string; count: number }>(sql`
    SELECT
      CASE
        WHEN (metadata->>'ageMs')::bigint < 3600000 THEN '<1ч'
        WHEN (metadata->>'ageMs')::bigint < 86400000 THEN '1-24ч'
        WHEN (metadata->>'ageMs')::bigint < 604800000 THEN '1-7д'
        WHEN (metadata->>'ageMs')::bigint < 2592000000 THEN '7-30д'
        ELSE '>30д'
      END AS bucket,
      COUNT(*)::int AS count
    FROM ui_events
    WHERE event_type = 'history_click' AND created_at BETWEEN ${fromIso} AND ${toIso}
      AND metadata ? 'ageMs'
    GROUP BY bucket
  `)
  const ageCountByBucket = new Map(historyByAgeRaw.map((r) => [r.bucket, r.count]))
  const historyByAge = AGE_BUCKETS.map((bucket) => ({ bucket, count: ageCountByBucket.get(bucket) ?? 0 }))

  // Сколько уникальных пользователей вообще хоть раз кликнули по старой сессии —
  // отвечает на «кликают ли вообще».
  const [historyDistinctUsers] = await db.execute<{ users: number }>(sql`
    SELECT COUNT(DISTINCT user_id)::int AS users
    FROM ui_events
    WHERE event_type = 'history_click' AND created_at BETWEEN ${fromIso} AND ${toIso}
  `)

  // «Начать новую задачу» — resolved=true (проект уже был выбран, сразу открылась
  // сессия) vs resolved=false (пришлось сначала выбрать проект/папку).
  const newTaskByResolved = await db.execute<{ resolved: string; count: number }>(sql`
    SELECT COALESCE(metadata->>'resolved', 'unknown') AS resolved, COUNT(*)::int AS count
    FROM ui_events
    WHERE event_type = 'new_task_click' AND created_at BETWEEN ${fromIso} AND ${toIso}
    GROUP BY resolved
  `)

  // Сценарии — топ по кликам, с разбивкой откуда кликнули (сайдбар / главная).
  const scenarioTop = await db.execute<{ scenarioId: string; source: string; count: number }>(sql`
    SELECT metadata->>'scenarioId' AS "scenarioId", metadata->>'source' AS source, COUNT(*)::int AS count
    FROM ui_events
    WHERE event_type = 'scenario_pick' AND created_at BETWEEN ${fromIso} AND ${toIso}
    GROUP BY "scenarioId", source
    ORDER BY count DESC
    LIMIT 30
  `)

  // Side-панель документа — сколько раз реально открыли явным кликом по карточке
  // vs сколько раз она открылась автоматически сразу после генерации.
  const artifactBySource = await db.execute<{ source: string; count: number }>(sql`
    SELECT COALESCE(metadata->>'source', 'unknown') AS source, COUNT(*)::int AS count
    FROM ui_events
    WHERE event_type = 'artifact_panel_view' AND created_at BETWEEN ${fromIso} AND ${toIso}
    GROUP BY source
  `)

  // Вкладки чата — переключение между уже открытыми vs открытие новой вкладки.
  const chatTabSwitch = byType.find((r) => r.eventType === "chat_tab_click")?.count ?? 0
  const chatTabNew = byType.find((r) => r.eventType === "chat_tab_new_click")?.count ?? 0

  return c.json({
    range: { from: fromIso, to: toIso },
    byType,
    history: {
      distinctUsersClicked: historyDistinctUsers?.users ?? 0,
      bySource: historyBySource,
      byRank: historyByRank,
      byAge: historyByAge,
    },
    newTask: { byResolved: newTaskByResolved },
    scenarios: { top: scenarioTop },
    artifactPanel: { bySource: artifactBySource },
    chatTabs: { switchClicks: chatTabSwitch, newTabClicks: chatTabNew },
  })
})

adminRoutes.get("/events", requireAdmin, async (c) => {
  const params = Object.fromEntries(new URL(c.req.url).searchParams)
  const type = params.type && (EVENT_TYPES as readonly string[]).includes(params.type) ? params.type : undefined
  const limit = Math.min(parseInt(params.limit ?? "100", 10) || 100, 500)
  const offset = Math.max(parseInt(params.offset ?? "0", 10) || 0, 0)

  const rows = await db
    .select({
      id: schema.uiEvents.id,
      userId: schema.uiEvents.userId,
      email: schema.users.email,
      eventType: schema.uiEvents.eventType,
      metadata: schema.uiEvents.metadata,
      createdAt: schema.uiEvents.createdAt,
    })
    .from(schema.uiEvents)
    .leftJoin(schema.users, eq(schema.uiEvents.userId, schema.users.id))
    .where(type ? eq(schema.uiEvents.eventType, type) : undefined)
    .orderBy(desc(schema.uiEvents.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({ items: rows, eventTypes: EVENT_TYPES })
})

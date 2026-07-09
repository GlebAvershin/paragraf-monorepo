/**
 * UI click-аналитика (2026-07-09) — приём событий от рендерера.
 *
 *   POST /events   — {eventType, metadata?} → одна строка в ui_events
 *
 * Список eventType — закрытый (см. EVENT_TYPES), чтобы дашборд аналитика не
 * захламлялся опечатками/случайными значениями из клиента. Читающая сторона —
 * routes/admin.ts (GET /admin/events, /admin/events/summary), гейтится
 * ADMIN_TOKEN, не пользовательским JWT.
 */
import { Hono } from "hono"
import { db, schema } from "../db/client.ts"
import { requireSession } from "../lib/middleware.ts"

export const eventsRoutes = new Hono()

export const EVENT_TYPES = [
  "history_click",
  "new_task_click",
  "scenario_pick",
  "artifact_panel_view",
  "chat_tab_click",
  "chat_tab_new_click",
  "source_link_click",
] as const

const MAX_METADATA_JSON_LENGTH = 2000

eventsRoutes.post("/", requireSession, async (c) => {
  const { sub: userId } = c.get("session")
  const body = await c.req.json().catch(() => null)
  const eventType = typeof body?.eventType === "string" ? body.eventType : ""
  if (!(EVENT_TYPES as readonly string[]).includes(eventType)) {
    return c.json({ error: "invalid_event_type" }, 400)
  }
  const metadata =
    body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : {}
  if (JSON.stringify(metadata).length > MAX_METADATA_JSON_LENGTH) {
    return c.json({ error: "metadata_too_large" }, 400)
  }
  await db.insert(schema.uiEvents).values({ userId, eventType, metadata })
  return c.body(null, 204)
})

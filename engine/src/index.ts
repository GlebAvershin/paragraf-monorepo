/**
 * Движок «Параграф» — многопользовательский бэкенд для веб-рендерера.
 *
 * Реализует подмножество API opencode (контракт SDK рендерера): health + auth
 * (billing-JWT) + session CRUD (Postgres jsonb) + prompt-стрим к шлюзу + SSE-события.
 * Контракт типов — packages/sdk/js/src/gen/types.gen.ts.
 */
import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { config } from "./config.ts"
import { requireSession, type Session as Auth } from "./auth.ts"
import { initSchema } from "./db.ts"
import { createSession, getSession, listMessages, listSessions, removeSession, updateSession } from "./sessions.ts"
import { subscribe } from "./bus.ts"
import { runPrompt } from "./chat.ts"
import { meta } from "./meta.ts"

type Env = { Variables: { session: Auth; token: string } }

const app = new Hono<Env>()
app.use("*", cors())

app.get("/health/readiness", (c) => c.json({ status: "ok" }))
app.get("/health/liveliness", (c) => c.text("alive"))

// Метаданные-заглушки (config/provider/project/command/agent/path + скрытые группы).
app.route("/", meta)

app.use("/session", requireSession)
app.use("/session/*", requireSession)
app.use("/event", requireSession)

// === session.* ===
app.get("/session", async (c) => c.json(await listSessions(c.var.session.userId)))

app.post("/session", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return c.json(await createSession(c.var.session.userId, { title: body?.title, parentID: body?.parentID }))
})

app.get("/session/:id", async (c) => {
  const s = await getSession(c.var.session.userId, c.req.param("id"))
  return s ? c.json(s) : c.json({ error: "not_found" }, 404)
})

app.patch("/session/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const s = await updateSession(c.var.session.userId, c.req.param("id"), { title: body?.title })
  return s ? c.json(s) : c.json({ error: "not_found" }, 404)
})

app.delete("/session/:id", async (c) => {
  const ok = await removeSession(c.var.session.userId, c.req.param("id"))
  return c.json({ ok })
})

app.get("/session/:id/message", async (c) => c.json(await listMessages(c.var.session.userId, c.req.param("id"))))

// prompt: POST /session/:id/message — запускает цикл, шлёт SSE-события, возвращает {info, parts}.
app.post("/session/:id/message", async (c) => {
  const sessionID = c.req.param("id")
  const session = await getSession(c.var.session.userId, sessionID)
  if (!session) return c.json({ error: "not_found" }, 404)
  const body = await c.req.json().catch(() => ({}))
  const model = body?.model ?? { providerID: "anthropic", modelID: "claude-sonnet" }
  const result = await runPrompt({
    userId: c.var.session.userId,
    token: c.var.token,
    sessionID,
    model,
    agent: body?.agent,
    parts: Array.isArray(body?.parts) ? body.parts : [],
  })
  return c.json(result)
})

// === SSE-поток событий: дренит шину для userId ===
app.get("/event", (c) =>
  streamSSE(c, async (stream) => {
    const sub = subscribe(c.var.session.userId)
    stream.onAbort(() => sub.close())
    await stream.writeSSE({ data: JSON.stringify({ type: "server.connected", properties: {} }) })
    for await (const event of sub.events) {
      await stream.writeSSE({ data: JSON.stringify(event) })
    }
  }),
)

await initSchema()
console.log(`[engine] listening on :${config.PORT} (gateway=${config.GATEWAY_URL})`)

export default { port: config.PORT, fetch: app.fetch }

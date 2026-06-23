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
app.use("/global/*", requireSession)

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

// Список todo сессии — фича кодинг-агента, у нас не используется. Пустой массив,
// чтобы рендерер (поллинг todo активной сессии) не получал 404.
app.get("/session/:id/todo", (c) => c.json([]))

// Тело prompt-запроса (подмножество контракта SessionPromptAsyncData.body, types.gen.ts).
type PromptBody = {
  messageID?: string
  model?: { providerID: string; modelID: string }
  agent?: string
  parts?: Array<{ type: string; text?: string }>
}
const promptArgs = (userId: string, token: string, sessionID: string, body: PromptBody) => ({
  userId,
  token,
  sessionID,
  messageID: body.messageID,
  model: body.model ?? { providerID: "anthropic", modelID: "claude-sonnet" },
  agent: body.agent,
  parts: Array.isArray(body.parts) ? body.parts : [],
})

// prompt_async: рендерер шлёт сюда (sdk.session.promptAsync). По контракту — 204
// сразу, результат идёт по SSE (message.updated / message.part.updated / session.idle).
// Юзер-сообщение рендерер рисует оптимистично сам → выполняем fire-and-forget.
app.post("/session/:id/prompt_async", async (c) => {
  const sessionID = c.req.param("id")
  const session = await getSession(c.var.session.userId, sessionID)
  if (!session) return c.json({ error: "not_found" }, 404)
  const body = (await c.req.json().catch(() => ({}))) as PromptBody
  void runPrompt(promptArgs(c.var.session.userId, c.var.token, sessionID, body)).catch((err) =>
    console.error("[engine] runPrompt failed", err),
  )
  return c.body(null, 204)
})

// Синхронный вариант (curl/отладка): тот же цикл, но ждёт и возвращает {info, parts}.
app.post("/session/:id/message", async (c) => {
  const sessionID = c.req.param("id")
  const session = await getSession(c.var.session.userId, sessionID)
  if (!session) return c.json({ error: "not_found" }, 404)
  const body = (await c.req.json().catch(() => ({}))) as PromptBody
  return c.json(await runPrompt(promptArgs(c.var.session.userId, c.var.token, sessionID, body)))
})

// Глобальные эндпоинты (рендерер ходит с префиксом /global).
app.get("/global/config", (c) => c.json({}))
app.post("/global/dispose", (c) => c.json({ ok: true }))

// === SSE-поток событий: рендерер слушает /global/event ===
// Контракт кадра — {directory, payload:{type,properties}} (types.gen.ts). Connection-
// события → directory "global"; chat/session-события → "/" (директория наших сессий).
const frame = (e: { type: string; properties?: Record<string, unknown> }) => {
  const directory = e.type.startsWith("server.") || e.type === "global.disposed" ? "global" : "/"
  return JSON.stringify({ directory, payload: { type: e.type, properties: e.properties ?? {} } })
}
app.get("/global/event", (c) =>
  streamSSE(c, async (stream) => {
    const sub = subscribe(c.var.session.userId)
    stream.onAbort(() => sub.close())
    await stream.writeSSE({ data: frame({ type: "server.connected", properties: {} }) })
    for await (const event of sub.events) {
      await stream.writeSSE({ data: frame(event) })
    }
  }),
)

await initSchema()
console.log(`[engine] listening on :${config.PORT} (gateway=${config.GATEWAY_URL})`)

// idleTimeout: 0 — НЕ убивать долгоживущие SSE-соединения (/global/event) по простою.
// Дефолтные 10с Bun.serve рвали стрим → клиент видел обрыв → ретрай-шторм onSseError.
export default { port: config.PORT, idleTimeout: 0, fetch: app.fetch }

/**
 * Движок Isaac — многопользовательский бэкенд для веб-рендерера.
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
import {
  countAllSessions,
  createSession,
  getSession,
  listAllSessions,
  listMessages,
  listMessagesAdmin,
  listSessions,
  removeSession,
  updateSession,
} from "./sessions.ts"
import { subscribe } from "./bus.ts"
import { runPrompt } from "./chat.ts"
import { meta } from "./meta.ts"

type Env = { Variables: { session: Auth; token: string } }

const app = new Hono<Env>()
// CORS allowlist — было `cors()` (wildcard, любой origin). Движок хранит СЫРУЮ
// историю чатов (ПДн, 152-ФЗ) за JWT-авторизацией; wildcard ослаблял защиту
// (при утечке JWT — напр. XSS — любой сторонний origin мог читать ответы).
// Тот же паттерн, что в billing/index.ts: localhost/127.0.0.1 на любом порту
// (dev/vite) + same-origin/file:// + опциональный прод-домен WEB_PUBLIC_URL.
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin
      if (config.WEB_PUBLIC_URL && origin === config.WEB_PUBLIC_URL) return origin
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin
      return null
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    // x-opencode-directory/-workspace — SDK-клиент (createOpencodeClient, packages/sdk/js/src/v2/client.ts)
    // вешает их на КАЖДЫЙ запрос через config.headers, когда задан directory. Для GET/HEAD клиент сам
    // убирает их (rewrite() переносит в query), а для POST/PATCH/DELETE — оставляет как реальный header.
    // Без них в allowHeaders браузер валит preflight на любой не-GET запрос (сервер отвечает 204 на OPTIONS,
    // но т.к. Access-Control-Allow-Headers уже сервера не покрывает запрошенный header, сам POST браузер
    // не отправляет) → создание сессии/сообщения падает с "Failed to fetch" при живом сервере.
    allowHeaders: ["Content-Type", "Authorization", "x-opencode-directory", "x-opencode-workspace", "x-admin-token"],
  }),
)

app.get("/health/readiness", (c) => c.json({ status: "ok" }))
app.get("/health/liveliness", (c) => c.text("alive"))

// === Admin — просмотр переписки ЛЮБОГО пользователя для разработчиков (не гейтится
// пользовательским JWT — отдельный секрет ADMIN_TOKEN, см. config.ts). Пусто в конфиге ⇒
// 503 на всех /admin/* (явный отказ, а не молчаливое "открыто без пароля").
// ВАЖНО: зарегистрировано ДО app.route("/", meta) ниже — meta.use("*", requireSession)
// смонтирован в корень и иначе перехватывает ЛЮБОЙ ещё не обработанный путь (включая
// /admin/*) требованием пользовательского JWT раньше, чем Hono доходит до этих роутов
// (поймано 2026-07-05: гейт с ADMIN_TOKEN молча не срабатывал, отвечал requireSession).
app.use("/admin/*", async (c, next) => {
  if (!config.ADMIN_TOKEN) return c.json({ error: "admin_disabled" }, 503)
  if (c.req.header("x-admin-token") !== config.ADMIN_TOKEN) return c.json({ error: "unauthorized" }, 401)
  return next()
})

app.get("/admin/sessions", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500)
  const offset = Number(c.req.query("offset") ?? 0)
  const [sessions, total] = await Promise.all([listAllSessions(limit, offset), countAllSessions()])
  return c.json({ sessions, total })
})

app.get("/admin/sessions/:id/messages", async (c) => {
  return c.json(await listMessagesAdmin(c.req.param("id")))
})

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
  const archived = typeof body?.time?.archived === "number" ? body.time.archived : undefined
  const s = await updateSession(c.var.session.userId, c.req.param("id"), {
    title: body?.title,
    ...(archived !== undefined ? { time: { archived } } : {}),
  })
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
  variant?: string
  // file-части (image/*) — сканы: пересылаются в gateway на server-side OCR.
  parts?: Array<{ type: string; text?: string; mime?: string; url?: string; filename?: string }>
}
const promptArgs = (userId: string, token: string, sessionID: string, body: PromptBody) => ({
  userId,
  token,
  sessionID,
  messageID: body.messageID,
  model: body.model ?? { providerID: "ourapp-ru", modelID: "gigachat-pro" },
  agent: body.agent,
  variant: body.variant,
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
  const directory = e.type.startsWith("server.") || e.type === "global.disposed" || e.type === "sync" ? "global" : "/"
  return JSON.stringify({ directory, payload: { type: e.type, properties: e.properties ?? {} } })
}
// Рендерер (global-sdk) рвёт SSE, если событий нет дольше HEARTBEAT_TIMEOUT_MS=15с,
// и реконнектится → шторм. Шлём sync-кадр каждые 10с: reducer его игнорирует
// (payload.type === "sync" → continue), но resetHeartbeat() в рендерере срабатывает
// на ЛЮБОМ событии до этой проверки → соединение живёт.
const HEARTBEAT_MS = 10_000
app.get("/global/event", (c) =>
  streamSSE(c, async (stream) => {
    const sub = subscribe(c.var.session.userId)
    let alive = true
    const heartbeat = setInterval(() => {
      if (alive) void stream.writeSSE({ data: frame({ type: "sync", properties: {} }) })
    }, HEARTBEAT_MS)
    const cleanup = () => {
      alive = false
      clearInterval(heartbeat)
      sub.close()
    }
    stream.onAbort(cleanup)
    try {
      await stream.writeSSE({ data: frame({ type: "server.connected", properties: {} }) })
      for await (const event of sub.events) {
        await stream.writeSSE({ data: frame(event) })
      }
    } finally {
      cleanup()
    }
  }),
)

await initSchema()
console.log(`[engine] listening on :${config.PORT} (answer=${config.ANSWER_URL})`)

// idleTimeout: 0 — НЕ убивать долгоживущие SSE-соединения (/global/event) по простою.
// Дефолтные 10с Bun.serve рвали стрим → клиент видел обрыв → ретрай-шторм onSseError.
export default { port: config.PORT, idleTimeout: 0, fetch: app.fetch }

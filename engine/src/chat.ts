/**
 * Ядро чата: prompt → запрос к НАШЕМУ шлюзу (LiteLLM, OpenAI-совместимый стрим) →
 * накопление текста в части ассистента → SSE-события (контракт opencode).
 *
 * Бюджет/кредиты считаются per-user: зовём шлюз litellm-ключом юзера (из billing).
 * Маскирование ПДн уже сделано на клиенте (152-ФЗ) — движок получает обезличенный текст.
 */
import { config } from "./config.ts"
import { publish } from "./bus.ts"
import { getLitellmKey } from "./billing.ts"
import { getSession, updateSession } from "./sessions.ts"
import {
  historyForGateway,
  insertMessage,
  insertPart,
  newId,
  updateMessage,
  updatePart,
  type StoredMessage,
  type StoredPart,
} from "./messages.ts"

export interface PromptInput {
  userId: string
  token: string
  sessionID: string
  /** id сообщения юзера, сгенерённый рендерером (optimistic) — переиспользуем, чтобы
   *  SSE-реконсиляция совпала по id; иначе свой. */
  messageID?: string
  model: { providerID: string; modelID: string }
  agent?: string
  /** opencode-вариант (deep-thinking тумблер шлёт "high") — транслируем в reasoning_effort. */
  variant?: string
  parts: Array<{ type: string; text?: string }>
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

/**
 * «Углублённо»: вариант opencode → reasoning_effort для шлюза. Только для Claude
 * (RU-модели thinking не поддерживают). LiteLLM мапит reasoning_effort на нативный
 * thinking-бюджет Anthropic в /chat/completions. max → high (выше у LiteLLM нет).
 */
function thinkingEffort(variant: string | undefined, modelID: string): "low" | "medium" | "high" | undefined {
  if (!variant || !/^claude-(sonnet|opus)/.test(modelID)) return undefined
  if (variant === "low") return "low"
  if (variant === "medium") return "medium"
  if (variant === "high" || variant === "max") return "high"
  return undefined
}

// Заголовок сессии. У движка нет серверного title-агента opencode (он жил в sidecar),
// поэтому после первого обмена генерируем краткий заголовок дешёвой моделью сами.
// claude-haiku — дёшево и доступно; в проде разумно переключить на РФ-модель (gigachat-pro).
const TITLE_MODEL = "claude-haiku"
const DEFAULT_TITLE = "Новая сессия"

async function generateTitle(key: string, userText: string, assistantText: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${config.GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: TITLE_MODEL,
        max_tokens: 30,
        messages: [
          {
            role: "system",
            content:
              "Сгенерируй короткий заголовок диалога на русском: 3–6 слов, по сути запроса. Без кавычек, без точки в конце, без префиксов вроде «Заголовок:».",
          },
          { role: "user", content: `Запрос: ${userText.slice(0, 600)}\n\nОтвет: ${assistantText.slice(0, 300)}` },
        ],
      }),
    })
    if (!res.ok) return undefined
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const raw = json.choices?.[0]?.message?.content?.trim()
    if (!raw) return undefined
    const title = raw.replace(/^["'«»\s]+|["'«».\s]+$/g, "").slice(0, 80)
    return title || undefined
  } catch {
    return undefined
  }
}

// Генерируем заголовок только для первого обмена (пока он дефолтный). Fire-and-forget:
// session.updated прилетит чуть позже, не задерживая ответ/idle.
async function maybeGenerateTitle(
  userId: string,
  sessionID: string,
  key: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const session = await getSession(userId, sessionID)
  if (!session || session.title !== DEFAULT_TITLE) return
  const title = await generateTitle(key, userText, assistantText)
  if (!title) return
  const updated = await updateSession(userId, sessionID, { title })
  if (updated) publish(userId, { type: "session.updated", properties: { info: updated } })
}

export async function runPrompt(input: PromptInput): Promise<{ info: StoredMessage; parts: StoredPart[] }> {
  const { userId, sessionID } = input
  const now = Date.now()
  const agent = input.agent ?? "build"

  // 1. Сообщение юзера + его текстовые части.
  const userMsg: StoredMessage = {
    id: input.messageID ?? newId("msg"),
    sessionID,
    role: "user",
    time: { created: now },
    agent,
    model: input.model,
  }
  await insertMessage(userId, userMsg)
  publish(userId, { type: "message.updated", properties: { info: userMsg } })

  let idx = 0
  for (const p of input.parts) {
    if (p.type !== "text" || !p.text) continue
    const part: StoredPart = { id: newId("prt"), sessionID, messageID: userMsg.id, type: "text", text: p.text }
    await insertPart(userId, idx++, part)
    publish(userId, { type: "message.part.updated", properties: { part } })
  }

  // 2. Сессия «занята».
  publish(userId, { type: "session.status", properties: { sessionID, status: { type: "busy" } } })

  // 3. Пустое сообщение ассистента + пустая текст-часть.
  const asstMsg: StoredMessage = {
    id: newId("msg"),
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: userMsg.id,
    modelID: input.model.modelID,
    providerID: input.model.providerID,
    mode: agent,
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: ZERO_TOKENS,
  }
  await insertMessage(userId, asstMsg)
  publish(userId, { type: "message.updated", properties: { info: asstMsg } })

  // «Углублённо»: reasoning_effort транслируем в шлюз. id reasoning-части резервируем
  // ВСЕГДА и ДО id text-части (рендерер сортирует части лексически по id → reasoning
  // пойдёт первой; text держим на idx 1, оставляя idx 0 под reasoning). Саму reasoning-
  // часть создаём ЛЕНИВО на первом reasoning-дельте — модель может вернуть thinking и
  // без явного effort, поэтому id нужен всегда, иначе onReasoning создаст часть без id.
  const effort = thinkingEffort(input.variant, input.model.modelID)
  const reasoningPartId = newId("prt")
  let reasoningPart: StoredPart | undefined

  const asstPart: StoredPart = { id: newId("prt"), sessionID, messageID: asstMsg.id, type: "text", text: "" }
  await insertPart(userId, 1, asstPart)
  publish(userId, { type: "message.part.updated", properties: { part: asstPart } })

  // 4. Стрим от шлюза.
  try {
    const key = await getLitellmKey(input.token)
    if (!key) throw new Error("Нет доступа к моделям (litellm-ключ не найден). Проверьте подписку.")

    const messages = await historyForGateway(userId, sessionID)
    const res = await fetch(`${config.GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model.modelID,
        messages,
        stream: true,
        // LiteLLM мапит reasoning_effort на нативный thinking Anthropic.
        ...(effort ? { reasoning_effort: effort } : {}),
      }),
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "")
      throw new Error(`Шлюз вернул ${res.status}: ${detail.slice(0, 200)}`)
    }

    await consumeOpenAIStream(res.body, {
      onText: async (delta) => {
        asstPart.text = (asstPart.text as string) + delta
        await updatePart(userId, asstPart)
        publish(userId, { type: "message.part.updated", properties: { part: asstPart, delta } })
      },
      onReasoning: async (delta) => {
        if (!reasoningPart) {
          reasoningPart = {
            id: reasoningPartId,
            sessionID,
            messageID: asstMsg.id,
            type: "reasoning",
            text: "",
            time: { start: Date.now() },
          }
          await insertPart(userId, 0, reasoningPart)
        }
        reasoningPart.text = (reasoningPart.text as string) + delta
        await updatePart(userId, reasoningPart)
        publish(userId, { type: "message.part.updated", properties: { part: reasoningPart, delta } })
      },
    })

    // Закрываем reasoning-часть (time.end) — рендерер перестаёт считать её «в процессе».
    if (reasoningPart) {
      reasoningPart.time = { start: (reasoningPart.time as { start: number }).start, end: Date.now() }
      await updatePart(userId, reasoningPart)
      publish(userId, { type: "message.part.updated", properties: { part: reasoningPart } })
    }

    // Заголовок сессии (только первый обмен) — fire-and-forget, чтобы не задерживать idle.
    const userText = input.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join(" ")
    void maybeGenerateTitle(userId, sessionID, key, userText, asstPart.text as string).catch(() => {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    asstPart.text = (asstPart.text as string) + (asstPart.text ? "\n\n" : "") + `⚠️ ${msg}`
    await updatePart(userId, asstPart)
    publish(userId, { type: "message.part.updated", properties: { part: asstPart } })
    asstMsg.error = { name: "ProviderError", data: { message: msg } }
  }

  // 5. Финализация + idle.
  asstMsg.time = { created: (asstMsg.time as { created: number }).created, completed: Date.now() }
  await updateMessage(userId, asstMsg)
  publish(userId, { type: "message.updated", properties: { info: asstMsg } })
  // Снять статус «занята»: контракт — session.status со status:{type:"idle"}
  // (event-reducer пишет session_status[id]; отдельного "session.idle" он НЕ знает,
  // иначе индикатор «Размышление» не гаснет после ответа).
  publish(userId, { type: "session.status", properties: { sessionID, status: { type: "idle" } } })
  await updateSession(userId, sessionID, {}) // bump time.updated

  return { info: asstMsg, parts: [asstPart] }
}

/** Разобрать OpenAI-совместимый SSE-стрим (data: {...delta...}\n\n, конец — data: [DONE]).
 *  content → onText; reasoning_content/reasoning (thinking Claude через LiteLLM) → onReasoning. */
async function consumeOpenAIStream(
  body: ReadableStream<Uint8Array>,
  handlers: { onText: (delta: string) => Promise<void>; onReasoning: (delta: string) => Promise<void> },
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (payload === "[DONE]") return
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>
        }
        const delta = json.choices?.[0]?.delta
        const reasoning = delta?.reasoning_content ?? delta?.reasoning
        if (typeof reasoning === "string" && reasoning) await handlers.onReasoning(reasoning)
        if (delta?.content) await handlers.onText(delta.content)
      } catch {
        // частичный/служебный кадр — пропускаем
      }
    }
  }
}

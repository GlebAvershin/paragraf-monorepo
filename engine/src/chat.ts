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
import { updateSession } from "./sessions.ts"
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
  parts: Array<{ type: string; text?: string }>
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

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

  const asstPart: StoredPart = { id: newId("prt"), sessionID, messageID: asstMsg.id, type: "text", text: "" }
  await insertPart(userId, 0, asstPart)
  publish(userId, { type: "message.part.updated", properties: { part: asstPart } })

  // 4. Стрим от шлюза.
  try {
    const key = await getLitellmKey(input.token)
    if (!key) throw new Error("Нет доступа к моделям (litellm-ключ не найден). Проверьте подписку.")

    const messages = await historyForGateway(userId, sessionID)
    const res = await fetch(`${config.GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: input.model.modelID, messages, stream: true }),
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "")
      throw new Error(`Шлюз вернул ${res.status}: ${detail.slice(0, 200)}`)
    }

    await consumeOpenAIStream(res.body, async (delta) => {
      asstPart.text = (asstPart.text as string) + delta
      await updatePart(userId, asstPart)
      publish(userId, { type: "message.part.updated", properties: { part: asstPart, delta } })
    })
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

/** Разобрать OpenAI-совместимый SSE-стрим (data: {...delta...}\n\n, конец — data: [DONE]). */
async function consumeOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => Promise<void>,
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
        const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
        const delta = json.choices?.[0]?.delta?.content
        if (delta) await onDelta(delta)
      } catch {
        // частичный/служебный кадр — пропускаем
      }
    }
  }
}

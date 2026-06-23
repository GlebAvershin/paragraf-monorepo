/**
 * Персистентность сообщений и частей (контракт opencode: UserMessage/AssistantMessage/TextPart).
 * Хранение — jsonb (db.ts). Апдейты нужны для стриминга (накопление текста в части).
 */
import { sql, jsonb } from "./db.ts"

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`

export interface StoredMessage {
  id: string
  sessionID: string
  role: "user" | "assistant"
  [key: string]: unknown
}
export interface StoredPart {
  id: string
  sessionID: string
  messageID: string
  type: string
  [key: string]: unknown
}

export async function insertMessage(userId: string, m: StoredMessage): Promise<void> {
  const created = (m.time as { created?: number })?.created ?? Date.now()
  await sql`
    INSERT INTO messages (id, session_id, user_id, role, data, created)
    VALUES (${m.id}, ${m.sessionID}, ${userId}, ${m.role}, ${jsonb(m)}, ${created})`
}

export async function updateMessage(userId: string, m: StoredMessage): Promise<void> {
  await sql`UPDATE messages SET data = ${jsonb(m)} WHERE user_id = ${userId} AND id = ${m.id}`
}

export async function insertPart(userId: string, idx: number, p: StoredPart): Promise<void> {
  await sql`
    INSERT INTO parts (id, message_id, session_id, user_id, idx, data)
    VALUES (${p.id}, ${p.messageID}, ${p.sessionID}, ${userId}, ${idx}, ${jsonb(p)})`
}

export async function updatePart(userId: string, p: StoredPart): Promise<void> {
  await sql`UPDATE parts SET data = ${jsonb(p)} WHERE user_id = ${userId} AND id = ${p.id}`
}

/** История сессии в формате OpenAI-чата (для запроса к шлюзу). */
export async function historyForGateway(
  userId: string,
  sessionID: string,
): Promise<Array<{ role: string; content: string }>> {
  const msgs = await sql<{ id: string; role: string }[]>`
    SELECT id, role FROM messages WHERE user_id = ${userId} AND session_id = ${sessionID} ORDER BY created ASC`
  if (msgs.length === 0) return []
  const parts = await sql<{ message_id: string; data: { type?: string; text?: string } }[]>`
    SELECT message_id, data FROM parts WHERE user_id = ${userId} AND session_id = ${sessionID} ORDER BY idx ASC`
  const textByMsg = new Map<string, string>()
  for (const p of parts) {
    if (p.data?.type !== "text" || !p.data.text) continue
    textByMsg.set(p.message_id, (textByMsg.get(p.message_id) ?? "") + p.data.text)
  }
  return msgs
    .map((m) => ({ role: m.role, content: textByMsg.get(m.id) ?? "" }))
    .filter((m) => m.content.length > 0)
}

/**
 * Доменный слой сессий/сообщений — контрактные формы opencode (см.
 * packages/sdk/js/src/gen/types.gen.ts: Session / Message / Part). Хранение — jsonb (db.ts).
 *
 * projectID/directory у нас вестигиальны (продукт — чат, не «папка проекта»): фиксированные
 * значения, чтобы рендерер был доволен. Сортировка/группировка в UI идёт по time.updated.
 */
import { sql, jsonb } from "./db.ts"

export interface Session {
  id: string
  projectID: string
  directory: string
  parentID?: string
  title: string
  version: string
  time: { created: number; updated: number; archived?: number }
}

export interface MessageWithParts {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

const FIXED_PROJECT = "default"
const FIXED_DIR = "/"
const VERSION = "0.0.0"

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`

export async function createSession(userId: string, input?: { title?: string; parentID?: string }): Promise<Session> {
  const now = Date.now()
  const session: Session = {
    id: newId("ses"),
    projectID: FIXED_PROJECT,
    directory: FIXED_DIR,
    title: input?.title ?? "Новая сессия",
    version: VERSION,
    time: { created: now, updated: now },
    ...(input?.parentID ? { parentID: input.parentID } : {}),
  }
  await sql`
    INSERT INTO sessions (id, user_id, data, created, updated)
    VALUES (${session.id}, ${userId}, ${jsonb(session)}, ${now}, ${now})`
  return session
}

// Заархивированные (data.time.archived задан) исключаются — «Архивировать» в UI должно
// убирать сессию из истории насовсем (экрана «показать архивные» пока нет).
export async function listSessions(userId: string): Promise<Session[]> {
  const rows = await sql<{ data: Session }[]>`
    SELECT data FROM sessions
    WHERE user_id = ${userId} AND data->'time'->>'archived' IS NULL
    ORDER BY updated DESC LIMIT 200`
  return rows.map((r) => r.data)
}

export async function getSession(userId: string, id: string): Promise<Session | null> {
  const rows = await sql<{ data: Session }[]>`
    SELECT data FROM sessions WHERE user_id = ${userId} AND id = ${id} LIMIT 1`
  return rows[0]?.data ?? null
}

export async function updateSession(
  userId: string,
  id: string,
  patch: { title?: string; time?: { archived?: number } },
): Promise<Session | null> {
  const current = await getSession(userId, id)
  if (!current) return null
  const next: Session = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    time: { ...current.time, ...patch.time, updated: Date.now() },
  }
  await sql`UPDATE sessions SET data = ${jsonb(next)}, updated = ${next.time.updated} WHERE user_id = ${userId} AND id = ${id}`
  return next
}

export async function removeSession(userId: string, id: string): Promise<boolean> {
  await sql`DELETE FROM parts WHERE user_id = ${userId} AND session_id = ${id}`
  await sql`DELETE FROM messages WHERE user_id = ${userId} AND session_id = ${id}`
  const res = await sql`DELETE FROM sessions WHERE user_id = ${userId} AND id = ${id}`
  return res.count > 0
}

export async function listMessages(userId: string, sessionID: string): Promise<MessageWithParts[]> {
  const msgs = await sql<{ id: string; data: Record<string, unknown> }[]>`
    SELECT id, data FROM messages WHERE user_id = ${userId} AND session_id = ${sessionID} ORDER BY created ASC`
  if (msgs.length === 0) return []
  const parts = await sql<{ message_id: string; data: Record<string, unknown> }[]>`
    SELECT message_id, data FROM parts WHERE user_id = ${userId} AND session_id = ${sessionID} ORDER BY idx ASC`
  const byMessage = new Map<string, Array<Record<string, unknown>>>()
  for (const p of parts) {
    const arr = byMessage.get(p.message_id) ?? []
    arr.push(p.data)
    byMessage.set(p.message_id, arr)
  }
  return msgs.map((m) => ({ info: m.data, parts: byMessage.get(m.id) ?? [] }))
}

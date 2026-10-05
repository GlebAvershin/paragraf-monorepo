/**
 * Хранилище движка. Подход: складываем САМИ контрактные объекты opencode
 * (Session/Message/Part) как jsonb + ключевые колонки для выборки (userId/sessionID/
 * messageID). Гарантирует точный round-trip контракта без помапливания каждого поля.
 *
 * Изоляция многопользовательности — по user_id (sub из billing-JWT). Один общий сервис.
 */
import postgres from "postgres"
import { config } from "./config.ts"

export const sql = postgres(config.DATABASE_URL, { onnotice: () => {} })

// Postgres JSONB НЕ хранит нулевой байт (падает «unsupported Unicode escape sequence») и бьётся
// на одиночных суррогатах. LLM-стрим (замечено на GLM/OpenRouter) иногда отдаёт такой мусор —
// раньше это роняло запись части, и текст ошибки всплывал как ответ ассистента (⚠️). Чистим строки
// посимвольно (без literal-escape'ов в исходнике): вырезаем NUL, одиночные суррогаты → U+FFFD.
const REPLACEMENT = String.fromCharCode(0xfffd)
function sanitizeString(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0) continue // NUL — JSONB не принимает
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i]! + s[i + 1]!
        i++
        continue
      }
      out += REPLACEMENT // одинокий high-суррогат
      continue
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      out += REPLACEMENT // одинокий low-суррогат
      continue
    }
    out += s[i]
  }
  return out
}

// Возвращаем НОВУЮ структуру (исходный part переиспользуется между дельтами стрима — мутировать нельзя).
const sanitizeJsonb = <T>(value: T): T => {
  if (typeof value === "string") return sanitizeString(value) as unknown as T
  if (Array.isArray(value)) return value.map(sanitizeJsonb) as unknown as T
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeJsonb(v)])) as T
  return value
}

/**
 * Мост для записи доменного объекта в jsonb-колонку. `sql.json()` — правильный
 * рантайм-API (хранит JSON-объект без двойного кодирования), но требует структурный
 * JSONValue, под который closed-интерфейсы не подходят (нет index-signature). Наши
 * объекты — валидный JSON, поэтому одиночный приведённый каст на границе сериализации.
 * Перед записью санитизируем строки (NUL/одиночные суррогаты — JSONB их не принимает).
 */
export const jsonb = (value: object) =>
  sql.json(sanitizeJsonb(value) as unknown as Parameters<typeof sql.json>[0])

/** Идемпотентная инициализация схемы при старте (миграции вынесем позже при росте). */
export async function initSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      data       JSONB NOT NULL,
      created    BIGINT NOT NULL,
      updated    BIGINT NOT NULL
    )`
  await sql`CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, updated DESC)`
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      role       TEXT NOT NULL,
      data       JSONB NOT NULL,
      created    BIGINT NOT NULL
    )`
  await sql`CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, created ASC)`
  await sql`
    CREATE TABLE IF NOT EXISTS parts (
      id         TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      idx        INT NOT NULL,
      data       JSONB NOT NULL
    )`
  await sql`CREATE INDEX IF NOT EXISTS parts_message_idx ON parts (message_id, idx ASC)`
  await sql`
    CREATE TABLE IF NOT EXISTS document_revisions (
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      document_key TEXT NOT NULL,
      revision INT NOT NULL,
      draft JSONB NOT NULL,
      updated BIGINT NOT NULL,
      PRIMARY KEY (user_id, session_id, document_key, revision)
    )`
}

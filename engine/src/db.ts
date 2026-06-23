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

/**
 * Мост для записи доменного объекта в jsonb-колонку. `sql.json()` — правильный
 * рантайм-API (хранит JSON-объект без двойного кодирования), но требует структурный
 * JSONValue, под который closed-интерфейсы не подходят (нет index-signature). Наши
 * объекты — валидный JSON, поэтому одиночный приведённый каст на границе сериализации.
 */
export const jsonb = (value: object) => sql.json(value as unknown as Parameters<typeof sql.json>[0])

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
}

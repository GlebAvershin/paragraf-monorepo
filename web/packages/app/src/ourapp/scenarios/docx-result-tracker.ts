/**
 * OurApp — трекер сессий, запущенных из сценария с resultAction=generate_docx.
 *
 * Проблема: message-timeline решает, показывать ли кнопку «Скачать .docx»,
 * по эвристике формы текста (заголовки/таблицы/длина). Но результат сценария
 * с resultAction=generate_docx может быть коротким нумерованным списком, который
 * эвристика не распознаёт — а кнопка там нужна детерминированно.
 *
 * Решение: когда сценарий с generate_docx запущен, помечаем sessionID. Тогда
 * для всех ответов ассистента в этой сессии кнопка показывается всегда —
 * без эвристики.
 *
 * Хранилище — sessionStorage (переживает HMR/перезагрузку renderer'а в рамках
 * вкладки, не утекает между запусками приложения).
 */

const STORAGE_KEY = "ourapp.docxSessions"

function load(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function save(set: Set<string>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    // sessionStorage недоступен — деградируем молча.
  }
}

/** Пометить, что в этой сессии ожидается генерация .docx из сценария. */
export function markDocxSession(sessionID: string): void {
  if (!sessionID) return
  const set = load()
  set.add(sessionID)
  save(set)
}

/** Запущен ли в этой сессии сценарий с resultAction=generate_docx. */
export function isDocxSession(sessionID: string): boolean {
  if (!sessionID) return false
  return load().has(sessionID)
}

/**
 * Обратный случай: сессия запущена из сценария с resultAction=show_in_chat
 * (или generate_table — на сегодня спецобработки не имеет, трактуем так же).
 *
 * Проблема: некоторые аналитические промпты сами просят модель «использовать
 * заголовки и нумерацию» для читаемости (см. tech.gost.lookup) — эвристика
 * looksLikeDocument() в message-timeline.tsx видит markdown-заголовки и
 * ошибочно показывает кнопки «Скачать .docx/PDF», хотя сценарий явно сказал
 * «это не документ». Явная пометка — приоритетнее эвристики (см. hasContent).
 */
const CHAT_ONLY_STORAGE_KEY = "ourapp.chatOnlySessions"

function loadChatOnly(): Set<string> {
  try {
    const raw = sessionStorage.getItem(CHAT_ONLY_STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function saveChatOnly(set: Set<string>): void {
  try {
    sessionStorage.setItem(CHAT_ONLY_STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    // sessionStorage недоступен — деградируем молча.
  }
}

/** Пометить, что в этой сессии сценарий явно сказал «результат — не документ». */
export function markChatOnlySession(sessionID: string): void {
  if (!sessionID) return
  const set = loadChatOnly()
  set.add(sessionID)
  saveChatOnly(set)
}

/** Запущен ли в этой сессии сценарий с resultAction≠generate_docx. */
export function isChatOnlySession(sessionID: string): boolean {
  if (!sessionID) return false
  return loadChatOnly().has(sessionID)
}

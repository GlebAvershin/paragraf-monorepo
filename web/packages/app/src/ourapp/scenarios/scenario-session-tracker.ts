/**
 * OurApp — трекер сессий, запущенных из сценария (любого).
 *
 * Нужен, чтобы композер знал: показывать обычный выбор модели + тумблер
 * «Углублённо» (прямое флоу), или упрощённый выбор из трёх тиров без имён
 * моделей (сценарии) — см. видео-ревью 2026-07-06: «в сценариях мы прячем
 * модели, которые мы используем и делим их только на средние, мощные,
 * мегамощные».
 *
 * Тот же паттерн хранения, что docx-result-tracker.ts (sessionStorage).
 */

const STORAGE_KEY = "ourapp.scenarioSessions"

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

/** Пометить, что сессия запущена из сценария (мастера). */
export function markScenarioSession(sessionID: string): void {
  if (!sessionID) return
  const set = load()
  set.add(sessionID)
  save(set)
}

/** Запущена ли сессия из сценария. */
export function isScenarioSession(sessionID: string | undefined): boolean {
  if (!sessionID) return false
  return load().has(sessionID)
}

/**
 * "Отложенная" пометка — сценарий стартует ДО того, как известен sessionID
 * новой сессии (навигация на "/session" без id, затем создание сессии async).
 * Компонент композера при этом может пересоздаться (новый route-match), теряя
 * локальный signal-state — поэтому флаг живёт в sessionStorage (переживает
 * ремаунт) и consume'ится один раз, как только sessionID станет известен.
 */
const PENDING_KEY = "ourapp.pendingScenarioSession"

export function markPendingScenarioSession(): void {
  try {
    sessionStorage.setItem(PENDING_KEY, "1")
  } catch {
    // sessionStorage недоступен — деградируем молча.
  }
}

/** Забрать и сбросить отложенную пометку. true — если она была выставлена. */
export function consumePendingScenarioSession(): boolean {
  try {
    const had = sessionStorage.getItem(PENDING_KEY) === "1"
    if (had) sessionStorage.removeItem(PENDING_KEY)
    return had
  } catch {
    return false
  }
}

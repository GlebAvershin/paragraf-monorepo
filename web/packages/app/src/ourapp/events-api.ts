/**
 * OurApp — клиент клик-аналитики (2026-07-09).
 *
 * trackEvent() — fire-and-forget POST на /events (billing). Никогда не бросает,
 * не блокирует UI, не задерживает навигацию — вызывать через `void trackEvent(...)`
 * прямо в onClick-хэндлере. Список типов событий — EVENT_TYPES, зеркало
 * billing/src/routes/events.ts (сервер отклоняет всё, чего нет в списке).
 */
import { getSessionToken } from "./auth-storage"

const BASE_URL =
  (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_OURAPP_BILLING_URL) ||
  (typeof import.meta !== "undefined" && !(import.meta as { env?: { DEV?: boolean } }).env?.DEV && typeof window !== "undefined"
    ? window.location.origin
    : "http://127.0.0.1:3000")

export const EVENT_TYPES = [
  "history_click",
  "new_task_click",
  "scenario_pick",
  "artifact_panel_view",
  "chat_tab_click",
  "chat_tab_new_click",
] as const

export type UiEventType = (typeof EVENT_TYPES)[number]

/** Источник клика по списку недавних сессий («История» в сайдбаре, «Продолжить работу» на
 * главной, или полная страница /history). */
export type HistoryClickSource = "sidebar_history" | "home_continue" | "history_page"

export async function trackEvent(eventType: UiEventType, metadata?: Record<string, unknown>): Promise<void> {
  const token = getSessionToken()
  if (!token) return // клики до логина не с чем связать по user_id
  try {
    await fetch(`${BASE_URL}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventType, metadata: metadata ?? {} }),
      signal: AbortSignal.timeout?.(5000),
      keepalive: true,
    })
  } catch {
    // аналитика best-effort — сетевой сбой не должен быть виден пользователю
  }
}

/**
 * OurApp — клиент внутренней админ-панели (просмотр переписки всех пользователей
 * для разработчиков). Дёргает ДВА независимых сервиса напрямую (не через customer-SDK):
 *   - engine  /admin/sessions, /admin/sessions/:id/messages — сама переписка
 *   - billing /admin/users                                  — email по user_id
 * Гейт — отдельный ADMIN_TOKEN (заголовок x-admin-token), НЕ пользовательский JWT.
 * Токен хранится в sessionStorage (не localStorage) — очищается с закрытием вкладки.
 */

const TOKEN_KEY = "ourapp.admin.token"

export function getAdminToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ""
  } catch {
    return ""
  }
}

export function setAdminToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {}
}

export function clearAdminToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {}
}

// Прод: same-origin (Caddy проксирует /admin/users → billing, /admin/sessions* → engine
// на одном домене). Dev: отдельные порты — тот же паттерн, что billing-api.ts/entry.tsx.
const BILLING_BASE_URL =
  (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_OURAPP_BILLING_URL) ||
  (typeof import.meta !== "undefined" && !(import.meta as { env?: { DEV?: boolean } }).env?.DEV && typeof window !== "undefined"
    ? window.location.origin
    : "http://127.0.0.1:3000")

const ENGINE_BASE_URL =
  (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_OURAPP_ENGINE_URL) ||
  (typeof import.meta !== "undefined" && !(import.meta as { env?: { DEV?: boolean } }).env?.DEV && typeof window !== "undefined"
    ? window.location.origin
    : "http://127.0.0.1:4096")

export interface AdminUser {
  id: string
  email: string
  name: string | null
  status: string
  createdAt: string
}

export interface AdminSession {
  id: string
  userId: string
  title: string
  time: { created: number; updated: number; archived?: number }
}

export interface AdminMessageWithParts {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

// ===== Клик-аналитика (2026-07-09) =====

export interface AdminEventsSummary {
  range: { from: string; to: string }
  byType: Array<{ eventType: string; count: number }>
  history: {
    distinctUsersClicked: number
    bySource: Array<{ source: string | null; count: number }>
    byRank: Array<{ source: string | null; rank: number; count: number }>
    byAge: Array<{ bucket: string; count: number }>
  }
  newTask: { byResolved: Array<{ resolved: string; count: number }> }
  scenarios: { top: Array<{ scenarioId: string | null; source: string | null; count: number }> }
  artifactPanel: { bySource: Array<{ source: string; count: number }> }
  chatTabs: { switchClicks: number; newTabClicks: number }
  sourceLinks: { top: Array<{ docId: string | null; count: number }> }
}

export interface AdminEventItem {
  id: number
  userId: string
  email: string | null
  eventType: string
  metadata: Record<string, unknown>
  createdAt: string
}

export type AdminResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number }

async function adminFetch<T>(base: string, path: string): Promise<AdminResult<T>> {
  const token = getAdminToken()
  if (!token) return { ok: false, error: "no_token" }
  try {
    const res = await fetch(`${base}${path}`, { headers: { "x-admin-token": token } })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string })
      return { ok: false, error: body?.error ?? `http_${res.status}`, status: res.status }
    }
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network_error" }
  }
}

export const adminApi = {
  users: () => adminFetch<{ users: AdminUser[] }>(BILLING_BASE_URL, "/admin/users"),
  sessions: (limit = 200, offset = 0) =>
    adminFetch<{ sessions: AdminSession[]; total: number }>(
      ENGINE_BASE_URL,
      `/admin/sessions?limit=${limit}&offset=${offset}`,
    ),
  messages: (sessionID: string) =>
    adminFetch<AdminMessageWithParts[]>(ENGINE_BASE_URL, `/admin/sessions/${sessionID}/messages`),
  eventsSummary: (from: Date, to: Date) =>
    adminFetch<AdminEventsSummary>(
      BILLING_BASE_URL,
      `/admin/events/summary?from=${from.toISOString()}&to=${to.toISOString()}`,
    ),
  events: (type?: string, limit = 100) =>
    adminFetch<{ items: AdminEventItem[] }>(
      BILLING_BASE_URL,
      `/admin/events?limit=${limit}${type ? `&type=${encodeURIComponent(type)}` : ""}`,
    ),
}

/**
 * OurApp — клиент кабинета менеджера (/manager/*).
 *
 * Тот же request<T>-паттерн, что billing-api.ts/usage-api.ts: те же правила
 * BASE_URL (прод — same-origin через Caddy), Bearer-JWT из auth-storage,
 * никаких throw — UI грейсфул-фоллбечит на { ok:false }.
 */
import { getSessionToken } from "./auth-storage"

const BASE_URL =
  (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_OURAPP_BILLING_URL) ||
  (typeof import.meta !== "undefined" && !(import.meta as { env?: { DEV?: boolean } }).env?.DEV && typeof window !== "undefined"
    ? window.location.origin
    : "http://127.0.0.1:3000")

export type ManagerResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number }

export interface TeamMemberUsage {
  credits: number
  requests: number
  tokens: number
  lastRequestAt: string | null
}

export interface TeamMember {
  userId: string
  email: string
  name: string | null
  status: string
  createdAt: string
  lastLoginAt: string | null
  balance: number
  usage: TeamMemberUsage
}

export interface TeamResponse {
  range: { from: string; to: string }
  managerBalance: number
  totals: { employees: number; credits: number; requests: number; tokens: number }
  members: TeamMember[]
}

export interface EmployeeUsageItem {
  id: number
  createdAt: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  creditsCharged: number
  scenarioId: string | null
  status: string
}

export interface EmployeeUsageResponse {
  employee: { id: string; email: string; name: string | null }
  range: { from: string; to: string }
  items: EmployeeUsageItem[]
  pagination: { limit: number; offset: number }
}

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<ManagerResult<T>> {
  const token = getSessionToken()
  try {
    const { timeoutMs, ...rest } = init ?? {}
    const res = await fetch(`${BASE_URL}${path}`, {
      ...rest,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(rest.headers ?? {}),
      },
      signal: AbortSignal.timeout?.(timeoutMs ?? 15_000),
    })
    const text = await res.text()
    const parsed: unknown = text ? safeJson(text) : null
    if (!res.ok) {
      const error =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`
      return { ok: false, error, status: res.status }
    }
    return { ok: true, data: parsed as T }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const isoRange = (from: Date, to: Date) => `from=${from.toISOString()}&to=${to.toISOString()}`

export const managerApi = {
  /** Стать менеджером. Доступно только самостоятельно заведённому аккаунту. */
  activate: () =>
    request<{ role: "manager"; alreadyManager: boolean }>("/manager/activate", { method: "POST" }),

  team: (from: Date, to: Date) => request<TeamResponse>(`/manager/team?${isoRange(from, to)}`),

  createEmployee: (input: { email: string; password: string; name?: string; initialCredits?: number }) =>
    request<{ userId: string; email: string; creditsTransferred: number }>("/manager/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      // Создание = вставка юзера + подписка + ключ в LiteLLM: дольше обычного GET.
      timeoutMs: 30_000,
    }),

  grantCredits: (userId: string, credits: number) =>
    request<{ transferred: number; managerBalance: number; employeeBalance: number }>(
      `/manager/team/${userId}/credits`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credits }),
      },
    ),

  employeeUsage: (userId: string, from: Date, to: Date, limit = 100) =>
    request<EmployeeUsageResponse>(`/manager/team/${userId}/usage?${isoRange(from, to)}&limit=${limit}`),
}

/** Человеческий текст для кодов ошибок бэкенда. */
export function managerErrorText(error: string): string {
  switch (error) {
    case "insufficient_credits":
      return "Не хватает кредитов на вашем балансе"
    case "email_taken":
      return "Пользователь с таким email уже существует"
    case "created_by_manager":
      return "Ваш аккаунт создан менеджером — стать менеджером нельзя"
    case "not_a_manager":
      return "Нужны права менеджера"
    case "manager_has_no_subscription":
      return "У вас нет активной подписки"
    case "employee_not_found":
      return "Сотрудник не найден"
    case "provisioning_failed":
      return "Аккаунт создан, но не удалось выдать доступ к моделям. Повторите — данные сохранятся."
    case "Invalid email":
      return "Некорректный email"
    default:
      return error
  }
}

/**
 * OurApp — реестр вертикалей (профессий) и их доступности.
 *
 * Единая точка правды: какие «двери» открыты, как их подписать, какая дефолтная.
 * Раньше эта логика дублировалась инлайном в 5 местах (onboarding, home, settings,
 * session, new-session-view) — теперь правится здесь одной строкой.
 *
 * Current product focus: lawyers and accountants. The technologist flow remains
 * in code for a future relaunch, but is not available in the user interface.
 */
import type { Vertical } from "./scenarios"

export type { Vertical }

export interface VerticalMeta {
  id: Vertical
  /** Короткая подпись («Технолог»). */
  label: string
  /** Доступна ли вертикаль для выбора прямо сейчас. */
  enabled: boolean
  /** Описание под заголовком двери в онбординге. */
  doorLede: string
  /** Лид на home-лендинге для активной вертикали. */
  heroLede: string
}

export const VERTICALS: Record<Vertical, VerticalMeta> = {
  technologist: {
    id: "technologist",
    label: "Технолог",
    enabled: false,
    doorLede: "Документы, стандарты, расчёты, рутина",
    heroLede: "Выберите сценарий, опишите задачу — получите готовый результат.",
  },
  lawyer: {
    id: "lawyer",
    label: "Юрист",
    enabled: true,
    doorLede: "Договоры, претензии, иски, ДДУ, корп. право",
    heroLede:
      "Проверка договоров, поиск рисков и подготовка документов — в одном рабочем пространстве. Начните с чата или выберите готовый сценарий.",
  },
  accountant: {
    id: "accountant",
    label: "Бухгалтер",
    enabled: true,
    doorLede: "Первичка, отчётность, ФНС, НК, контрагенты",
    heroLede:
      "Проверка первичных документов, ответы на требования ФНС и разбор налоговых вопросов. Начните с чата или выберите готовый сценарий.",
  },
}

/** Дефолтная вертикаль для новых и ранее технологических сессий. */
export const DEFAULT_VERTICAL: Vertical = "lawyer"

/** Вертикали, доступные в пользовательском интерфейсе. */
export const VERTICAL_ORDER: Vertical[] = ["lawyer", "accountant"]

export function verticalLabel(v: Vertical): string {
  return VERTICALS[v]?.label ?? "—"
}

export function isVerticalEnabled(v: Vertical): boolean {
  return VERTICALS[v]?.enabled ?? false
}

const STORAGE_KEY = "ourapp.primaryVertical"

/**
 * Прочитать выбранную вертикаль из localStorage. Если сохранённая вертикаль
 * выключена (например, «Технолог» у старого пользователя) или мусор — отдаём дефолт.
 */
export function loadVertical(): Vertical {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as Vertical | null
    if (stored && isVerticalEnabled(stored)) return stored
  } catch {}
  return DEFAULT_VERTICAL
}

export function saveVertical(v: Vertical): void {
  try {
    localStorage.setItem(STORAGE_KEY, v)
  } catch {}
}

/** Persists a local UI preference and its account-level source of truth. */
export function persistVertical(v: Vertical): void {
  saveVertical(v)
  if (v === "lawyer" || v === "accountant") {
    void billingApi.updatePrimaryVertical(v)
  }
}

export function clearVertical(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
}
import { billingApi } from "./billing-api"

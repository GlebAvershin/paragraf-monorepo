/**
 * OurApp — реестр вертикалей (профессий) и их доступности.
 *
 * Единая точка правды: какие «двери» открыты, как их подписать, какая дефолтная.
 * Раньше эта логика дублировалась инлайном в 5 местах (onboarding, home, settings,
 * session, new-session-view) — теперь правится здесь одной строкой.
 *
 * MVP (2026-07): первые клиенты — заводы (инженеры-технологи). Активна только
 * вертикаль «Технолог» (сценарии по ГОСТам). «Юрист»/«Бухгалтер» временно
 * выключены (enabled:false) — двери видны, но недоступны. Чтобы вернуть —
 * поставить enabled:true у нужной вертикали.
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
    enabled: true,
    doorLede: "Документы, стандарты, расчёты, рутина",
    heroLede:
      "Опишите задачу своими словами или загрузите документ — Isaac подберёт подходящую модель, разберётся в деталях и доведёт дело до готового результата.",
  },
  lawyer: {
    id: "lawyer",
    label: "Юрист",
    enabled: false,
    doorLede: "Договоры, претензии, иски, ДДУ, корп. право",
    heroLede:
      "Прочитает договор, найдёт риски, подготовит претензию. Не пустой чат — пошаговые сценарии под юриста.",
  },
  accountant: {
    id: "accountant",
    label: "Бухгалтер",
    enabled: false,
    doorLede: "Первичка, отчётность, ФНС, НК, контрагенты",
    heroLede:
      "Проверит первичку, ответит на требование ФНС, объяснит норму НК. Не пустой чат — пошаговые сценарии под бухгалтера.",
  },
}

/** Дефолтная вертикаль — первая активная (сейчас «Технолог»). */
export const DEFAULT_VERTICAL: Vertical = "technologist"

/** Все вертикали в порядке показа (активные первыми). */
export const VERTICAL_ORDER: Vertical[] = ["technologist", "lawyer", "accountant"]

export function verticalLabel(v: Vertical): string {
  return VERTICALS[v]?.label ?? "—"
}

export function isVerticalEnabled(v: Vertical): boolean {
  return VERTICALS[v]?.enabled ?? false
}

const STORAGE_KEY = "ourapp.primaryVertical"

/**
 * Прочитать выбранную вертикаль из localStorage. Если сохранённая вертикаль
 * выключена (напр. «Юрист» у старого пользователя) или мусор — отдаём дефолт.
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

/**
 * OurApp — уровни ответа для сценарных сессий (видео-ревью 2026-07-06).
 *
 * В сценариях (в отличие от прямого флоу) юзер не видит имена моделей —
 * только силу: Medium / Hi / Ultra. Под капотом это конкретные модели,
 * скрытые от юзера ровно как попросил коллега («чтобы они не знали, что
 * это за модельки»).
 */
export type ModelTier = "medium" | "hi" | "ultra"

export interface TierModelKey {
  providerID: string
  modelID: string
}

// Сценарии выполняются на YandexGPT в российском контуре. Уровень можно выбрать
// в самом диалоге, но набор ограничен тремя уровнями качества в российском контуре.
export const TIER_MODEL: Record<ModelTier, TierModelKey> = {
  medium: { providerID: "ourapp-ru", modelID: "yandexgpt-lite" },
  hi: { providerID: "ourapp-ru", modelID: "yandexgpt-pro" },
  ultra: { providerID: "ourapp-ru", modelID: "yandexgpt-5.1-pro" },
}

export const TIER_LABEL: Record<ModelTier, string> = {
  medium: "Базовый",
  hi: "Профессиональный",
  ultra: "Экспертный",
}

/** Короткое описание уровня — показывается рядом с названием в выпадашке. */
export const TIER_DESC: Record<ModelTier, string> = {
  medium: "Быстрые ответы и повседневные задачи",
  hi: "Анализ документов и сложные юридические задачи",
  ultra: "Максимальное качество для сложных документов и правового анализа",
}

export const TIER_ORDER: ModelTier[] = ["ultra", "hi", "medium"]

/** Какой тир соответствует уже выбранной модели (для подсветки текущего выбора). */
export function tierForModel(current: { id: string; provider: { id: string } } | undefined): ModelTier | undefined {
  if (!current) return undefined
  return TIER_ORDER.find(
    (tier) => TIER_MODEL[tier].modelID === current.id && TIER_MODEL[tier].providerID === current.provider.id,
  )
}

// Уровень ответа по умолчанию — настраивается в Settings (карточка «Уровень
// ответа»), применяется как стартовый тир при запуске КАЖДОГО сценария.
// Раньше тир при старте зависел от preferredModel конкретного сценария —
// юзеру было непонятно, почему один сценарий стартует на разном уровне ответа.
// Теперь источник один и явный; поменять уровень
// для конкретного диалога по-прежнему можно в чате (ScenarioTierSelector).
const DEFAULT_TIER_KEY = "ourapp.scenario.defaultTier"
const FALLBACK_TIER: ModelTier = "hi"

export function getDefaultTier(): ModelTier {
  if (typeof localStorage === "undefined") return FALLBACK_TIER
  const stored = localStorage.getItem(DEFAULT_TIER_KEY)
  if (stored === "medium" || stored === "hi" || stored === "ultra") return stored
  return FALLBACK_TIER
}

export function setDefaultTier(tier: ModelTier): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(DEFAULT_TIER_KEY, tier)
}

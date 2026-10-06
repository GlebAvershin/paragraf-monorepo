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
// в самом диалоге, но набор намеренно ограничен двумя реально разными моделями.
export const TIER_MODEL: Record<ModelTier, TierModelKey> = {
  medium: { providerID: "ourapp-ru", modelID: "yandexgpt-lite" },
  hi: { providerID: "ourapp-ru", modelID: "yandexgpt-pro" },
  // Сохраняем ключ для обратной совместимости старых сценариев и сохранённых настроек.
  ultra: { providerID: "ourapp-ru", modelID: "yandexgpt-pro" },
}

export const TIER_LABEL: Record<ModelTier, string> = {
  medium: "Базовый",
  hi: "Профессиональный",
  ultra: "Максимальный",
}

/** Короткое описание уровня — показывается рядом с названием в выпадашке. */
export const TIER_DESC: Record<ModelTier, string> = {
  medium: "Быстрые ответы и повседневные задачи",
  hi: "Анализ документов и сложные юридические задачи",
  ultra: "Совместимость с ранее сохранёнными сценариями",
}

export const TIER_ORDER: ModelTier[] = ["hi", "medium"]

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
  if (stored === "medium" || stored === "hi") return stored
  return FALLBACK_TIER
}

export function setDefaultTier(tier: ModelTier): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(DEFAULT_TIER_KEY, tier)
}

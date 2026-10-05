/**
 * OurApp — три «тира» моделей для сценарных сессий (видео-ревью 2026-07-06).
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

// Сценарии по умолчанию выполняются в российском контуре. Пользователь по-прежнему
// может выбрать другой уровень ответа в самом диалоге.
export const TIER_MODEL: Record<ModelTier, TierModelKey> = {
  medium: { providerID: "ourapp-ru", modelID: "gigachat-lite" },
  hi: { providerID: "ourapp-ru", modelID: "gigachat-pro" },
  ultra: { providerID: "ourapp-ru", modelID: "gigachat-max" },
}

export const TIER_LABEL: Record<ModelTier, string> = {
  medium: "Medium",
  hi: "High",
  ultra: "Ultra",
}

/** Короткое описание уровня — показывается рядом с названием в выпадашке. */
export const TIER_DESC: Record<ModelTier, string> = {
  medium: "Быстрые и дешёвые, для коротких и простых задач",
  hi: "Идеальный выбор для большинства задач",
  ultra: "Для комплексных задач и сложного анализа",
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
// юзеру было непонятно, почему один сценарий стартует на Ultra, а другой на
// Medium (фидбек 2026-07-09). Теперь источник один и явный; поменять уровень
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

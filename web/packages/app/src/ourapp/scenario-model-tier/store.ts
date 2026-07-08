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

export const TIER_MODEL: Record<ModelTier, TierModelKey> = {
  medium: { providerID: "openrouter", modelID: "z-ai/glm-5.2" },
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

/** Дефолтный тир под preferredModel сценария — используется при старте сценарной сессии. */
export function tierForPreferredModel(preferred: ModelTier | undefined): ModelTier {
  return preferred ?? "hi"
}

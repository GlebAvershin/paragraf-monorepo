/**
 * OurApp — три «тира» моделей для сценарных сессий (видео-ревью 2026-07-06).
 *
 * В сценариях (в отличие от прямого флоу) юзер не видит имена моделей —
 * только силу: Medium / Hi / Ultra. Под капотом это конкретные модели,
 * скрытые от юзера ровно как попросил коллега («чтобы они не знали, что
 * это за модельки»).
 */
import type { RecommendedModel } from "../scenarios/types"

export type ModelTier = "medium" | "hi" | "ultra"

export interface TierModelKey {
  providerID: string
  modelID: string
}

export const TIER_MODEL: Record<ModelTier, TierModelKey> = {
  medium: { providerID: "openrouter", modelID: "z-ai/glm-5.2" },
  hi: { providerID: "anthropic", modelID: "claude-sonnet" },
  ultra: { providerID: "anthropic", modelID: "claude-opus" },
}

export const TIER_LABEL: Record<ModelTier, string> = {
  medium: "Medium",
  hi: "Hi",
  ultra: "Ultra",
}

export const TIER_ORDER: ModelTier[] = ["medium", "hi", "ultra"]

/** Какой тир соответствует уже выбранной модели (для подсветки текущего выбора). */
export function tierForModel(current: { id: string; provider: { id: string } } | undefined): ModelTier | undefined {
  if (!current) return undefined
  return TIER_ORDER.find(
    (tier) => TIER_MODEL[tier].modelID === current.id && TIER_MODEL[tier].providerID === current.provider.id,
  )
}

/** Дефолтный тир под preferredModel сценария — используется при старте сценарной сессии. */
export function tierForPreferredModel(preferred: RecommendedModel | undefined): ModelTier {
  if (preferred === "claude-opus") return "ultra"
  if (preferred === "gigachat-pro" || preferred === "gigachat-max") return "medium"
  return "hi"
}

/**
 * Каталог провайдеров/моделей для веб-пикера.
 *
 * На desktop модели приходят из глобального opencode.jsonc (провайдер `ourapp-ru`)
 * + каталога models.dev (Anthropic). На вебе источник — движок: рендерер дёргает
 * `GET /provider` (sdk.provider.list → normalizeProviderList) и ждёт форму
 * `{all: Provider[], default: Record<provider, model>, connected: string[]}`
 * (types.gen.ts ProviderListResponse).
 *
 * modelID здесь = алиас модели в шлюзе (litellm-config.yaml `model_name`): движок
 * в chat.ts шлёт его как `model` в /v1/chat/completions. Имена/тиры синхронны с
 * billing/seed.ts (ставки) и auto-model TIER_MODEL. Провайдер влияет на PII-режим
 * косвенно (маскирование в рендерере завязано на modelID `/^claude-/`), поэтому
 * РФ-модели держим под `ourapp-ru`, Claude — под `anthropic`.
 */

type Capabilities = {
  temperature: boolean
  reasoning: boolean
  attachment: boolean
  toolcall: boolean
  input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
  output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
  interleaved: boolean
}

type Model = {
  id: string
  providerID: string
  api: { id: string; url: string; npm: string }
  name: string
  capabilities: Capabilities
  cost: { input: number; output: number; cache: { read: number; write: number } }
  limit: { context: number; output: number }
  status: "active"
  options: Record<string, unknown>
  headers: Record<string, string>
  release_date: string
}

type Provider = {
  id: string
  name: string
  source: "config"
  env: string[]
  options: Record<string, unknown>
  models: Record<string, Model>
}

type ProviderListResponse = {
  all: Provider[]
  default: Record<string, string>
  connected: string[]
}

function caps(input: Partial<Capabilities>): Capabilities {
  return {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
    ...input,
  }
}

function model(input: {
  id: string
  providerID: string
  name: string
  reasoning?: boolean
  attachment?: boolean
  context?: number
  output?: number
  costIn?: number
  costOut?: number
  release?: string
}): Model {
  return {
    id: input.id,
    providerID: input.providerID,
    api: { id: input.providerID, url: "", npm: "" },
    name: input.name,
    capabilities: caps({
      reasoning: input.reasoning ?? false,
      attachment: input.attachment ?? true,
      input: { text: true, audio: false, image: input.attachment ?? true, video: false, pdf: true },
    }),
    cost: { input: input.costIn ?? 0, output: input.costOut ?? 0, cache: { read: 0, write: 0 } },
    limit: { context: input.context ?? 128_000, output: input.output ?? 8_192 },
    status: "active",
    options: {},
    headers: {},
    // Пустой release_date НАМЕРЕННО: рендерер (context/models.tsx `visible()`) по умолчанию
    // прячет модели с валидной датой, не попавшие в «latest»-набор (а тот строится через
    // groupBy(family), которого у нас нет → набор пуст → спрятались бы ВСЕ). Наш пул
    // курируемый (5 моделей) — показываем все всегда: невалидная дата → visible()=true.
    release_date: "",
  }
}

// Пул моделей. modelID = алиас шлюза. Подписи — Sonnet 4.6 / Opus 4.8 / Haiku 4.5.
const anthropicModels: Model[] = [
  model({ id: "claude-opus", providerID: "anthropic", name: "Claude Opus 4.8", reasoning: true, context: 200_000, output: 32_000, costIn: 5, costOut: 25, release: "2026-06-13" }),
  model({ id: "claude-sonnet", providerID: "anthropic", name: "Claude Sonnet 4.6", reasoning: true, context: 200_000, output: 16_000, costIn: 3, costOut: 15, release: "2026-03-01" }),
  model({ id: "claude-haiku", providerID: "anthropic", name: "Claude Haiku 4.5", reasoning: false, context: 200_000, output: 8_192, costIn: 1, costOut: 5, release: "2025-10-01" }),
]

const ruModels: Model[] = [
  model({ id: "gigachat-pro", providerID: "ourapp-ru", name: "GigaChat Pro", reasoning: false, attachment: false, context: 32_000, output: 4_096 }),
  model({ id: "gigachat-lite", providerID: "ourapp-ru", name: "GigaChat Lite", reasoning: false, attachment: false, context: 32_000, output: 4_096 }),
]

function byId(models: Model[]): Record<string, Model> {
  return Object.fromEntries(models.map((m) => [m.id, m]))
}

export function providerList(): ProviderListResponse {
  const anthropic: Provider = {
    id: "anthropic",
    name: "Anthropic",
    source: "config",
    env: [],
    options: {},
    models: byId(anthropicModels),
  }
  const ru: Provider = {
    id: "ourapp-ru",
    name: "Российские модели",
    source: "config",
    env: [],
    options: {},
    models: byId(ruModels),
  }
  return {
    all: [anthropic, ru],
    default: { anthropic: "claude-sonnet", "ourapp-ru": "gigachat-lite" },
    connected: ["anthropic", "ourapp-ru"],
  }
}

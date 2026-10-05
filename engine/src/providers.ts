/**
 * Каталог провайдеров/моделей для веб-пикера.
 *
 * На вебе источник — движок: рендерер дёргает `GET /provider` (sdk.provider.list →
 * normalizeProviderList) и ждёт форму `{all: Provider[], default: Record<provider,
 * model>, connected: string[]}` (types.gen.ts ProviderListResponse).
 *
 * modelID здесь = алиас модели в шлюзе (litellm-config.yaml `model_name`): движок
 * в chat.ts шлёт его как `model` в /v1/chat/completions. Имена/тиры синхронны с
 * billing/seed.ts (ставки) и auto-model TIER_MODEL.
 *
 * Провайдер `ourapp-ru` объединяет российские модели GigaChat и YandexGPT.
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
  toolcall?: boolean
}): Model {
  return {
    id: input.id,
    providerID: input.providerID,
    api: { id: input.providerID, url: "", npm: "" },
    name: input.name,
    capabilities: caps({
      reasoning: input.reasoning ?? false,
      toolcall: input.toolcall ?? true,
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

// Пул моделей. modelID = алиас шлюза.
// release: "" → невалидная дата → модель ВСЕГДА видна в пикере (context/models.tsx visible():
// модели с валидной датой старше 6 мес. скрываются по умолчанию; наши продуктовые модели
// должны показываться независимо от «свежести»).
// Российский контур: GigaChat и YandexGPT вызываются напрямую из шлюза. Для этих
// моделей gateway не отправляет запросы за пределы российских провайдеров.
const russianModels: Model[] = [
  model({ id: "gigachat-lite", providerID: "ourapp-ru", name: "GigaChat Lite", attachment: false, toolcall: false, context: 32_000, output: 4_096, costIn: 0.2, costOut: 0.4, release: "" }),
  model({ id: "gigachat-pro", providerID: "ourapp-ru", name: "GigaChat Pro", attachment: false, toolcall: false, context: 32_000, output: 4_096, costIn: 1.5, costOut: 1.5, release: "" }),
  model({ id: "gigachat-max", providerID: "ourapp-ru", name: "GigaChat Max", attachment: false, toolcall: false, context: 32_000, output: 4_096, costIn: 1.95, costOut: 1.95, release: "" }),
  model({ id: "yandexgpt-lite", providerID: "ourapp-ru", name: "YandexGPT Lite", attachment: false, toolcall: false, context: 32_000, output: 8_192, release: "" }),
  model({ id: "yandexgpt-pro", providerID: "ourapp-ru", name: "YandexGPT Pro", attachment: false, toolcall: false, context: 32_000, output: 8_192, release: "" }),
]

// Международные модели остаются доступными как отдельный явно обозначенный контур.
const openrouterModels: Model[] = [
  model({ id: "z-ai/glm-5.2", providerID: "openrouter", name: "GLM 5.2 (Zhipu)", reasoning: true, attachment: false, context: 200_000, output: 8_192, costIn: 0.6, costOut: 2.2, release: "" }),
  model({ id: "minimax/minimax-m3", providerID: "openrouter", name: "MiniMax M3", reasoning: false, attachment: false, context: 256_000, output: 16_384, costIn: 0.6, costOut: 2.4, release: "" }),
  model({ id: "deepseek/deepseek-chat", providerID: "openrouter", name: "DeepSeek Chat", reasoning: false, attachment: false, context: 64_000, output: 8_192, costIn: 0.3, costOut: 1.2, release: "" }),
  model({ id: "deepseek/deepseek-v4-flash", providerID: "openrouter", name: "DeepSeek V4 Flash", reasoning: false, attachment: false, context: 128_000, output: 16_384, costIn: 0.13, costOut: 0.28, release: "" }),
]

function byId(models: Model[]): Record<string, Model> {
  return Object.fromEntries(models.map((m) => [m.id, m]))
}

export function providerList(): ProviderListResponse {
  const russian: Provider = {
    id: "ourapp-ru",
    name: "Российские модели",
    source: "config",
    env: [],
    options: {},
    models: byId(russianModels),
  }
  const openrouter: Provider = {
    id: "openrouter",
    name: "Другие модели",
    source: "config",
    env: [],
    options: {},
    models: byId(openrouterModels),
  }
  return {
    all: [russian, openrouter],
    default: { "ourapp-ru": "gigachat-pro", openrouter: "deepseek/deepseek-v4-flash" },
    connected: ["ourapp-ru", "openrouter"],
  }
}

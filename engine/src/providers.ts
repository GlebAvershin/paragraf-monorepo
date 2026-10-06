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
 * В каталоге для пользователей Isaac доступны только модели YandexGPT. Остальные
 * интеграции сохраняются в кодовой базе для будущих продуктовых решений, но не
 * выдаются через этот API и поэтому не попадают в интерфейс.
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
// Полный внутренний каталог сохраняется для будущих интеграций. Публичный список
// ниже отбирает из него только разрешённые для текущего юридического контура модели.
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

/** Сохранённый внутренний каталог для будущего включения провайдеров. */
export const retainedModelCatalog = {
  russian: russianModels,
  openrouter: openrouterModels,
}

/** Модели, которые Isaac показывает и принимает в текущем пользовательском контуре. */
const selectableYandexModels = retainedModelCatalog.russian.filter(
  (entry) => entry.id === "yandexgpt-lite" || entry.id === "yandexgpt-pro",
)

export const DEFAULT_USER_MODEL = { providerID: "ourapp-ru", modelID: "yandexgpt-pro" } as const

/**
 * Приводит сохранённый или присланный клиентом выбор к разрешённому набору.
 * Это защищает старые вкладки, где до перехода мог сохраниться GigaChat или
 * зарубежная модель: запрос будет выполнен на YandexGPT Pro.
 */
export function userSelectableModel(model: unknown): { providerID: string; modelID: string } {
  if (
    typeof model === "object" &&
    model !== null &&
    "providerID" in model &&
    "modelID" in model &&
    (model as { providerID?: unknown }).providerID === "ourapp-ru" &&
    typeof (model as { modelID?: unknown }).modelID === "string" &&
    selectableYandexModels.some((entry) => entry.id === (model as { modelID: string }).modelID)
  ) {
    return model as { providerID: string; modelID: string }
  }
  return DEFAULT_USER_MODEL
}

function byId(models: Model[]): Record<string, Model> {
  return Object.fromEntries(models.map((m) => [m.id, m]))
}

export function providerList(): ProviderListResponse {
  const yandex: Provider = {
    id: "ourapp-ru",
    name: "YandexGPT",
    source: "config",
    env: [],
    options: {},
    models: byId(selectableYandexModels),
  }
  return {
    all: [yandex],
    default: { "ourapp-ru": DEFAULT_USER_MODEL.modelID },
    connected: ["ourapp-ru"],
  }
}

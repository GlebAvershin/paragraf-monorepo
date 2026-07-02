/**
 * Seed initial tariff plans + model rates.
 * Run once after `db:push` / `db:migrate`.
 * Usage: bun run src/db/seed.ts
 *
 * Идемпотентен (onConflictDoUpdate) — можно запускать повторно.
 *
 * Гипотезы (откалибровать после пилота):
 *  - Множители: Lite 1.00× / Mid 1.50× / Top 2.20×
 *  - 1 кредит = ~1500 in + 500 out токенов на Lite (anchor)
 *  - Free trial: 30 кредитов (на 2-3 задачи)
 *  - Старт: 500 кредитов / 990 ₽ ≈ 2.0 ₽/кредит
 *  - Профи: 1700 кредитов / 2 900 ₽ ≈ 1.7 ₽/кредит (объёмная скидка)
 *  - Команда: 7000 кредитов / 9 900 ₽ ≈ 1.4 ₽/кредит
 */
import { db, schema } from "./client.ts"

const seedPlans: (typeof schema.plans.$inferInsert)[] = [
  {
    code: "free",
    titleRu: "Триал",
    description: "Бесплатный пробный период — попробовать без оплаты",
    priceRubKopeck: 0,
    monthlyBudgetUsdCenti: 200, // $2 — verifies LiteLLM hardcap
    monthlyCredits: 30, // ≈ 2-3 задачи на Sonnet 1.5×
    monthlyTasksTarget: 3, // deprecated, оставлено для совместимости
    allowedModels: ["claude-sonnet", "claude-haiku", "gigachat-pro", "gigachat-lite", "yandexgpt-pro", "yandexgpt-lite", "z-ai/glm-5.2", "deepseek/deepseek-chat"],
    features: { trial: true, trialDays: 14 },
  },
  {
    code: "start",
    titleRu: "Старт",
    description: "Для частнопрактикующего юриста или бухгалтера",
    priceRubKopeck: 99000, // 990 RUB
    monthlyBudgetUsdCenti: 800, // $8 hardcap
    monthlyCredits: 500,
    monthlyTasksTarget: 60, // deprecated
    allowedModels: ["claude-sonnet", "claude-haiku", "gigachat-pro", "gigachat-max", "yandexgpt-pro", "yandexgpt-lite"],
  },
  {
    code: "pro",
    titleRu: "Профи",
    description: "Все топ-модели для активного использования",
    priceRubKopeck: 290000, // 2 900 RUB
    monthlyBudgetUsdCenti: 2500, // $25 hardcap
    monthlyCredits: 1700,
    monthlyTasksTarget: 200, // deprecated
    allowedModels: [
      "claude-sonnet",
      "claude-opus",
      "claude-haiku",
      "gpt-4o",
      "gpt-4o-mini",
      "gigachat-pro",
      "gigachat-max",
      "yandexgpt-pro",
      "yandexgpt-lite",
    ],
  },
  {
    code: "team",
    titleRu: "Команда",
    description: "Для юрфирм и бухгалтерских контор, несколько мест",
    priceRubKopeck: 990000, // 9 900 RUB
    monthlyBudgetUsdCenti: 9000, // $90 hardcap
    monthlyCredits: 7000,
    monthlyTasksTarget: 800, // deprecated
    allowedModels: [
      "claude-sonnet",
      "claude-opus",
      "claude-haiku",
      "gpt-4o",
      "gpt-4o-mini",
      "gigachat-pro",
      "gigachat-max",
      "gigachat-lite",
      "yandexgpt-pro",
      "yandexgpt-lite",
    ],
    features: { teamSeats: 5 },
  },
]

// Множители и провайдерские цены — стартовые гипотезы.
// Real-prices в micro-cents/1K tokens (Anthropic public: 2026-05).
// Цены: Sonnet 4.5 in=$3/1M out=$15/1M, Opus 4.7 in=$15/1M out=$75/1M,
//        GPT-4o in=$2.5/1M out=$10/1M, GPT-4o-mini in=$0.15/1M out=$0.6/1M,
//        GigaChat: внутренние цены Сбера, средние оценки.
const seedRates: (typeof schema.modelRates.$inferInsert)[] = [
  // ===== Lite =====
  {
    modelCode: "gigachat-lite",
    provider: "gigachat",
    tier: "lite",
    multiplier: "1.00",
    displayNameRu: "GigaChat Lite",
    providerPricePer1kInputUsdMicroCenti: 20, // ~$0.0002/1K
    providerPricePer1kOutputUsdMicroCenti: 60,
  },
  {
    modelCode: "gpt-4o-mini",
    provider: "openai",
    tier: "lite",
    multiplier: "1.00",
    displayNameRu: "GPT-4o mini",
    providerPricePer1kInputUsdMicroCenti: 150, // $0.0015/1K → 150 micro-cents
    providerPricePer1kOutputUsdMicroCenti: 600,
  },
  {
    modelCode: "claude-haiku",
    provider: "anthropic",
    tier: "lite",
    multiplier: "1.00",
    displayNameRu: "Claude Haiku 4.5",
    providerPricePer1kInputUsdMicroCenti: 1000,
    providerPricePer1kOutputUsdMicroCenti: 5000,
  },
  // ===== Mid =====
  {
    modelCode: "gigachat-pro",
    provider: "gigachat",
    tier: "mid",
    multiplier: "1.50",
    displayNameRu: "GigaChat Pro",
    providerPricePer1kInputUsdMicroCenti: 200,
    providerPricePer1kOutputUsdMicroCenti: 600,
  },
  {
    modelCode: "claude-sonnet",
    provider: "anthropic",
    tier: "mid",
    multiplier: "1.50",
    displayNameRu: "Claude Sonnet 4.6",
    providerPricePer1kInputUsdMicroCenti: 3000, // $3/1M → 3000 micro-cents/1K
    providerPricePer1kOutputUsdMicroCenti: 15000,
  },
  {
    modelCode: "gpt-4o",
    provider: "openai",
    tier: "mid",
    multiplier: "1.50",
    displayNameRu: "GPT-4o",
    providerPricePer1kInputUsdMicroCenti: 2500,
    providerPricePer1kOutputUsdMicroCenti: 10000,
  },
  // ===== Top =====
  {
    modelCode: "gigachat-max",
    provider: "gigachat",
    tier: "top",
    multiplier: "2.20",
    displayNameRu: "GigaChat Max",
    providerPricePer1kInputUsdMicroCenti: 1000,
    providerPricePer1kOutputUsdMicroCenti: 3000,
  },
  {
    modelCode: "claude-opus",
    provider: "anthropic",
    tier: "top",
    multiplier: "2.20",
    displayNameRu: "Claude Opus 4.8",
    providerPricePer1kInputUsdMicroCenti: 15000, // $15/1M
    providerPricePer1kOutputUsdMicroCenti: 75000,
  },
  // ===== Yandex (РФ) =====
  // ВАЖНО: modelCode = имя model_name из gateway/litellm-config.yaml (yandexgpt-pro /
  // yandexgpt-lite). ETL ищет ставку по model_group=этому имени; рассинхрон →
  // дефолтное списание 1 кредит вместо корректного по множителю.
  {
    modelCode: "yandexgpt-pro",
    provider: "yandex",
    tier: "mid",
    multiplier: "1.50",
    displayNameRu: "YandexGPT Pro",
    providerPricePer1kInputUsdMicroCenti: 200,
    providerPricePer1kOutputUsdMicroCenti: 600,
  },
  {
    modelCode: "yandexgpt-lite",
    provider: "yandex",
    tier: "lite",
    multiplier: "1.00",
    displayNameRu: "YandexGPT Lite",
    providerPricePer1kInputUsdMicroCenti: 20,
    providerPricePer1kOutputUsdMicroCenti: 60,
  },
  // ===== OpenRouter (дешёвые, через шлюз) — цены проверь на openrouter.ai/models =====
  {
    modelCode: "z-ai/glm-5.2",
    provider: "openrouter",
    tier: "lite",
    multiplier: "1.00",
    displayNameRu: "GLM 5.2 (Zhipu)",
    providerPricePer1kInputUsdMicroCenti: 600,
    providerPricePer1kOutputUsdMicroCenti: 2200,
  },
  {
    modelCode: "deepseek/deepseek-chat",
    provider: "openrouter",
    tier: "lite",
    multiplier: "1.00",
    displayNameRu: "DeepSeek Chat",
    providerPricePer1kInputUsdMicroCenti: 300,
    providerPricePer1kOutputUsdMicroCenti: 1200,
  },
]

async function seed() {
  console.log("Seeding plans...")
  for (const plan of seedPlans) {
    await db
      .insert(schema.plans)
      .values(plan)
      .onConflictDoUpdate({
        target: schema.plans.code,
        set: {
          titleRu: plan.titleRu,
          description: plan.description,
          priceRubKopeck: plan.priceRubKopeck,
          monthlyBudgetUsdCenti: plan.monthlyBudgetUsdCenti,
          monthlyCredits: plan.monthlyCredits,
          monthlyTasksTarget: plan.monthlyTasksTarget,
          allowedModels: plan.allowedModels,
          features: plan.features ?? {},
        },
      })
    console.log(`  ✓ ${plan.code} — ${plan.titleRu} (${plan.monthlyCredits} кредитов / ${(plan.priceRubKopeck ?? 0) / 100} ₽)`)
  }

  console.log("Seeding model rates...")
  for (const rate of seedRates) {
    await db
      .insert(schema.modelRates)
      .values(rate)
      .onConflictDoUpdate({
        target: schema.modelRates.modelCode,
        set: {
          provider: rate.provider,
          tier: rate.tier,
          multiplier: rate.multiplier,
          displayNameRu: rate.displayNameRu,
          providerPricePer1kInputUsdMicroCenti: rate.providerPricePer1kInputUsdMicroCenti,
          providerPricePer1kOutputUsdMicroCenti: rate.providerPricePer1kOutputUsdMicroCenti,
          updatedAt: new Date(),
        },
      })
    console.log(`  ✓ ${rate.modelCode} — ${rate.displayNameRu} · ${rate.tier} · ${rate.multiplier}×`)
  }

  console.log("Done.")
  process.exit(0)
}

seed().catch((err) => {
  console.error("Seed failed:", err)
  process.exit(1)
})

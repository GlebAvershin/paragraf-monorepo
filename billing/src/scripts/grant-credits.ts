/**
 * Разовая ручная выдача кредитов (тест/демо-аккаунты, саппорт-компенсация).
 *
 * Использование (из каталога billing/, с поднятым LiteLLM-шлюзом):
 *   bun run grant-credits <email> <credits>
 *
 * Пишет credit_grants (reason=support_compensation, БЕЗ expiresAt — не сгорает),
 * поднимает LiteLLM hardcap на эквивалент (см. lib/grants.ts, как при topup).
 * /limits кэширует баланс на 60с в памяти работающего billing-процесса — эта
 * команда запускается отдельным процессом, так что сайдбар обновится сам в
 * течение минуты (без рестарта контейнера).
 */
import { desc, eq } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { bumpLiteLLMBudgetForCredits, currentRemainingCredits } from "../lib/grants.ts"

async function main() {
  const email = process.argv[2]?.trim().toLowerCase()
  const creditsArg = process.argv[3]?.trim()
  const credits = creditsArg ? Number(creditsArg) : NaN

  if (!email || !Number.isInteger(credits) || credits <= 0) {
    console.error("Usage: bun run grant-credits <email> <credits>")
    process.exit(1)
  }

  const users = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
  const user = users[0]
  if (!user) {
    console.error(`Пользователь не найден: ${email}`)
    process.exit(1)
  }

  const subs = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, user.id))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1)
  const sub = subs[0]
  if (!sub) {
    console.error(`У пользователя нет подписки: ${email}`)
    process.exit(1)
  }

  const plans = await db.select().from(schema.plans).where(eq(schema.plans.code, sub.planCode)).limit(1)
  const plan = plans[0]
  if (!plan) {
    console.error(`План не найден: ${sub.planCode}`)
    process.exit(1)
  }

  await db.insert(schema.creditGrants).values({
    subscriptionId: sub.id,
    amountCredits: credits,
    remainingCredits: credits,
    reason: "support_compensation",
    expiresAt: null,
  })

  await bumpLiteLLMBudgetForCredits(sub.litellmKey, plan, credits)

  const newBalance = await currentRemainingCredits(sub.id)
  console.log(`Выдано ${credits} кредитов: ${email} (план ${plan.code}).`)
  console.log(`Новый баланс: ${newBalance}.`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

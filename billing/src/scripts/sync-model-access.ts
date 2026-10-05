/**
 * Synchronize LiteLLM virtual-key model access with the current plan catalog.
 *
 * Existing keys retain the allow-list that was in effect when they were
 * created. Run this after changing plans.allowed_models so active users can
 * use the new model pool without recreating their accounts.
 */
import { and, eq, gt, inArray, isNotNull } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { LiteLLMError, litellm } from "../litellm/client.ts"

const enabledStatuses = ["trial", "active", "past_due"] as const

async function main() {
  const [plans, subscriptions] = await Promise.all([
    db.select().from(schema.plans),
    db
      .select({
        id: schema.subscriptions.id,
        userId: schema.subscriptions.userId,
        planCode: schema.subscriptions.planCode,
        litellmKey: schema.subscriptions.litellmKey,
        currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
      })
      .from(schema.subscriptions)
      .where(
        and(
          inArray(schema.subscriptions.status, enabledStatuses),
          isNotNull(schema.subscriptions.litellmKey),
          gt(schema.subscriptions.currentPeriodEnd, new Date()),
        ),
      ),
  ])
  const plansByCode = new Map(plans.map((plan) => [plan.code, plan]))
  let updated = 0
  let reissued = 0
  let skipped = 0
  let failed = 0

  for (const subscription of subscriptions) {
    const plan = plansByCode.get(subscription.planCode)
    if (!plan || !subscription.litellmKey) {
      skipped++
      continue
    }

    try {
      await litellm.updateKey(subscription.litellmKey, { models: plan.allowedModels })
      updated++
    } catch (error) {
      if (error instanceof LiteLLMError && error.status === 404) {
        try {
          const remainingDays = Math.max(
            1,
            Math.ceil((subscription.currentPeriodEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
          )
          const replacement = await litellm.createKey({
            userId: subscription.userId,
            maxBudgetUsd: plan.monthlyBudgetUsdCenti / 100,
            models: plan.allowedModels,
            durationDays: remainingDays,
          })
          await db
            .update(schema.subscriptions)
            .set({ litellmKey: replacement.key, updatedAt: new Date() })
            .where(eq(schema.subscriptions.id, subscription.id))
          reissued++
          continue
        } catch (reissueError) {
          failed++
          console.error(`Model access reissue failed: ${reissueError instanceof Error ? reissueError.message : String(reissueError)}`)
          continue
        }
      }
      failed++
      console.error(`Model access sync failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.log(`Model access synchronized: ${updated} updated, ${reissued} reissued, ${skipped} skipped, ${failed} failed.`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

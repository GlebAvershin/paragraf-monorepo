/**
 * Кабинет менеджера — перевод кредитов сотруднику и выборки по команде.
 *
 * Модель (решение продукта 2026-09-11): менеджер НЕ покупает кредиты напрямую
 * на сотрудника. Он пополняет свой баланс обычной докупкой (/payments/topup),
 * а потом раскидывает кредиты по команде переводом. Один кошелёк-источник —
 * меньше платёжных путей и краевых случаев, вся закупка видна в одной истории.
 *
 * Перевод НЕ пишет usage_event (в отличие от chargeCredits): это перемещение
 * средств, а не расход на модель — иначе аналитика расхода была бы завышена
 * на сумму всех переводов.
 */
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm"
import { db, schema } from "../db/client.ts"

export class InsufficientCreditsError extends Error {
  constructor(
    readonly available: number,
    readonly requested: number,
  ) {
    super(`insufficient_credits: available=${available} requested=${requested}`)
    this.name = "InsufficientCreditsError"
  }
}

export interface TransferInput {
  fromSubscriptionId: string
  toSubscriptionId: string
  credits: number
  /** Кто инициировал — для audit_log. */
  actorUserId: string
  /** Кому переводим — для audit_log. */
  targetUserId: string
}

/**
 * Перевести кредиты с подписки менеджера на подписку сотрудника.
 *
 * Всё-или-ничего: если у менеджера не хватает — бросаем InsufficientCreditsError
 * и не трогаем ни один грант (транзакция откатывается).
 *
 * Источник списывается FIFO по expiresAt (как chargeCredits) — сначала то, что
 * скоро сгорит. Получателю грант кладётся БЕЗ срока (expiresAt=null): менеджер
 * уже «оплатил» эти кредиты, привязывать их к чужому периоду подписки нечестно
 * — та же логика, что у support_compensation в grant-credits.ts.
 */
export async function transferCredits(input: TransferInput): Promise<{ transferred: number }> {
  if (!Number.isInteger(input.credits) || input.credits <= 0) {
    throw new Error(`transferCredits: invalid credits=${input.credits}`)
  }
  if (input.fromSubscriptionId === input.toSubscriptionId) {
    throw new Error("transferCredits: from === to")
  }

  return await db.transaction(async (tx) => {
    // Блокируем обе подписки в стабильном порядке (по id) — иначе два встречных
    // перевода могут взять локи крест-накрест и словить deadlock.
    const [lockA, lockB] = [input.fromSubscriptionId, input.toSubscriptionId].sort()
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockA})::bigint)`)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockB})::bigint)`)

    const now = new Date()
    const grants = await tx
      .select()
      .from(schema.creditGrants)
      .where(
        and(
          eq(schema.creditGrants.subscriptionId, input.fromSubscriptionId),
          isNull(schema.creditGrants.consumedAt),
          or(isNull(schema.creditGrants.expiresAt), gt(schema.creditGrants.expiresAt, now)),
          gt(schema.creditGrants.remainingCredits, 0),
        ),
      )
      .orderBy(asc(schema.creditGrants.expiresAt), asc(schema.creditGrants.createdAt))

    const available = grants.reduce((sum, g) => sum + g.remainingCredits, 0)
    if (available < input.credits) {
      throw new InsufficientCreditsError(available, input.credits)
    }

    let remaining = input.credits
    for (const grant of grants) {
      if (remaining <= 0) break
      const takeFrom = Math.min(remaining, grant.remainingCredits)
      const newRemaining = grant.remainingCredits - takeFrom
      await tx
        .update(schema.creditGrants)
        .set({ remainingCredits: newRemaining, consumedAt: newRemaining === 0 ? now : null })
        .where(eq(schema.creditGrants.id, grant.id))
      remaining -= takeFrom
    }

    await tx.insert(schema.creditGrants).values({
      subscriptionId: input.toSubscriptionId,
      amountCredits: input.credits,
      remainingCredits: input.credits,
      reason: "manager_transfer",
      expiresAt: null,
    })

    await tx.insert(schema.auditLog).values({
      actor: `user:${input.actorUserId}`,
      action: "manager.credits.transfer",
      targetType: "user",
      targetId: input.targetUserId,
      metadata: {
        credits: input.credits,
        fromSubscriptionId: input.fromSubscriptionId,
        toSubscriptionId: input.toSubscriptionId,
      },
    })

    return { transferred: input.credits }
  })
}

/** Последняя подписка пользователя (та же выборка, что в payments/me). */
export async function latestSubscription(userId: string) {
  const rows = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(1)
  return rows[0] ?? null
}

export interface TeamMember {
  userId: string
  email: string
  name: string | null
  status: string
  createdAt: Date
  lastLoginAt: Date | null
  subscriptionId: string | null
}

/** Сотрудники менеджера + id их подписок (одним запросом, без N+1). */
export async function listTeam(managerId: string): Promise<TeamMember[]> {
  const rows = await db.execute<{
    userId: string
    email: string
    name: string | null
    status: string
    createdAt: Date
    lastLoginAt: Date | null
    subscriptionId: string | null
  }>(sql`
    SELECT u.id           AS "userId",
           u.email        AS "email",
           u.name         AS "name",
           u.status::text AS "status",
           u.created_at   AS "createdAt",
           u.last_login_at AS "lastLoginAt",
           (
             SELECT s.id FROM subscriptions s
             WHERE s.user_id = u.id
             ORDER BY s.created_at DESC
             LIMIT 1
           )              AS "subscriptionId"
    FROM users u
    WHERE u.manager_id = ${managerId}
    ORDER BY u.created_at ASC
  `)
  return rows
}

/**
 * Остаток активных кредитов по списку подписок разом (id → остаток).
 *
 * Фильтр через drizzle `inArray`, а НЕ через сырой `= ANY(${ids}::uuid[])`:
 * postgres-js ломается на массиве из одного элемента (`malformed array literal`,
 * см. урок ТЗ-04/05/06 в CLAUDE.md) и сырая интерполяция — риск инъекции.
 */
export async function balancesBySubscription(subscriptionIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (subscriptionIds.length === 0) return result
  const subFilter = inArray(schema.creditGrants.subscriptionId, subscriptionIds)
  const rows = await db.execute<{ subscriptionId: string; remaining: number }>(sql`
    SELECT subscription_id AS "subscriptionId",
           COALESCE(SUM(remaining_credits), 0)::int AS remaining
    FROM credit_grants
    WHERE ${subFilter}
      AND consumed_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    GROUP BY subscription_id
  `)
  for (const row of rows) result.set(row.subscriptionId, row.remaining)
  return result
}

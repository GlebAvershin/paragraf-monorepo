/**
 * Waitlist — сбор email с лендинга (менеджеры, Фаза 4).
 *
 *   POST /waitlist  { email, interest?, source? }
 *
 * Публичный (без auth) — вызывается с маркетингового сайта. Идемпотентно по
 * email (повторная заявка не дублируется, отдаёт 200). Всегда 200/400, не
 * раскрывает существование email.
 */
import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { sql } from "drizzle-orm"
import { db, schema } from "../db/client.ts"
import { logger } from "../lib/logger.ts"

export const waitlistRoutes = new Hono()

const input = z.object({
  email: z.string().email(),
  interest: z.string().max(40).optional(),
  source: z.string().max(120).optional(),
})

waitlistRoutes.post("/", zValidator("json", input), async (c) => {
  const { email, interest, source } = c.req.valid("json")
  try {
    await db
      .insert(schema.waitlistSignups)
      .values({ email, interest: interest ?? "manager", source: source ?? null })
      // Идемпотентность: повтор email — no-op.
      .onConflictDoNothing({ target: schema.waitlistSignups.email })
    logger.info({ interest }, "waitlist signup")
    return c.json({ ok: true })
  } catch (err) {
    logger.error({ err }, "waitlist insert failed")
    return c.json({ error: "internal_error" }, 500)
  }
})

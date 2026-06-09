import { Hono } from "hono"
import { sql } from "drizzle-orm"
import { db } from "../db/client.ts"

export const healthRoutes = new Hono()

healthRoutes.get("/liveliness", (c) => c.json({ status: "ok" }))

healthRoutes.get("/readiness", async (c) => {
  try {
    await db.execute(sql`select 1`)
    return c.json({ status: "ok", db: "ok" })
  } catch (err) {
    return c.json({ status: "degraded", db: "down", error: String(err) }, 503)
  }
})

import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { requireSession, type Session } from "./auth.ts"
import { sql, jsonb } from "./db.ts"
import { getSession } from "./sessions.ts"

type Draft = { kind: "text"; html: string } | { kind: "sheet"; cells: Record<string, Record<string, string>> }

export function validDocumentDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object") return false
  const draft = value as Record<string, unknown>
  if (draft.kind === "text") return typeof draft.html === "string" && draft.html.length <= 1_000_000
  if (draft.kind !== "sheet" || !draft.cells || typeof draft.cells !== "object" || Array.isArray(draft.cells)) return false
  return Object.entries(draft.cells).length <= 100 && Object.keys(draft.cells).every((name) => !["__proto__", "constructor", "prototype"].includes(name)) && Object.values(draft.cells).every((sheet) =>
    !!sheet && typeof sheet === "object" && !Array.isArray(sheet) && Object.entries(sheet).length <= 20_000 &&
    Object.entries(sheet).every(([address, content]) => /^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address) && typeof content === "string" && content.length <= 32_767),
  )
}

export const documents = new Hono<{ Variables: { session: Session; token: string } }>()
documents.use("*", requireSession)
documents.use("/:id/document/:key", bodyLimit({ maxSize: 2 * 1024 * 1024 }))
documents.use("/:id/document/:key", async (context, next) => {
  if (context.req.param("key").length > 240) return context.json({ error: "invalid_key" }, 400)
  if (!await getSession(context.var.session.userId, context.req.param("id"))) return context.json({ error: "not_found" }, 404)
  context.header("Cache-Control", "private, no-store")
  return next()
})

documents.get("/:id/document/:key", async (context) => {
  const rows = await sql`
    SELECT revision, draft, updated FROM document_revisions
    WHERE user_id = ${context.var.session.userId} AND session_id = ${context.req.param("id")} AND document_key = ${context.req.param("key")}
    ORDER BY revision DESC LIMIT 1`
  return context.json(rows[0] ?? { revision: 0, draft: null })
})

documents.post("/:id/document/:key", async (context) => {
  const body: unknown = await context.req.json().catch(() => null)
  if (!body || typeof body !== "object") return context.json({ error: "invalid_draft" }, 400)
  const input = body as { revision?: unknown; draft?: unknown }
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || !validDocumentDraft(input.draft)) {
    return context.json({ error: "invalid_draft" }, 400)
  }
  const user = context.var.session.userId
  const session = context.req.param("id")
  const key = context.req.param("key")
  const draft = input.draft
  const result = await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`${user}:${session}:${key}`}, 0))`
    const current = await transaction`
      SELECT revision FROM document_revisions WHERE user_id = ${user} AND session_id = ${session} AND document_key = ${key}
      ORDER BY revision DESC LIMIT 1`
    const revision = Number(current[0]?.revision ?? 0)
    if (revision !== input.revision) return null
    const updated = Date.now()
    await transaction`
      INSERT INTO document_revisions (user_id, session_id, document_key, revision, draft, updated)
      VALUES (${user}, ${session}, ${key}, ${revision + 1}, ${jsonb(draft)}, ${updated})`
    return { revision: revision + 1, draft, updated }
  })
  return result ? context.json(result) : context.json({ error: "revision_conflict" }, 409)
})

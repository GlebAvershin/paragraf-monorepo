import { beforeAll, afterAll, describe, expect, test } from "bun:test"
import { SignJWT } from "jose"
import { documents, validDocumentDraft } from "../src/documents.ts"
import { config } from "../src/config.ts"
import { initSchema, sql } from "../src/db.ts"
import { createSession } from "../src/sessions.ts"

describe("document draft validation", () => {
  test("accepts structured edits and rejects malformed or oversized input", () => {
    expect(validDocumentDraft({ kind: "text", html: "<p>Договор</p>" })).toBe(true)
    expect(validDocumentDraft({ kind: "sheet", cells: { Лист: { A1: "Сумма", B2: "=B1*2" } } })).toBe(true)
    expect(validDocumentDraft({ kind: "sheet", cells: { Лист: { "<script>": "bad" } } })).toBe(false)
    expect(validDocumentDraft({ kind: "text", html: "x".repeat(1_000_001) })).toBe(false)
    expect(validDocumentDraft({ kind: "sheet", cells: [] })).toBe(false)
    expect(validDocumentDraft({ kind: "sheet", cells: JSON.parse('{"__proto__":{"A1":"bad"}}') })).toBe(false)
  })
})

describe.skipIf(process.env.DOCUMENT_DB_TESTS !== "1")("document revisions with Postgres", () => {
  let sessionID = ""
  let token = ""
  let otherToken = ""
  const user = `document-qa-${crypto.randomUUID()}`
  beforeAll(async () => {
    await initSchema()
    sessionID = (await createSession(user, { title: "Disposable document revision test" })).id
    const sign = (subject: string) => new SignJWT({ email: "qa@isaac.test" }).setSubject(subject).setIssuedAt().setExpirationTime("5m").setIssuer(config.JWT_ISSUER).setAudience(config.JWT_AUDIENCE).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(config.JWT_SECRET))
    token = await sign(user)
    otherToken = await sign(`${user}-other`)
  })
  afterAll(async () => { await sql`DELETE FROM sessions WHERE user_id = ${user} AND id = ${sessionID}` })
  const request = (method: string, auth: string, body?: object) => documents.request(`/${sessionID}/document/test`, { method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })

  test("requires authentication and denies another account access", async () => {
    expect((await request("GET", "")).status).toBe(401)
    expect((await request("GET", otherToken)).status).toBe(404)
  })
  test("saves revisions, loads the latest and rejects stale overwrites", async () => {
    expect(await (await request("GET", token)).json()).toEqual({ revision: 0, draft: null })
    expect((await request("POST", token, { revision: 0, draft: { kind: "text", html: "<p>Редакция 1</p>" } })).status).toBe(200)
    expect((await request("POST", token, { revision: 0, draft: { kind: "text", html: "<p>Устаревшая редакция</p>" } })).status).toBe(409)
    const latest = await (await request("GET", token)).json()
    expect(latest.revision).toBe(1)
    expect(latest.draft.html).toBe("<p>Редакция 1</p>")
  })
})

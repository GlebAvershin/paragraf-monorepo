/**
 * Dev script: issue a JWT for the test user so we can poke /me, /limits etc.
 * Usage: bun run scripts/issue-test-token.ts
 */
import { eq } from "drizzle-orm"
import { db, schema } from "../src/db/client.ts"
import { issueSession } from "../src/lib/auth.ts"

const EMAIL = "test@example.com"

const rows = await db.select().from(schema.users).where(eq(schema.users.email, EMAIL)).limit(1)
const user = rows[0]
if (!user) {
  console.error(`User ${EMAIL} not found`)
  process.exit(1)
}

const token = await issueSession({ sub: user.id, email: user.email })
console.log(token)
process.exit(0)

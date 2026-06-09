import { eq } from "drizzle-orm"
import { db, schema } from "../src/db/client.ts"
import { issueSession } from "../src/lib/auth.ts"
const rows = await db.select().from(schema.users).where(eq(schema.users.email, "test@yandex.ru")).limit(1)
const user = rows[0]
if (!user) { console.error("no user"); process.exit(1) }
const token = await issueSession({ sub: user.id, email: user.email })
console.log(token)
process.exit(0)

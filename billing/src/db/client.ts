import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { config } from "../config.ts"
import * as schema from "./schema.ts"

const queryClient = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
})

export const db = drizzle(queryClient, { schema })

export type DB = typeof db
export { schema }

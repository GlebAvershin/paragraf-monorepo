import type { Config } from "drizzle-kit"

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://billing:billing@localhost:5433/billing",
  },
  verbose: true,
  strict: true,
} satisfies Config

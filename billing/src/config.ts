/**
 * Centralized config with runtime validation.
 * Fail-fast on missing required secrets.
 */
import { z } from "zod"

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres://")),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  JWT_ISSUER: z.string().default("billing.ourapp.com"),
  JWT_AUDIENCE: z.string().default("ourapp-desktop"),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(15),

  LITELLM_BASE_URL: z.string().url(),
  LITELLM_MASTER_KEY: z.string().min(10),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  // Принимает и голый email ("noreply@x.ru"), и RFC5322 display-name форму
  // ("Isaac <noreply@x.ru>") — nodemailer поддерживает оба, .email() отсекал
  // второй вариант, хотя это и есть реальный intent (имя бренда в письме).
  SMTP_FROM: z
    .string()
    .refine(
      (v) => z.string().email().safeParse(v).success || /^.+<[^<>]+@[^<>]+>$/.test(v),
      "SMTP_FROM must be an email or \"Name <email>\"",
    )
    .default("noreply@ourapp.com"),

  APP_PUBLIC_URL: z.string().url().default("http://localhost:3000"),

  // --- CloudPayments (acquiring) ---
  CLOUDPAYMENTS_PUBLIC_ID: z.string().optional(),
  CLOUDPAYMENTS_API_SECRET: z.string().optional(),
  // Secret used to verify the Content-HMAC header on incoming webhooks.
  // Defaults to CLOUDPAYMENTS_API_SECRET if not provided (CloudPayments signs
  // notifications with the API secret unless a dedicated secret is configured).
  CLOUDPAYMENTS_WEBHOOK_SECRET: z.string().optional(),
  CLOUDPAYMENTS_API_URL: z.string().url().default("https://api.cloudpayments.ru"),

  // Админ-доступ для разработчиков (просмотр списка пользователей для сопоставления
  // с перепиской из engine) — отдельный секрет, НЕ пользовательский JWT. Пусто ⇒
  // /admin/* эндпоинты отключены (503). Тот же токен должен быть прописан в engine/.env.
  ADMIN_TOKEN: z.string().optional(),
})

export type Config = z.infer<typeof ConfigSchema>

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n")
    console.error(`Invalid configuration:\n${issues}`)
    process.exit(1)
  }
  return parsed.data
}

export const config: Config = loadConfig()

export const isDev = config.NODE_ENV === "development"
export const isProd = config.NODE_ENV === "production"

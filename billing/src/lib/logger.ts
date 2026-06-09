import pino from "pino"
import { config, isDev } from "../config.ts"

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l" },
    },
  }),
  base: { service: "billing" },
  redact: {
    paths: [
      "*.password",
      "*.token",
      "*.tokenHash",
      "*.litellm_key",
      "*.litellmKey",
      "*.cloudpaymentsToken",
      "*.master_key",
      "*.api_key",
      "headers.authorization",
      "req.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
})

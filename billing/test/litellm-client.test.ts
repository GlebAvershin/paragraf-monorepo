import { expect, test } from "bun:test"

Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:5433/test",
  JWT_SECRET: "test-secret-that-is-long-enough-for-validation",
  LITELLM_BASE_URL: "http://127.0.0.1:4000",
  LITELLM_MASTER_KEY: "test-master-key",
})

const { LiteLLMError } = await import("../src/litellm/client.ts")

test("LiteLLM errors redact credentials from paths and response bodies", () => {
  const virtualKey = "sk-sensitive-test-key"
  const error = new LiteLLMError(
    `LiteLLM GET /key/info?key=${virtualKey}&token=another-secret failed: 401`,
    401,
    {
      key: virtualKey,
      nested: { api_key: virtualKey },
      detail: `Bearer ${virtualKey} was rejected`,
    },
  )

  expect(error.message).not.toContain(virtualKey)
  expect(error.message).not.toContain("another-secret")
  expect(JSON.stringify(error.body)).not.toContain(virtualKey)
  expect(JSON.stringify(error.body)).toContain("[REDACTED]")
})

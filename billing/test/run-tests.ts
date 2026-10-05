const env = {
  ...process.env,
  NODE_ENV: "test",
  CLOUDPAYMENTS_PUBLIC_ID: "test_pub",
  CLOUDPAYMENTS_API_SECRET: "test_secret",
  CLOUDPAYMENTS_WEBHOOK_SECRET: "test_webhook_secret",
  CLOUDPAYMENTS_API_URL: "http://localhost:9998",
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
}

const test = Bun.spawn([process.execPath, "test", ...process.argv.slice(2)], {
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await test.exited)

/**
 * Mock CloudPayments API для локального теста платёжного флоу (ТЗ-02).
 *
 * Эмулирует ответы CloudPayments REST API, чтобы прогнать наш код
 * (/payments/method, /payments/topup) без регистрации в реальном эквайринге.
 *
 * Запуск: bun run scripts/mock-cloudpayments.ts
 * Слушает :9999. Управление поведением через cryptogram/token:
 *   - cryptogram содержит "decline" → cards/auth вернёт Success:false
 *   - token содержит "decline"      → tokens/charge вернёт Success:false
 * Иначе — успех.
 */
import { Hono } from "hono"

const app = new Hono()

let txnCounter = 1000

app.post("/payments/cards/auth", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const cryptogram = String(body.CardCryptogramPacket ?? "")

  if (cryptogram.includes("decline")) {
    return c.json({ Success: false, Message: "Карта отклонена банком (mock)", Model: null })
  }

  const txnId = txnCounter++
  return c.json({
    Success: true,
    Message: null,
    Model: {
      TransactionId: txnId,
      Token: `tok_mock_${txnId}`,
      CardLastFour: "4242",
      CardType: "Visa",
      CardExpDate: "12/30",
      Amount: body.Amount,
      Currency: body.Currency ?? "RUB",
    },
  })
})

app.post("/payments/void", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  // eslint-disable-next-line no-console
  console.log(`[mock] void TransactionId=${body.TransactionId}`)
  return c.json({ Success: true, Message: null })
})

app.post("/payments/tokens/charge", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const token = String(body.Token ?? "")

  if (token.includes("decline")) {
    return c.json({
      Success: false,
      Message: "Недостаточно средств (mock)",
      Model: { Reason: "InsufficientFunds", ReasonCode: 5051 },
    })
  }

  const txnId = txnCounter++
  // eslint-disable-next-line no-console
  console.log(`[mock] tokens/charge amount=${body.Amount} token=${token} → txn=${txnId}`)
  return c.json({
    Success: true,
    Message: null,
    Model: {
      TransactionId: txnId,
      Amount: body.Amount,
      Currency: body.Currency ?? "RUB",
    },
  })
})

const PORT = 9999
// eslint-disable-next-line no-console
console.log(`[mock-cloudpayments] listening on http://localhost:${PORT}`)

export default { port: PORT, fetch: app.fetch }

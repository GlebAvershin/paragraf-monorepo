/**
 * HMAC-подпись webhook'ов CloudPayments.
 *
 * CloudPayments подписывает тело уведомления и кладёт подпись в заголовок
 * `Content-HMAC` (иногда `X-Content-HMAC`):
 *
 *   signature = base64( HMAC-SHA256( rawBody, apiSecret ) )
 *
 * Docs: https://developers.cloudpayments.ru/#proverka-uvedomleniy
 *
 * ВАЖНО: подпись считается по СЫРОМУ телу запроса (как пришло на провод),
 * до любого парсинга/реструктуризации. Поэтому в роуте берём `await c.req.text()`
 * и передаём строку сюда, а не пересобранный объект.
 */
import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Посчитать base64(HMAC-SHA256(body, secret)).
 */
export function computeHmac(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64")
}

/**
 * Проверить подпись webhook'а в постоянное время (защита от timing-атак).
 *
 * @param rawBody  сырое тело запроса (строка)
 * @param signature значение заголовка Content-HMAC
 * @param secret   CLOUDPAYMENTS_WEBHOOK_SECRET (или API secret)
 * @returns true если подпись корректна
 */
export function verifyHmac(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false

  const expected = computeHmac(rawBody, secret)

  // timingSafeEqual требует одинаковую длину буферов — иначе сразу false.
  let expectedBuf: Buffer
  let actualBuf: Buffer
  try {
    expectedBuf = Buffer.from(expected, "base64")
    actualBuf = Buffer.from(signature, "base64")
  } catch {
    return false
  }
  if (expectedBuf.length !== actualBuf.length || expectedBuf.length === 0) {
    return false
  }
  return timingSafeEqual(expectedBuf, actualBuf)
}

// computeCredits: пол списания. Chat-модели — минимум 1 кредит (защита от бесплатного
// использования); embedding-тир (gost-rag-ретрив на ключе юзера) — по факту, floorCredits: 0,
// иначе каждый /retrieve снимал бы скрытый кредит при себестоимости ~$0.000002.
import { describe, expect, test } from "bun:test"
import { computeCredits } from "../src/lib/credits.ts"

describe("computeCredits floor", () => {
  const embedCall = {
    inputTokens: 50, // типичный запрос ретрива
    outputTokens: 0,
    pricePer1kInputMicroCenti: 40, // $0.04/1M (siliconflow, qwen3-embedding-8b)
    pricePer1kOutputMicroCenti: 0,
    multiplier: 1.0,
  }

  test("дефолтный пол 1 кредит остаётся для chat-моделей", () => {
    expect(computeCredits(embedCall)).toBe(1) // без floorCredits — как раньше
  })

  test("floorCredits: 0 — копеечный embed-вызов не списывает кредит", () => {
    expect(computeCredits({ ...embedCall, floorCredits: 0 })).toBe(0)
  })

  test("floorCredits: 0 — крупный объём всё же округляется в кредиты", () => {
    // 3k токенов эмбеддинга = 3 × 40 = 120 µ¢ провайдеру = 2 кредита при калибровке 60
    expect(computeCredits({ ...embedCall, inputTokens: 3_000, floorCredits: 0 })).toBe(2)
  })

  test("обычная chat-модель считается как раньше", () => {
    expect(
      computeCredits({
        inputTokens: 1000,
        outputTokens: 1000,
        pricePer1kInputMicroCenti: 1302,
        pricePer1kOutputMicroCenti: 4092,
        multiplier: 1.0,
      }),
    ).toBe(Math.ceil((1302 + 4092) / 60))
  })
})

// Инварианты grounding-слоя (фидбек клиента 2026-07-10: полный ответ «одним сообщением»).
// Текст промпта раньше никто не ассертил — молчаливый рефактор снёс бы «Итоговое решение»/плашку.
// config.ts fail-fast'ит на JWT_SECRET — задаём ДО импорта chat.ts.
process.env.JWT_SECRET ??= "test-secret"

import { describe, expect, test } from "bun:test"
import { groundingSystemPrompt, queryFromParts } from "../src/chat.ts"
import { extractDesignations } from "../src/gostrag.ts"

describe("groundingSystemPrompt", () => {
  const prompt = groundingSystemPrompt("[ГОСТ 1-2020 | п. 1.1]\nтекст")

  test("держит иерархию источников: база со ссылками → практика с плашкой → не найдено", () => {
    expect(prompt).toContain("[ГОСТ NNNN-ГГГГ, п. X.Y]")
    expect(prompt).toContain("не из базы — проверьте по оригиналу стандарта")
    expect(prompt).toContain("НИКОГДА не приписывай номер пункта")
  })

  test("требует полноту и «Итоговое решение», но не краткость", () => {
    expect(prompt).toContain("Итоговое решение")
    expect(prompt).toContain("Параметр | Значение | Основание")
    expect(prompt).not.toContain("кратко")
  })

  test("вставляет под-вопросы deep-ретрива, когда они есть", () => {
    const deep = groundingSystemPrompt("ctx", ["про сварку", "про кабели"])
    expect(deep).toContain("1. про сварку")
    expect(deep).toContain("2. про кабели")
    expect(prompt).not.toContain("раскладывается на под-вопросы")
  })
})

describe("queryFromParts", () => {
  test("выкидывает synthetic-части (шаблон сценария) из запроса ретрива", () => {
    const query = queryFromParts([
      { type: "text", text: "Ты — инженер-нормоконтролёр… (полный шаблон)", synthetic: true },
      { type: "text", text: "Какой тип шва для патрубка ДУ50?" },
    ])
    expect(query).toBe("Какой тип шва для патрубка ДУ50?")
  })

  test("фолбэк на synthetic, если других текст-частей нет", () => {
    expect(queryFromParts([{ type: "text", text: "только шаблон", synthetic: true }])).toBe("только шаблон")
  })

  test("не-текстовые части игнорируются", () => {
    expect(queryFromParts([{ type: "file", mime: "image/png", url: "data:..." }, { type: "text", text: "вопрос" }])).toBe(
      "вопрос",
    )
  })
})

describe("extractDesignations", () => {
  test("вытаскивает уникальные обозначения и нормализует тире", () => {
    // – = en-dash U+2013 (внутри класса тире регекспа, как в web source-viewer.tsx)
    const text = "Шов Т1 по ГОСТ 14771–76, контроль — ГОСТ 14771-76; см. также СП 70.13330.2012 и ТР ТС 012/2011."
    expect(extractDesignations(text)).toEqual(["ГОСТ 14771-76", "СП 70.13330.2012", "ТР ТС 012/2011"])
  })

  test("пустой текст — пусто", () => {
    expect(extractDesignations("без стандартов")).toEqual([])
  })
})

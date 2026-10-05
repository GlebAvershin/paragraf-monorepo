import { describe, expect, test } from "bun:test"
import { providerList } from "../src/providers.ts"

describe("providerList", () => {
  test("shows domestic GigaChat and YandexGPT models alongside other models", () => {
    const list = providerList()
    const russian = list.all.find((provider) => provider.id === "ourapp-ru")

    expect(russian?.name).toBe("Российские модели")
    expect(Object.keys(russian?.models ?? {})).toEqual([
      "gigachat-lite",
      "gigachat-pro",
      "gigachat-max",
      "yandexgpt-lite",
      "yandexgpt-pro",
    ])
    expect(list.default["ourapp-ru"]).toBe("gigachat-pro")
    expect(list.connected).toContain("ourapp-ru")
  })
})

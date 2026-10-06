import { describe, expect, test } from "bun:test"
import { DEFAULT_USER_MODEL, providerList, userSelectableModel } from "../src/providers.ts"

describe("providerList", () => {
  test("shows only YandexGPT models in the user-facing catalog", () => {
    const list = providerList()
    const yandex = list.all.find((provider) => provider.id === "ourapp-ru")

    expect(list.all).toHaveLength(1)
    expect(yandex?.name).toBe("YandexGPT")
    expect(Object.keys(yandex?.models ?? {})).toEqual([
      "yandexgpt-lite",
      "yandexgpt-pro",
      "yandexgpt-5.1-pro",
    ])
    expect(list.default).toEqual({ "ourapp-ru": "yandexgpt-pro" })
    expect(list.connected).toEqual(["ourapp-ru"])
  })

  test("maps legacy or external selections to the YandexGPT default", () => {
    expect(userSelectableModel({ providerID: "ourapp-ru", modelID: "gigachat-pro" })).toEqual(DEFAULT_USER_MODEL)
    expect(userSelectableModel({ providerID: "openrouter", modelID: "deepseek/deepseek-chat" })).toEqual(DEFAULT_USER_MODEL)
    expect(userSelectableModel({ providerID: "ourapp-ru", modelID: "yandexgpt-lite" })).toEqual({
      providerID: "ourapp-ru",
      modelID: "yandexgpt-lite",
    })
    expect(userSelectableModel({ providerID: "ourapp-ru", modelID: "yandexgpt-5.1-pro" })).toEqual({
      providerID: "ourapp-ru",
      modelID: "yandexgpt-5.1-pro",
    })
  })
})

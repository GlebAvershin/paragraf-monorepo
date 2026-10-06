import { describe, expect, test } from "bun:test"
import { TIER_MODEL } from "./store"

describe("scenario response levels", () => {
  test("use YandexGPT in the domestic contour", () => {
    expect(TIER_MODEL.medium).toEqual({ providerID: "ourapp-ru", modelID: "yandexgpt-lite" })
    expect(TIER_MODEL.hi).toEqual({ providerID: "ourapp-ru", modelID: "yandexgpt-pro" })
    expect(TIER_MODEL.ultra).toEqual({ providerID: "ourapp-ru", modelID: "yandexgpt-5.1-pro" })
  })
})

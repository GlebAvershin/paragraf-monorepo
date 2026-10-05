import { describe, expect, test } from "bun:test"
import { TIER_MODEL } from "./store"

describe("scenario response levels", () => {
  test("start in the domestic GigaChat contour", () => {
    expect(TIER_MODEL.medium).toEqual({ providerID: "ourapp-ru", modelID: "gigachat-lite" })
    expect(TIER_MODEL.hi).toEqual({ providerID: "ourapp-ru", modelID: "gigachat-pro" })
    expect(TIER_MODEL.ultra).toEqual({ providerID: "ourapp-ru", modelID: "gigachat-max" })
  })
})

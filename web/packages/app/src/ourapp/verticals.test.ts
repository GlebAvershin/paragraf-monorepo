import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  clearVertical,
  DEFAULT_VERTICAL,
  isVerticalEnabled,
  loadVertical,
  saveVertical,
  VERTICAL_ORDER,
} from "./verticals"

describe("product verticals", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  test("shows lawyer and accountant workflows", () => {
    expect(DEFAULT_VERTICAL).toBe("lawyer")
    expect(VERTICAL_ORDER).toEqual(["lawyer", "accountant"])
    expect(isVerticalEnabled("lawyer")).toBe(true)
    expect(isVerticalEnabled("accountant")).toBe(true)
    expect(isVerticalEnabled("technologist")).toBe(false)
  })

  test("migrates a saved technologist preference to the legal default", () => {
    localStorage.setItem("ourapp.primaryVertical", "technologist")
    expect(loadVertical()).toBe("lawyer")
  })

  test("clears the locally saved profession on sign out", () => {
    saveVertical("accountant")
    clearVertical()
    expect(loadVertical()).toBe(DEFAULT_VERTICAL)
  })
})

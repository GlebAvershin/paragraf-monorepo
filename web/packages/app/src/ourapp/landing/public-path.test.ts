/**
 * OurApp — предикат публичного лендинга.
 *
 * Критично для регрессии логина: `/` (страница входа) НЕ должна опознаваться
 * как лендинг, иначе шов в entry.tsx подменит приложение на маркетинг-страницу.
 * Запуск: bun test (из packages/app).
 */
import { describe, expect, test } from "bun:test"
import { isLandingPath, LANDING_PATH } from "./public-path"

describe("isLandingPath", () => {
  test("матчит канонический путь", () => {
    expect(isLandingPath(LANDING_PATH)).toBe(true)
    expect(isLandingPath("/landing")).toBe(true)
  })

  test("матчит с завершающим слэшем и в любом регистре", () => {
    expect(isLandingPath("/landing/")).toBe(true)
    expect(isLandingPath("/Landing")).toBe(true)
    expect(isLandingPath("/LANDING/")).toBe(true)
  })

  test("НЕ матчит страницу входа и корень", () => {
    expect(isLandingPath("/")).toBe(false)
    expect(isLandingPath("")).toBe(false)
  })

  test("НЕ матчит вложенные и похожие пути", () => {
    expect(isLandingPath("/landing/pricing")).toBe(false)
    expect(isLandingPath("/landings")).toBe(false)
    expect(isLandingPath("/pre-landing")).toBe(false)
    expect(isLandingPath("/session/abc")).toBe(false)
  })
})

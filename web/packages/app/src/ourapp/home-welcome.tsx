/**
 * OurApp Home — landing-page приложения.
 *
 * Отличается от NewSession (библиотека сценариев) тем, что:
 *   - НЕТ боковой панели — full-page по центру
 *   - Большой dramatic hero
 *   - Один primary CTA «Начать новую задачу»
 *   - Компактная секция «Продолжить работу» (если есть)
 *   - Лёгкая ссылка-доступ к настройкам/помощи в правом верхнем углу
 *
 * Цель: дать «дом» с одним очевидным действием. Библиотека сценариев — на /session.
 */
import { For, Show, type Component } from "solid-js"
import type { Scenario } from "./scenarios"
import { AppTopbar } from "./app-topbar"
import { VERTICALS, verticalLabel, type Vertical } from "./verticals"

export interface HomeRecentSession {
  id: string
  title: string
  relativeAt: string
  subtitle?: string
  directory: string
}

export interface HomeWelcomeProps {
  vertical: Vertical
  recent: HomeRecentSession[]
  onOpenSession: (session: HomeRecentSession) => void
  onPickScenario: (s: Scenario) => void
  /** Начать новую задачу (основной CTA). */
  onStartNew: () => void
}

export const HomeWelcome: Component<HomeWelcomeProps> = (props) => {
  const recentVisible = () => props.recent.slice(0, 4)
  const currentLabel = () => verticalLabel(props.vertical)
  const heroLede = () => VERTICALS[props.vertical]?.heroLede ?? ""

  return (
    <div class="ourapp-landing">
      <AppTopbar active="home" />

      <main class="ourapp-landing__main">
        <div class="ourapp-landing__hero">
          <div class="ourapp-landing__eyebrow">
            Добро пожаловать в&nbsp;Isaac
            <span class="ourapp-landing__eyebrowdot" aria-hidden="true">·</span>
            <span class="ourapp-landing__eyebrowrole">{currentLabel()}</span>
          </div>
          <h1 class="ourapp-landing__title">
            Работа с ГОСТами <span>и стандартами.</span>
          </h1>
          <p class="ourapp-landing__lede">{heroLede()}</p>

          <div class="ourapp-landing__actions">
            <button
              type="button"
              class="ourapp-landing__cta ourapp-landing__cta--primary"
              onClick={props.onStartNew}
            >
              Начать новую задачу&nbsp;→
            </button>
          </div>
        </div>

        <Show when={recentVisible().length > 0}>
          <aside class="ourapp-landing__recent">
            <div class="ourapp-landing__recenthead">
              <h2 class="ourapp-landing__recenttitle">Продолжить работу</h2>
              <span class="ourapp-landing__recentcount">
                {props.recent.length} {props.recent.length === 1 ? "сессия" : "сессий"}
              </span>
            </div>
            <ul class="ourapp-landing__recentlist">
              <For each={recentVisible()}>
                {(session) => (
                  <li>
                    <button
                      type="button"
                      class="ourapp-landing__recentitem"
                      onClick={() => props.onOpenSession(session)}
                    >
                      <div class="ourapp-landing__recentline">
                        <span class="ourapp-landing__recentdot" aria-hidden="true" />
                        <span class="ourapp-landing__recentbody">
                          <span class="ourapp-landing__recenttext">{session.title}</span>
                          <span class="ourapp-landing__recentmeta">
                            {session.relativeAt}
                            {session.subtitle && (
                              <>
                                {" · "}
                                {session.subtitle}
                              </>
                            )}
                          </span>
                        </span>
                      </div>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </aside>
        </Show>
      </main>

      <footer class="ourapp-landing__foot">
        <span>1 кредит ≈ обработка ~2 000 токенов на Lite-модели · цена зависит от выбранной модели</span>
      </footer>
    </div>
  )
}

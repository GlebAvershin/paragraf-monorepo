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
import { scenariosFor, type Scenario } from "./scenarios"
import { AppTopbar } from "./app-topbar"
import { VERTICALS, verticalLabel, type Vertical } from "./verticals"
import { HintTour, HOME_HINTS } from "./hint-tour"

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
  const currentLabel = () => verticalLabel(props.vertical)
  const heroLede = () => VERTICALS[props.vertical]?.heroLede ?? ""
  const scenarios = () => scenariosFor(props.vertical).slice(0, 6)

  return (
    <div class="ourapp-landing">
      <AppTopbar active="home" />
      {/* Онбординг-подсказки (один раз после авторизации). */}
      <HintTour tourId="home" batches={HOME_HINTS} />

      <main class="ourapp-landing__main">
        <div class="ourapp-landing__hero">
          <div class="ourapp-landing__eyebrow">
            Isaac
            <span class="ourapp-landing__eyebrowdot" aria-hidden="true">·</span>
            <span class="ourapp-landing__eyebrowrole">{currentLabel()}</span>
          </div>
          <h1 class="ourapp-landing__title">
            Весь потенциал ИИ — <span>в вашей работе.</span>
          </h1>
          <p class="ourapp-landing__lede">{heroLede()}</p>
          <div class="ourapp-landing__actions">
            <button
              type="button"
              class="ourapp-landing__cta ourapp-landing__cta--primary"
              onClick={props.onStartNew}
            >
              Начать новую задачу
              <span class="ourapp-landing__cta-arrow" aria-hidden="true">→</span>
            </button>
          </div>
          <svg class="ourapp-landing__illustration" viewBox="0 0 240 280" fill="none" aria-hidden="true">
            <path class="ourapp-landing__illustration-guide" d="M20 248H220M208 32V228" />
            <g class="ourapp-landing__illustration-back">
              <rect class="ourapp-landing__illustration-sheet" x="77" y="28" width="134" height="184" rx="8" />
              <path class="ourapp-landing__illustration-line" d="M96 56H178M96 70H155" />
            </g>
            <g class="ourapp-landing__illustration-front">
              <rect class="ourapp-landing__illustration-paper" x="30" y="72" width="146" height="174" rx="8" />
              <path class="ourapp-landing__illustration-line" d="M52 127H152M52 145H132M52 163H152M52 181H118" />
              <path class="ourapp-landing__illustration-accent" d="M52 104H98" pathLength="1" />
              <path class="ourapp-landing__illustration-check" d="M131 212L137 218L151 204" pathLength="1" />
              <path class="ourapp-landing__illustration-line" d="M52 216H104" />
            </g>
          </svg>
        </div>
        <Show when={scenarios().length > 0}>
          {/* Якорь подсказки — вся колонка: плашка встаёт ПОД списком, в пустой
              зоне, не закрывая ни сценарии, ни hero. */}
          <aside class="ourapp-landing__scen" data-hint="home-scenarios">
            <div class="ourapp-landing__recenthead">
              <h2 class="ourapp-landing__recenttitle">Сценарии</h2>
            </div>
            <ul class="ourapp-landing__recentlist">
              <For each={scenarios()}>
                {(scenario) => (
                  <li>
                    <button
                      type="button"
                      class="ourapp-landing__recentitem"
                      onClick={() => props.onPickScenario(scenario)}
                    >
                      <div class="ourapp-landing__recentline">
                        <span class="ourapp-landing__recentdot" aria-hidden="true" />
                        <span class="ourapp-landing__recentbody">
                          <span class="ourapp-landing__recenttext">{scenario.title}</span>
                        </span>
                      </div>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </aside>
        </Show>

        <Show when={props.recent.length > 0}>
          {/* Якорь подсказки — вся колонка: плашка под списком, в пустой зоне. */}
          <aside class="ourapp-landing__recent" data-hint="home-recent">
            <div class="ourapp-landing__recenthead">
              <h2 class="ourapp-landing__recenttitle">Продолжить работу</h2>
            </div>
            {/* Показываем ~10 сессий, дальше — скролл по всей истории (ползунок справа). */}
            <ul class="ourapp-landing__recentlist ourapp-landing__recentlist--scroll">
              <For each={props.recent}>
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
    </div>
  )
}

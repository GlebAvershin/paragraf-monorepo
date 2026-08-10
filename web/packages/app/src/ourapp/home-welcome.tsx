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
import { AppWaveBackground } from "./app-wave-bg"
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
      <AppWaveBackground />
      <AppTopbar active="home" />
      {/* Онбординг-подсказки (один раз после авторизации). */}
      <HintTour tourId="home" batches={HOME_HINTS} />

      <main class="ourapp-landing__main">
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

        <div class="ourapp-landing__hero">
          <div class="ourapp-landing__eyebrow">
            Добро пожаловать в&nbsp;Isaac
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
              Начать новую задачу&nbsp;→
            </button>
          </div>
        </div>

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

/**
 * OurApp — внутренний дашборд клик-аналитики (2026-07-09).
 *
 * Только для разработчиков/аналитика. Тот же гейт (ADMIN_TOKEN, sessionStorage),
 * что у /admin/conversations — см. admin-api.ts. Не показывается ни в одной
 * навигации, открывается напрямую по URL /admin/click-analytics (НЕ /admin/events —
 * этот путь занят billing-API, см. admin-events-route.tsx).
 *
 * Отвечает на 5 конкретных вопросов аналитика:
 *   1) «История» в сайдбаре/на главной — кликают ли вообще, куда, насколько
 *      старую сессию открывают (нужно ли показывать больше 8 недавних).
 *   2) Как часто жмут «Начать новую задачу».
 *   3) Как часто кликают по сценариям (и по каким).
 *   4) Как часто открывают side-панель документа (карточка в чате vs кнопка «Предпросмотр»).
 *   5) Как часто переключают/открывают вкладки чата.
 */
import { createResource, createSignal, For, Show, type Component } from "solid-js"
import { adminApi, clearAdminToken, getAdminToken, setAdminToken, type AdminEventItem } from "@/ourapp/admin-api"
import { periodRange, type UsagePeriod } from "@/ourapp/usage-api"
import { SCENARIOS as WIZARD_SCENARIOS } from "@/ourapp/scenarios/index"
import "./admin-conversations.css"
import "./admin-events.css"

const PERIOD_LABELS: Record<UsagePeriod, string> = { week: "Неделя", month: "Месяц", year: "Год" }

const EVENT_TYPE_LABELS: Record<string, string> = {
  history_click: "Клик по «Истории»",
  new_task_click: "«Начать новую задачу»",
  scenario_pick: "Клик по сценарию",
  artifact_panel_view: "Просмотр side-панели документа",
  chat_tab_click: "Переключение вкладки чата",
  chat_tab_new_click: "Новая вкладка чата",
}

const HISTORY_SOURCE_LABELS: Record<string, string> = {
  sidebar_history: "Сайдбар «История» (топ-8)",
  home_continue: "Главная «Продолжить работу»",
  history_page: "Страница /history (вся история)",
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function scenarioTitle(id: string | null): string {
  if (!id) return "—"
  return WIZARD_SCENARIOS.find((s) => s.id === id)?.title ?? id
}

export const AdminEventsPage: Component = () => {
  const [token, setToken] = createSignal(getAdminToken())
  const [tokenDraft, setTokenDraft] = createSignal("")
  const [period, setPeriod] = createSignal<UsagePeriod>("month")
  const [feedType, setFeedType] = createSignal<string>("")

  const [summary, { refetch: refetchSummary }] = createResource(
    () => (token() ? period() : null),
    async (p) => {
      const { from, to } = periodRange(p)
      const r = await adminApi.eventsSummary(from, to)
      return r.ok ? r.data : null
    },
  )

  const [feed, { refetch: refetchFeed }] = createResource(
    () => (token() ? ([feedType(), period()] as const) : null),
    async ([type]) => {
      const r = await adminApi.events(type || undefined, 200)
      return r.ok ? r.data.items : []
    },
  )

  const submitToken = (e: Event) => {
    e.preventDefault()
    const t = tokenDraft().trim()
    if (!t) return
    setAdminToken(t)
    setToken(t)
    setTokenDraft("")
  }

  const logout = () => {
    clearAdminToken()
    setToken("")
  }

  const refetchAll = () => {
    void refetchSummary()
    void refetchFeed()
  }

  return (
    <div class="ourapp-admin">
      <Show
        when={token()}
        fallback={
          <div class="ourapp-admin__gate">
            <form class="ourapp-admin__gateForm" onSubmit={submitToken}>
              <h1>Админ-панель · клик-аналитика</h1>
              <p>Только для разработчиков. Введите ADMIN_TOKEN.</p>
              <input
                type="password"
                value={tokenDraft()}
                onInput={(e) => setTokenDraft(e.currentTarget.value)}
                placeholder="ADMIN_TOKEN"
                autofocus
              />
              <button type="submit">Войти</button>
            </form>
          </div>
        }
      >
        <div class="ourapp-events">
          <header class="ourapp-events__head">
            <h1>Клик-аналитика</h1>
            <div class="ourapp-events__headActions">
              <a href="/admin/conversations">→ Переписка</a>
              <div class="ourapp-events__pills">
                <For each={["week", "month", "year"] as UsagePeriod[]}>
                  {(p) => (
                    <button
                      type="button"
                      classList={{ "ourapp-events__pill--active": period() === p }}
                      class="ourapp-events__pill"
                      onClick={() => setPeriod(p)}
                    >
                      {PERIOD_LABELS[p]}
                    </button>
                  )}
                </For>
              </div>
              <button type="button" onClick={refetchAll} title="Обновить">
                ⟳
              </button>
              <button type="button" onClick={logout} title="Выйти">
                ✕
              </button>
            </div>
          </header>

          <Show
            when={!summary.loading}
            fallback={<div class="ourapp-events__loading">Загрузка…</div>}
          >
            <Show
              when={summary()}
              fallback={<div class="ourapp-admin__error">Не удалось загрузить сводку — проверьте токен.</div>}
            >
              {(s) => (
                <div class="ourapp-events__grid">
                  <section class="ourapp-events__card">
                    <h2>Все события за период</h2>
                    <table class="ourapp-events__table">
                      <tbody>
                        <For each={s().byType}>
                          {(row) => (
                            <tr>
                              <td>{EVENT_TYPE_LABELS[row.eventType] ?? row.eventType}</td>
                              <td class="ourapp-events__num">{row.count}</td>
                            </tr>
                          )}
                        </For>
                        <Show when={s().byType.length === 0}>
                          <tr>
                            <td colSpan={2}>Событий пока нет.</td>
                          </tr>
                        </Show>
                      </tbody>
                    </table>
                  </section>

                  <section class="ourapp-events__card">
                    <h2>1 · «История» — возвращаются ли в старые диалоги</h2>
                    <p class="ourapp-events__lede">
                      Уникальных пользователей, кликнувших по старой сессии за период:{" "}
                      <strong>{s().history.distinctUsersClicked}</strong>
                    </p>
                    <h3>Откуда кликают</h3>
                    <table class="ourapp-events__table">
                      <tbody>
                        <For each={s().history.bySource}>
                          {(row) => (
                            <tr>
                              <td>{(row.source && HISTORY_SOURCE_LABELS[row.source]) ?? row.source ?? "—"}</td>
                              <td class="ourapp-events__num">{row.count}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                    <h3>Позиция в списке (0 = самая свежая сессия)</h3>
                    <p class="ourapp-events__hint">
                      Считается отдельно по источнику — у /history нет лимита видимости, поэтому её позиции
                      не показательны. Смотрите на «Сайдбар «История»»: если там клики концентрируются у
                      позиций 6-7 (край списка из 8) — сигнал, что стоит показывать больше сессий.
                    </p>
                    <table class="ourapp-events__table">
                      <thead>
                        <tr>
                          <th>Откуда</th>
                          <th>Позиция</th>
                          <th>Кликов</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={s().history.byRank}>
                          {(row) => (
                            <tr>
                              <td>{(row.source && HISTORY_SOURCE_LABELS[row.source]) ?? row.source ?? "—"}</td>
                              <td>#{row.rank}</td>
                              <td class="ourapp-events__num">{row.count}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                    <h3>Насколько старую сессию открыли</h3>
                    <table class="ourapp-events__table">
                      <tbody>
                        <For each={s().history.byAge}>
                          {(row) => (
                            <tr>
                              <td>{row.bucket}</td>
                              <td class="ourapp-events__num">{row.count}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </section>

                  <section class="ourapp-events__card">
                    <h2>2 · «Начать новую задачу»</h2>
                    <table class="ourapp-events__table">
                      <tbody>
                        <For each={s().newTask.byResolved}>
                          {(row) => (
                            <tr>
                              <td>
                                {row.resolved === "true"
                                  ? "Проект уже выбран → сразу новая сессия"
                                  : row.resolved === "false"
                                    ? "Пришлось сначала выбрать проект"
                                    : "—"}
                              </td>
                              <td class="ourapp-events__num">{row.count}</td>
                            </tr>
                          )}
                        </For>
                        <Show when={s().newTask.byResolved.length === 0}>
                          <tr>
                            <td colSpan={2}>Кликов пока нет.</td>
                          </tr>
                        </Show>
                      </tbody>
                    </table>
                  </section>

                  <section class="ourapp-events__card">
                    <h2>3 · Топ сценариев по кликам</h2>
                    <table class="ourapp-events__table">
                      <thead>
                        <tr>
                          <th>Сценарий</th>
                          <th>Откуда</th>
                          <th>Кликов</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={s().scenarios.top}>
                          {(row) => (
                            <tr>
                              <td>{scenarioTitle(row.scenarioId)}</td>
                              <td>
                                {row.source === "sidebar" ? "Сайдбар" : row.source === "home" ? "Главная" : (row.source ?? "—")}
                              </td>
                              <td class="ourapp-events__num">{row.count}</td>
                            </tr>
                          )}
                        </For>
                        <Show when={s().scenarios.top.length === 0}>
                          <tr>
                            <td colSpan={3}>Кликов пока нет.</td>
                          </tr>
                        </Show>
                      </tbody>
                    </table>
                  </section>

                  <section class="ourapp-events__card">
                    <h2>4 · Side-панель документа</h2>
                    <table class="ourapp-events__table">
                      <tbody>
                        <For each={s().artifactPanel.bySource}>
                          {(row) => (
                            <tr>
                              <td>
                                {row.source === "card"
                                  ? "Клик по карточке в чате"
                                  : row.source === "preview_button"
                                    ? "Кнопка «Предпросмотр»"
                                    : row.source}
                              </td>
                              <td class="ourapp-events__num">{row.count}</td>
                            </tr>
                          )}
                        </For>
                        <Show when={s().artifactPanel.bySource.length === 0}>
                          <tr>
                            <td colSpan={2}>Просмотров пока нет.</td>
                          </tr>
                        </Show>
                      </tbody>
                    </table>
                  </section>

                  <section class="ourapp-events__card">
                    <h2>5 · Вкладки чата</h2>
                    <table class="ourapp-events__table">
                      <tbody>
                        <tr>
                          <td>Переключились на существующую вкладку</td>
                          <td class="ourapp-events__num">{s().chatTabs.switchClicks}</td>
                        </tr>
                        <tr>
                          <td>Открыли новую вкладку</td>
                          <td class="ourapp-events__num">{s().chatTabs.newTabClicks}</td>
                        </tr>
                      </tbody>
                    </table>
                  </section>
                </div>
              )}
            </Show>
          </Show>

          <section class="ourapp-events__feed">
            <div class="ourapp-events__feedHead">
              <h2>Сырой фид (для точечного разбора)</h2>
              <select value={feedType()} onChange={(e) => setFeedType(e.currentTarget.value)}>
                <option value="">Все типы</option>
                <For each={Object.keys(EVENT_TYPE_LABELS)}>{(t) => <option value={t}>{EVENT_TYPE_LABELS[t]}</option>}</For>
              </select>
            </div>
            <div class="ourapp-events__feedScroll">
              <table class="ourapp-events__table">
                <thead>
                  <tr>
                    <th>Когда</th>
                    <th>Email</th>
                    <th>Событие</th>
                    <th>Детали</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={feed() ?? ([] as AdminEventItem[])}>
                    {(item) => (
                      <tr>
                        <td>{formatDate(item.createdAt)}</td>
                        <td>{item.email ?? item.userId}</td>
                        <td>{EVENT_TYPE_LABELS[item.eventType] ?? item.eventType}</td>
                        <td class="ourapp-events__meta">{JSON.stringify(item.metadata)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </Show>
    </div>
  )
}

export default AdminEventsPage

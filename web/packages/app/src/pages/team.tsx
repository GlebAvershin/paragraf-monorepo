/**
 * OurApp — «Команда»: кабинет менеджера.
 *
 * Доступна только роли manager (бэкенд гейтит /manager/* через requireManager;
 * здесь дополнительно прячем страницу и показываем понятную заглушку, чтобы по
 * прямой ссылке обычный сотрудник не упирался в голое 403).
 *
 * Что умеет: список сотрудников с балансом и расходом за период, создание
 * сотрудника (email + стартовый пароль), перевод кредитов со своего баланса,
 * история запросов по конкретному сотруднику.
 *
 * Аналитика — только цифры и метаданные (модель, сценарий, токены, кредиты,
 * время). Текстов переписки здесь нет и не будет: они лежат в движке и
 * менеджеру сознательно не отдаются.
 */
import { createResource, createSignal, For, Show, type Component } from "solid-js"
import { billingApi, cacheReset } from "@/ourapp/billing-api"
import {
  managerApi,
  managerErrorText,
  type EmployeeUsageItem,
  type TeamMember,
} from "@/ourapp/manager-api"
import { periodRange, type UsagePeriod } from "@/ourapp/usage-api"
import { AppTopbar } from "@/ourapp/app-topbar"
import { SCENARIOS as WIZARD_SCENARIOS } from "@/ourapp/scenarios/index"
import "./team.css"

// Сброса кэша billing-api недостаточно: шапка (AppTopbar) уже смонтирована и
// свой /limits сама не перезапросит — остаток кредитов в ней оставался старым
// до перезагрузки страницы. Тот же паттерн, что "ourapp:vertical-changed".
const notifyCreditsChanged = () => window.dispatchEvent(new Event("ourapp:credits-changed"))

const PERIOD_LABELS: Record<UsagePeriod, string> = { week: "Неделя", month: "Месяц", year: "Год" }

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("ru", { day: "numeric", month: "short", year: "numeric" })

const scenarioTitle = (id: string | null) =>
  id ? (WIZARD_SCENARIOS.find((s) => s.id === id)?.title ?? id) : "—"

export const TeamPage: Component = () => {
  const [period, setPeriod] = createSignal<UsagePeriod>("month")
  const [me, { refetch: refetchMe }] = createResource(() =>
    billingApi.me().then((r) => (r.ok ? r.data : null)),
  )

  const isManager = () => me()?.user.role === "manager"

  const [team, { refetch: refetchTeam }] = createResource(
    () => (isManager() ? period() : null),
    async (p: UsagePeriod) => {
      const { from, to } = periodRange(p)
      const r = await managerApi.team(from, to)
      return r.ok ? r.data : null
    },
  )

  // ---- создание сотрудника ----
  const [formOpen, setFormOpen] = createSignal(false)
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [name, setName] = createSignal("")
  const [initialCredits, setInitialCredits] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [formError, setFormError] = createSignal<string | null>(null)
  const [formOk, setFormOk] = createSignal<string | null>(null)

  const resetForm = () => {
    setEmail("")
    setPassword("")
    setName("")
    setInitialCredits("")
    setFormError(null)
  }

  const submitEmployee = async (e: Event) => {
    e.preventDefault()
    setFormError(null)
    setFormOk(null)
    const credits = initialCredits().trim() ? Number(initialCredits()) : 0
    if (!Number.isInteger(credits) || credits < 0) {
      setFormError("Кредиты — целое неотрицательное число")
      return
    }
    setBusy(true)
    const res = await managerApi.createEmployee({
      email: email().trim(),
      password: password(),
      name: name().trim() || undefined,
      initialCredits: credits,
    })
    setBusy(false)
    if (!res.ok) {
      setFormError(managerErrorText(res.error))
      return
    }
    setFormOk(
      `Сотрудник ${res.data.email} создан` +
        (res.data.creditsTransferred > 0 ? `, переведено ${res.data.creditsTransferred} кредитов` : ""),
    )
    resetForm()
    setFormOpen(false)
    // Баланс в шапке берётся из /limits с 60-секундным кэшем billing-api —
    // без сброса менеджер увидит там старую цифру ещё минуту после перевода.
    cacheReset()
    notifyCreditsChanged()
    void refetchTeam()
  }

  // ---- перевод кредитов ----
  const [grantFor, setGrantFor] = createSignal<string | null>(null)
  const [grantAmount, setGrantAmount] = createSignal("")
  const [grantError, setGrantError] = createSignal<string | null>(null)

  const submitGrant = async (member: TeamMember) => {
    const credits = Number(grantAmount())
    if (!Number.isInteger(credits) || credits <= 0) {
      setGrantError("Введите целое число больше нуля")
      return
    }
    setGrantError(null)
    setBusy(true)
    const res = await managerApi.grantCredits(member.userId, credits)
    setBusy(false)
    if (!res.ok) {
      setGrantError(managerErrorText(res.error))
      return
    }
    setGrantFor(null)
    setGrantAmount("")
    cacheReset()
    notifyCreditsChanged()
    void refetchTeam()
  }

  // ---- история запросов сотрудника ----
  const [usageFor, setUsageFor] = createSignal<TeamMember | null>(null)
  const [usage] = createResource(
    () => {
      const m = usageFor()
      return m ? ([m.userId, period()] as const) : null
    },
    async ([userId, p]: readonly [string, UsagePeriod]) => {
      const { from, to } = periodRange(p)
      const r = await managerApi.employeeUsage(userId, from, to, 200)
      return r.ok ? r.data.items : []
    },
  )

  const becomeManager = async () => {
    setBusy(true)
    const res = await managerApi.activate()
    setBusy(false)
    if (!res.ok) {
      setFormError(managerErrorText(res.error))
      return
    }
    void refetchMe()
  }

  return (
    <div class="ourapp-team">
      <AppTopbar active="team" />

      <main class="ourapp-team__main">
        <h1 class="ourapp-team__title">
          <em>Команда</em>
        </h1>

        <Show
          when={isManager()}
          fallback={
            <Show when={!me.loading} fallback={<div class="ourapp-team__loading">Загружаем…</div>}>
              <div class="ourapp-team__empty">
                <Show
                  when={me()?.user.canBecomeManager}
                  fallback={
                    <p>
                      Этот раздел доступен менеджерам. Ваш аккаунт создан менеджером — расход по нему
                      уже виден в его кабинете.
                    </p>
                  }
                >
                  <p>
                    Станьте менеджером, чтобы заводить сотрудников, раздавать им кредиты и видеть их
                    расход. На вашу работу с сервисом это никак не влияет.
                  </p>
                  <button type="button" class="ourapp-btn" disabled={busy()} onClick={becomeManager}>
                    Стать менеджером
                  </button>
                </Show>
                <Show when={formError()}>{(msg) => <p class="ourapp-team__error">{msg()}</p>}</Show>
              </div>
            </Show>
          }
        >
          <div class="ourapp-team__filters">
            <div class="ourapp-settings__pills">
              <For each={["week", "month", "year"] as UsagePeriod[]}>
                {(p) => (
                  <button
                    type="button"
                    class="ourapp-pill"
                    classList={{ "ourapp-pill--active": period() === p }}
                    onClick={() => setPeriod(p)}
                  >
                    {PERIOD_LABELS[p]}
                  </button>
                )}
              </For>
            </div>
            <button
              type="button"
              class="ourapp-btn"
              onClick={() => {
                setFormOpen(!formOpen())
                setFormOk(null)
              }}
            >
              {formOpen() ? "Отмена" : "Добавить сотрудника"}
            </button>
          </div>

          <Show when={formOk()}>{(msg) => <p class="ourapp-team__ok">{msg()}</p>}</Show>

          <Show when={formOpen()}>
            <form class="ourapp-team__form" onSubmit={submitEmployee}>
              <p class="ourapp-team__formlede">
                Сотрудник входит по этим email и паролю — передайте их ему лично. Пароль он сможет
                использовать сразу, ограничений в работе у него не будет.
              </p>
              <div class="ourapp-team__formrow">
                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    required
                    value={email()}
                    onInput={(e) => setEmail(e.currentTarget.value)}
                    placeholder="employee@company.ru"
                  />
                </label>
                <label>
                  <span>Стартовый пароль</span>
                  <input
                    type="text"
                    required
                    minLength={6}
                    value={password()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                    placeholder="минимум 6 символов"
                  />
                </label>
              </div>
              <div class="ourapp-team__formrow">
                <label>
                  <span>Имя (необязательно)</span>
                  <input value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="Иван Петров" />
                </label>
                <label>
                  <span>Выдать кредитов сразу</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={initialCredits()}
                    onInput={(e) => setInitialCredits(e.currentTarget.value)}
                    placeholder="0"
                  />
                </label>
              </div>
              <Show when={formError()}>{(msg) => <p class="ourapp-team__error">{msg()}</p>}</Show>
              <div class="ourapp-team__formactions">
                <button type="submit" class="ourapp-btn" disabled={busy()}>
                  {busy() ? "Создаём…" : "Создать сотрудника"}
                </button>
              </div>
            </form>
          </Show>

          <Show when={team()} fallback={<div class="ourapp-team__loading">Загружаем команду…</div>}>
            {(data) => (
              <>
                <div class="ourapp-team__cards">
                  <article class="ourapp-team__card">
                    <div class="ourapp-team__cardLabel">Ваш баланс</div>
                    <div class="ourapp-team__cardValue">{data().managerBalance.toLocaleString("ru")}</div>
                  </article>
                  <article class="ourapp-team__card">
                    <div class="ourapp-team__cardLabel">Сотрудников</div>
                    <div class="ourapp-team__cardValue">{data().totals.employees}</div>
                  </article>
                  <article class="ourapp-team__card">
                    <div class="ourapp-team__cardLabel">Потрачено командой</div>
                    <div class="ourapp-team__cardValue">{data().totals.credits.toLocaleString("ru")}</div>
                  </article>
                  <article class="ourapp-team__card">
                    <div class="ourapp-team__cardLabel">Запросов</div>
                    <div class="ourapp-team__cardValue">{data().totals.requests.toLocaleString("ru")}</div>
                  </article>
                </div>

                <Show
                  when={data().members.length > 0}
                  fallback={
                    <div class="ourapp-team__empty">
                      <p>Пока ни одного сотрудника. Нажмите «Добавить сотрудника» — он сможет войти сразу.</p>
                    </div>
                  }
                >
                  <table class="ourapp-team__table">
                    <thead>
                      <tr>
                        <th>Сотрудник</th>
                        <th class="ourapp-team__num">Баланс</th>
                        <th class="ourapp-team__num">Потрачено</th>
                        <th class="ourapp-team__num">Запросов</th>
                        <th class="ourapp-team__num">Токенов</th>
                        <th>Последний запрос</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      <For each={data().members}>
                        {(member) => (
                          <>
                            <tr>
                              <td>
                                <div class="ourapp-team__member">{member.name || member.email}</div>
                                <Show when={member.name}>
                                  <div class="ourapp-team__submeta">{member.email}</div>
                                </Show>
                                <div class="ourapp-team__submeta">с {formatDate(member.createdAt)}</div>
                              </td>
                              <td class="ourapp-team__num">{member.balance.toLocaleString("ru")}</td>
                              <td class="ourapp-team__num">{member.usage.credits.toLocaleString("ru")}</td>
                              <td class="ourapp-team__num">{member.usage.requests.toLocaleString("ru")}</td>
                              <td class="ourapp-team__num">{member.usage.tokens.toLocaleString("ru")}</td>
                              <td>
                                {member.usage.lastRequestAt ? formatDateTime(member.usage.lastRequestAt) : "—"}
                              </td>
                              <td class="ourapp-team__actions">
                                <button
                                  type="button"
                                  class="ourapp-team__link"
                                  onClick={() => {
                                    setGrantError(null)
                                    setGrantFor(grantFor() === member.userId ? null : member.userId)
                                    setGrantAmount("")
                                  }}
                                >
                                  Выдать кредиты
                                </button>
                                <button
                                  type="button"
                                  class="ourapp-team__link"
                                  onClick={() =>
                                    setUsageFor(usageFor()?.userId === member.userId ? null : member)
                                  }
                                >
                                  {usageFor()?.userId === member.userId ? "Скрыть историю" : "История"}
                                </button>
                              </td>
                            </tr>

                            <Show when={grantFor() === member.userId}>
                              <tr class="ourapp-team__inlinerow">
                                <td colSpan={7}>
                                  <div class="ourapp-team__grant">
                                    <span>
                                      Перевести с вашего баланса ({data().managerBalance.toLocaleString("ru")}) →{" "}
                                      {member.name || member.email}
                                    </span>
                                    <input
                                      type="number"
                                      min="1"
                                      step="1"
                                      value={grantAmount()}
                                      onInput={(e) => setGrantAmount(e.currentTarget.value)}
                                      placeholder="кредитов"
                                    />
                                    <button
                                      type="button"
                                      class="ourapp-btn"
                                      disabled={busy()}
                                      onClick={() => void submitGrant(member)}
                                    >
                                      Перевести
                                    </button>
                                    <Show when={grantError()}>
                                      {(msg) => <span class="ourapp-team__error">{msg()}</span>}
                                    </Show>
                                  </div>
                                </td>
                              </tr>
                            </Show>

                            <Show when={usageFor()?.userId === member.userId}>
                              <tr class="ourapp-team__inlinerow">
                                <td colSpan={7}>
                                  <Show
                                    when={!usage.loading}
                                    fallback={<div class="ourapp-team__loading">Загружаем историю…</div>}
                                  >
                                    <Show
                                      when={(usage() ?? []).length > 0}
                                      fallback={<div class="ourapp-team__submeta">За период запросов нет.</div>}
                                    >
                                      <table class="ourapp-team__subtable">
                                        <thead>
                                          <tr>
                                            <th>Когда</th>
                                            <th>Модель</th>
                                            <th>Сценарий</th>
                                            <th class="ourapp-team__num">Токенов</th>
                                            <th class="ourapp-team__num">Кредитов</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          <For each={usage() ?? ([] as EmployeeUsageItem[])}>
                                            {(item) => (
                                              <tr>
                                                <td>{formatDateTime(item.createdAt)}</td>
                                                <td>{item.model}</td>
                                                <td>{scenarioTitle(item.scenarioId)}</td>
                                                <td class="ourapp-team__num">
                                                  {(item.inputTokens + item.outputTokens).toLocaleString("ru")}
                                                </td>
                                                <td class="ourapp-team__num">{item.creditsCharged}</td>
                                              </tr>
                                            )}
                                          </For>
                                        </tbody>
                                      </table>
                                    </Show>
                                  </Show>
                                </td>
                              </tr>
                            </Show>
                          </>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </main>
    </div>
  )
}

export default TeamPage

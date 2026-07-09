/**
 * OurApp — внутренняя админ-панель: просмотр переписки всех пользователей.
 *
 * Только для разработчиков. Отдельный гейт (ADMIN_TOKEN, не customer-JWT) поверх
 * обычного OnboardingGate — см. admin-api.ts. Не показывается ни в одной навигации,
 * открывается напрямую по URL /admin/conversations.
 *
 * Список слева (поиск по email/заголовку) + полная переписка справа. Рендер
 * простой (без markdown) — это инструмент разработчика, не клиентский UI.
 */
import { createMemo, createResource, createSignal, For, Show, type Component } from "solid-js"
import { adminApi, clearAdminToken, getAdminToken, setAdminToken, type AdminSession } from "@/ourapp/admin-api"
import "./admin-conversations.css"

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("ru", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Текст всех text-частей сообщения, конкатенированный (reasoning/tool — отдельно помечаем). */
function partsText(parts: Array<Record<string, unknown>>): { text: string; reasoning: string; other: string[] } {
  let text = ""
  let reasoning = ""
  const other: string[] = []
  for (const p of parts) {
    const type = p.type as string | undefined
    if (type === "text" && typeof p.text === "string") text += p.text
    else if (type === "reasoning" && typeof p.text === "string") reasoning += p.text
    else other.push(type ?? "unknown")
  }
  return { text, reasoning, other }
}

export const AdminConversationsPage: Component = () => {
  const [token, setToken] = createSignal(getAdminToken())
  const [tokenDraft, setTokenDraft] = createSignal("")
  const [search, setSearch] = createSignal("")
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  const [usersRes, { refetch: refetchUsers }] = createResource(token, () => adminApi.users())
  const [sessionsRes, { refetch: refetchSessions }] = createResource(token, () => adminApi.sessions(300))
  const [messagesRes] = createResource(selectedId, (id) => adminApi.messages(id))

  const emailByUser = createMemo(() => {
    const map = new Map<string, string>()
    const res = usersRes()
    if (res?.ok) for (const u of res.data.users) map.set(u.id, u.email)
    return map
  })

  const totalSessions = createMemo<number | undefined>(() => {
    const res = sessionsRes()
    return res?.ok ? res.data.total : undefined
  })

  const rows = createMemo<Array<AdminSession & { email: string }>>(() => {
    const res = sessionsRes()
    if (!res?.ok) return []
    const emails = emailByUser()
    return res.data.sessions.map((s) => ({ ...s, email: emails.get(s.userId) ?? s.userId }))
  })

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase()
    if (!q) return rows()
    return rows().filter(
      (r) => r.email.toLowerCase().includes(q) || (r.title ?? "").toLowerCase().includes(q),
    )
  })

  const selectedRow = createMemo(() => rows().find((r) => r.id === selectedId()))

  const messagesList = createMemo(() => {
    const res = messagesRes()
    return res?.ok ? res.data : []
  })

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
    setSelectedId(null)
  }

  return (
    <div class="ourapp-admin">
      <Show
        when={token()}
        fallback={
          <div class="ourapp-admin__gate">
            <form class="ourapp-admin__gateForm" onSubmit={submitToken}>
              <h1>Админ-панель · переписка</h1>
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
        <div class="ourapp-admin__layout">
          <aside class="ourapp-admin__list">
            <div class="ourapp-admin__listHead">
              <input
                type="search"
                placeholder="Поиск по email или заголовку…"
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
              />
              <a href="/admin/events" class="ourapp-admin__eventsLink" title="Клик-аналитика">
                Клики →
              </a>
              <button
                type="button"
                title="Обновить"
                onClick={() => {
                  void refetchUsers()
                  void refetchSessions()
                }}
              >
                ⟳
              </button>
              <button type="button" title="Выйти" onClick={logout}>
                ✕
              </button>
            </div>
            <Show when={usersRes.error || sessionsRes.error}>
              <div class="ourapp-admin__error">Ошибка загрузки — проверьте токен.</div>
            </Show>
            <Show when={totalSessions() !== undefined}>
              <div class="ourapp-admin__count">
                {filtered().length} из {totalSessions()}
              </div>
            </Show>
            <ul class="ourapp-admin__rows">
              <For each={filtered()}>
                {(row) => (
                  <li
                    class="ourapp-admin__row"
                    classList={{ "ourapp-admin__row--active": row.id === selectedId() }}
                    onClick={() => setSelectedId(row.id)}
                  >
                    <div class="ourapp-admin__rowEmail">{row.email}</div>
                    <div class="ourapp-admin__rowTitle">{row.title || "Без названия"}</div>
                    <div class="ourapp-admin__rowMeta">
                      {formatDate(row.time.updated ?? row.time.created)}
                      <Show when={row.time.archived}> · архив</Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </aside>

          <main class="ourapp-admin__detail">
            <Show
              when={selectedRow()}
              fallback={<div class="ourapp-admin__empty">Выберите сессию слева.</div>}
            >
              {(row) => (
                <>
                  <header class="ourapp-admin__detailHead">
                    <div class="ourapp-admin__detailTitle">{row().title || "Без названия"}</div>
                    <div class="ourapp-admin__detailMeta">
                      {row().email} · создано {formatDate(row().time.created)} · id {row().id}
                    </div>
                  </header>
                  <div class="ourapp-admin__thread">
                    <Show when={messagesRes.loading}>
                      <div class="ourapp-admin__empty">Загрузка…</div>
                    </Show>
                    <Show when={messagesRes()?.ok}>
                      <For each={messagesList()}>
                        {(m) => {
                          const info = m.info as { role?: string; modelID?: string; time?: { created?: number } }
                          const { text, reasoning, other } = partsText(m.parts)
                          return (
                            <div class="ourapp-admin__msg" classList={{ "ourapp-admin__msg--user": info.role === "user" }}>
                              <div class="ourapp-admin__msgMeta">
                                {info.role === "user" ? "Пользователь" : `Ассистент${info.modelID ? ` · ${info.modelID}` : ""}`}
                                <Show when={info.time?.created}> · {formatDate(info.time!.created!)}</Show>
                              </div>
                              <Show when={reasoning}>
                                <div class="ourapp-admin__msgReasoning">{reasoning}</div>
                              </Show>
                              <div class="ourapp-admin__msgText">{text || "(пусто)"}</div>
                              <Show when={other.length > 0}>
                                <div class="ourapp-admin__msgOther">+ {other.join(", ")}</div>
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </main>
        </div>
      </Show>
    </div>
  )
}

export default AdminConversationsPage

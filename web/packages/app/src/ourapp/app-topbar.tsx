/**
 * OurApp AppTopbar — единая шапка для всех страниц приложения.
 *
 * Раньше у каждой страницы (Home/Credits/Settings/History/Analytics/Help) была
 * своя вёрстка шапки (разный паддинг, фон, набор кнопок) — при переходе между
 * страницами шапка визуально «прыгала» (цвет/ширина/текст). Теперь одна шапка,
 * меняется только подсвеченный пункт nav.
 */
import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { billingApi, type LimitsResponse, type MeResponse } from "./billing-api"
import { isVerticalEnabled, loadVertical, persistVertical, saveVertical, VERTICAL_ORDER, verticalLabel, type Vertical } from "./verticals"

// Последние загруженные значения переживают перемонтирование шапки: навигация
// между страницами монтирует AppTopbar заново, и без этого кэша блок
// кредитов/почты на мгновение исчезал («мигал») при каждом переходе.
let lastMe: MeResponse | null = null
let lastLimits: LimitsResponse | null = null

export type AppTopbarActive = "home" | "credits" | "history" | "analytics" | "team" | "settings" | "help"

// «Настройки» из nav переехали в правый край шапки: там теперь почта аккаунта
// (клик → настройки) и полоска остатка кредитов (клик → /credits).
// «Главная» убрана из nav — на главную ведёт клик по бренду «Isaac» (как в
// воркспейс-сайдбаре). «Кредиты» убраны — остаток кредитов показан справа.
const NAV_ITEMS: Array<{ id: AppTopbarActive; label: string; path: string }> = [
  { id: "history", label: "История", path: "/history" },
  { id: "analytics", label: "Аналитика", path: "/analytics" },
  { id: "help", label: "Помощь", path: "/help" },
]

// «Команда» — только для роли manager: обычному сотруднику раздел не нужен
// (он всё равно увидит там заглушку, а лишний пункт в шапке путает).
const TEAM_ITEM: { id: AppTopbarActive; label: string; path: string } = {
  id: "team",
  label: "Команда",
  path: "/team",
}

export const AppTopbar: Component<{ active: AppTopbarActive }> = (props) => {
  const navigate = useNavigate()
  const [vertical, setVertical] = createSignal<Vertical>(loadVertical())
  const [menuOpen, setMenuOpen] = createSignal(false)

  const [me] = createResource(
    () => billingApi.me().then((r) => (r.ok ? (lastMe = r.data) : lastMe)),
    { initialValue: lastMe ?? undefined },
  )
  const [limits, { refetch: refetchLimits }] = createResource(
    () => billingApi.limits().then((r) => (r.ok ? (lastLimits = r.data) : lastLimits)),
    { initialValue: lastLimits ?? undefined },
  )

  createEffect(() => {
    const stored = me()?.user.primaryVertical
    if (stored !== "lawyer" && stored !== "accountant") return
    if (stored === vertical()) return
    setVertical(stored)
    saveVertical(stored)
    window.dispatchEvent(new Event("ourapp:vertical-changed"))
  })

  // Кабинет менеджера меняет баланс, не уходя со страницы: сбросить кэш
  // billing-api мало — этот resource уже отработал и сам не перезапросит,
  // поэтому остаток в шапке висел старым до перезагрузки. Слушаем событие.
  onMount(() => {
    const onCreditsChanged = () => void refetchLimits()
    window.addEventListener("ourapp:credits-changed", onCreditsChanged)
    onCleanup(() => window.removeEventListener("ourapp:credits-changed", onCreditsChanged))
  })

  const navItems = () => (me()?.user.role === "manager" ? [...NAV_ITEMS, TEAM_ITEM] : NAV_ITEMS)

  const creditsRemaining = () => limits()?.credits.remaining ?? 0
  const creditsTotal = () => limits()?.credits.monthlyTotal ?? 0
  const creditsPct = () => {
    const total = creditsTotal()
    if (total <= 0) return 0
    return Math.max(0, Math.min(100, (creditsRemaining() / total) * 100))
  }

  const onVerticalChange = (v: Vertical) => {
    setVertical(v)
    persistVertical(v)
    // Другие компоненты (напр. hero на Home) держат свою копию текущей
    // вертикали — уведомляем через window-event, тот же паттерн, что и
    // "ourapp:session-changed" в onboarding-gate.tsx.
    window.dispatchEvent(new Event("ourapp:vertical-changed"))
  }

  return (
    <header class="ourapp-landing__topbar">
      <div class="ourapp-landing__brandgroup">
        <div class="ourapp-landing__brand">
          <button
            type="button"
            class="ourapp-landing__brandname"
            title="На главную"
            onClick={() => navigate("/")}
          >
            Isaac
          </button>
          <DropdownMenu gutter={4} placement="bottom-start" open={menuOpen()} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger
              as="button"
              type="button"
              class="ourapp-landing__vertical"
              data-hint="home-vertical"
              aria-expanded={menuOpen()}
            >
              {verticalLabel(vertical())}
              <Icon name="chevron-down" class="size-3" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content style={{ "min-width": "160px" }}>
                <For each={VERTICAL_ORDER}>
                  {(v) => (
                    <DropdownMenu.Item
                      disabled={!isVerticalEnabled(v)}
                      onSelect={() => isVerticalEnabled(v) && onVerticalChange(v)}
                    >
                      <DropdownMenu.ItemLabel>
                        {verticalLabel(v)}
                        {!isVerticalEnabled(v) && " · скоро"}
                      </DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  )}
                </For>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
        <nav class="ourapp-landing__nav" aria-label="Разделы">
          <For each={navItems()}>
            {(item) => (
              <button
                type="button"
                class="ourapp-navpill"
                classList={{ "ourapp-navpill--active": props.active === item.id }}
                data-hint={`home-nav-${item.id}`}
                aria-current={props.active === item.id ? "page" : undefined}
                onClick={() => navigate(item.path)}
              >
                {item.label}
              </button>
            )}
          </For>
        </nav>
      </div>

      <div class="ourapp-topbar__right">
        <Show when={limits()}>
          <button
            type="button"
            class="ourapp-topbar__credits"
            data-hint="home-credits"
            title="Остаток кредитов в этом месяце — подробнее на странице «Кредиты»"
            onClick={() => navigate("/credits")}
          >
            <span class="ourapp-topbar__creditsbar" aria-hidden="true">
              <span class="ourapp-topbar__creditsfill" style={{ width: `${creditsPct()}%` }} />
            </span>
            <span class="ourapp-topbar__creditstext">
              {creditsRemaining().toLocaleString("ru")} из {creditsTotal().toLocaleString("ru")}
            </span>
          </button>
        </Show>
        <button
          type="button"
          class="ourapp-topbar__account"
          classList={{ "ourapp-topbar__account--active": props.active === "settings" }}
          data-hint="home-account"
          title="Настройки аккаунта"
          onClick={() => navigate("/settings")}
        >
          {me()?.user.email ?? "Настройки"}
        </button>
      </div>
    </header>
  )
}

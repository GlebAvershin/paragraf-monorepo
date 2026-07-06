/**
 * OurApp AppTopbar — единая шапка для всех страниц приложения.
 *
 * Раньше у каждой страницы (Home/Credits/Settings/History/Analytics/Help) была
 * своя вёрстка шапки (разный паддинг, фон, набор кнопок) — при переходе между
 * страницами шапка визуально «прыгала» (цвет/ширина/текст). Теперь одна шапка,
 * меняется только подсвеченный пункт nav.
 */
import { createSignal, For, type Component } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { isVerticalEnabled, loadVertical, saveVertical, VERTICAL_ORDER, verticalLabel, type Vertical } from "./verticals"

export type AppTopbarActive = "home" | "credits" | "history" | "analytics" | "settings" | "help"

const NAV_ITEMS: Array<{ id: AppTopbarActive; label: string; path: string }> = [
  { id: "home", label: "Главная", path: "/" },
  { id: "credits", label: "Кредиты", path: "/credits" },
  { id: "history", label: "История", path: "/history" },
  { id: "analytics", label: "Аналитика", path: "/analytics" },
  { id: "settings", label: "Настройки", path: "/settings" },
  { id: "help", label: "Помощь", path: "/help" },
]

export const AppTopbar: Component<{ active: AppTopbarActive }> = (props) => {
  const navigate = useNavigate()
  const [vertical, setVertical] = createSignal<Vertical>(loadVertical())
  const [menuOpen, setMenuOpen] = createSignal(false)

  const onVerticalChange = (v: Vertical) => {
    setVertical(v)
    saveVertical(v)
    // Другие компоненты (напр. hero на Home) держат свою копию текущей
    // вертикали — уведомляем через window-event, тот же паттерн, что и
    // "ourapp:session-changed" в onboarding-gate.tsx.
    window.dispatchEvent(new Event("ourapp:vertical-changed"))
  }

  return (
    <header class="ourapp-landing__topbar">
      <div class="ourapp-landing__brandgroup">
        <div class="ourapp-landing__brand">
          <span class="ourapp-landing__brandname">Isaac</span>
          <DropdownMenu gutter={4} placement="bottom-start" open={menuOpen()} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger
              as="button"
              type="button"
              class="ourapp-landing__vertical"
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
          <For each={NAV_ITEMS}>
            {(item) => (
              <button
                type="button"
                class="ourapp-navpill"
                classList={{ "ourapp-navpill--active": props.active === item.id }}
                aria-current={props.active === item.id ? "page" : undefined}
                onClick={() => navigate(item.path)}
              >
                {item.label}
              </button>
            )}
          </For>
        </nav>
      </div>
    </header>
  )
}

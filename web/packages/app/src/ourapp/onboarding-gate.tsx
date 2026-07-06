/**
 * OurApp OnboardingGate — корневой gate для проверки авторизации.
 *
 * Если у пользователя нет сохранённого JWT (auth-storage) → рендерим
 * OnboardingPage. Иначе пропускаем children (нормальный роутер с Home/Session).
 *
 * Подписка на window-event `ourapp:session-changed` — после verify токена
 * onboarding-страница диспатчит, gate авто-перерисовывается.
 */
import { createEffect, createSignal, onCleanup, onMount, Show, type JSX, type Component } from "solid-js"
import { isLoggedIn } from "./auth-storage"
import { OnboardingPage } from "./onboarding-page"

export const OnboardingGate: Component<{ children: JSX.Element }> = (props) => {
  const [loggedIn, setLoggedIn] = createSignal(isLoggedIn())

  // Gate сидит ВЫШЕ Router'а (app.tsx), поэтому useNavigate() здесь недоступен —
  // адрес-бар остаётся тем, каким был до логина (напр. "/settings" из закладки
  // или из-под которого разлогинились), хотя рендерится форма входа. Нормализуем
  // на "/" через History API напрямую. createEffect (не onMount!) — gate не
  // перемонтируется при логауте из уже открытого приложения, меняется только
  // сигнал loggedIn, поэтому одноразовой проверки на mount недостаточно.
  createEffect(() => {
    if (!loggedIn() && window.location.pathname !== "/") {
      window.history.replaceState(null, "", "/")
    }
  })

  onMount(() => {
    const onChanged = () => setLoggedIn(isLoggedIn())
    window.addEventListener("ourapp:session-changed", onChanged)
    onCleanup(() => window.removeEventListener("ourapp:session-changed", onChanged))
  })

  return (
    <Show when={loggedIn()} fallback={<OnboardingPage onDone={() => setLoggedIn(true)} />}>
      {props.children}
    </Show>
  )
}

/**
 * Isaac sign-in screen for the legal and accounting workflows.
 */
import { createSignal, Show, type Component } from "solid-js"
import { billingApi } from "./billing-api"
import { setSessionToken } from "./auth-storage"
import { usePlatform } from "@/context/platform"
import { resetHintTours } from "./hint-tour"

export const OnboardingPage: Component<{ onDone: () => void }> = (props) => {
  const platform = usePlatform()
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const login = async (e: Event) => {
    e.preventDefault()
    setError(null)
    const emailValue = email().trim()
    const passwordValue = password()
    if (!emailValue.includes("@")) {
      setError("Введите корректный email")
      return
    }
    if (!passwordValue) {
      setError("Введите пароль")
      return
    }
    setBusy(true)
    const res = await billingApi.login(emailValue, passwordValue)
    setBusy(false)
    if (!res.ok) {
      setError(
        res.error === "invalid_credentials"
          ? "Неверный email или пароль"
          : `Не удалось войти: ${res.error}`,
      )
      return
    }
    setSessionToken(res.data.token)
    // Онбординг-подсказки показываем на КАЖДЫЙ вход: сбрасываем флаги
    // «тур просмотрен» — после reload туры на главной и в воркспейсе
    // запустятся заново.
    resetHintTours()
    // На вебе пароль соединения с движком берётся из сохранённого JWT при
    // bootstrap (entry.tsx). Соединение уже создано без пароля → перезагружаем,
    // чтобы entry.tsx пересобрал его с JWT. На desktop (sidecar-auth) — обычный
    // callback без reload.
    if (platform.platform === "web") {
      window.location.reload()
      return
    }
    props.onDone()
  }

  return (
    <div class="ourapp-onboarding">
      <header class="ourapp-onboarding__topbar">
        <span class="ourapp-onboarding__brand">Isaac</span>
      </header>

      <main class="ourapp-onboarding__main">
        <form class="ourapp-onboarding__step" onSubmit={login}>
          <h1 class="ourapp-onboarding__title">
            ИИ-помощник <span>для юристов и бухгалтеров</span>
          </h1>
          <p class="ourapp-onboarding__lede">
            Работайте с договорами, претензиями, первичными документами и требованиями
            ФНС в готовых сценариях или в обычном чате.
          </p>

          <div class="ourapp-onboarding__field">
            <label class="ourapp-onboarding__label" for="onb-email">
              Email
            </label>
            <input
              id="onb-email"
              type="email"
              class="ourapp-onboarding__input"
              placeholder="name@company.ru"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              ref={(el) => setTimeout(() => el?.focus(), 50)}
              disabled={busy()}
              autocomplete="username"
            />
          </div>
          <div class="ourapp-onboarding__field">
            <label class="ourapp-onboarding__label" for="onb-password">
              Пароль
            </label>
            <input
              id="onb-password"
              type="password"
              class="ourapp-onboarding__input"
              placeholder="••••••••"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              disabled={busy()}
              autocomplete="current-password"
            />
          </div>

          <Show when={error()}>
            <div class="ourapp-onboarding__error">{error()}</div>
          </Show>

          <div class="ourapp-onboarding__actions">
            <button
              type="submit"
              class="ourapp-btn ourapp-btn--primary"
              disabled={busy() || !email().includes("@") || !password()}
            >
              {busy() ? "Входим…" : "Войти →"}
            </button>
          </div>
          <p class="ourapp-onboarding__access-note">
            Нет аккаунта? Для получения доступа напишите на{" "}
            <a href="mailto:isaac.tech.russia@yandex.com">isaac.tech.russia@yandex.com</a>.
          </p>
        </form>
      </main>
    </div>
  )
}

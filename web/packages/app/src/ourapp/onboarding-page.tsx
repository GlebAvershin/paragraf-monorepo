/**
 * OurApp вход — email + пароль (демо/тест-период, 2026-07-01).
 *
 * Раньше здесь был двухдверный онбординг (выбор вертикали → OTP-код на email).
 * На тест-период вертикаль всегда одна (Технолог, см. verticals.ts), а вместо
 * рассылки OTP на каждый вход — общий тестовый аккаунт с паролем
 * (billing /auth/login, параллельный OTP способ входа). Backend-код OTP не
 * тронут — просто эта страница его больше не вызывает.
 */
import { createSignal, Show, type Component } from "solid-js"
import { billingApi } from "./billing-api"
import { setSessionToken } from "./auth-storage"
import { usePlatform } from "@/context/platform"
import { DotWaveBackground } from "./dot-wave-bg"

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
      <DotWaveBackground />
      <header class="ourapp-onboarding__topbar">
        <span class="ourapp-onboarding__brand">Isaac</span>
      </header>

      <main class="ourapp-onboarding__main">
        <form class="ourapp-onboarding__step" onSubmit={login}>
          <h1 class="ourapp-onboarding__title">
            ИИ-инфраструктура <span>для решения любых ваших задач</span>
          </h1>
          <p class="ourapp-onboarding__lede">
            Платформа для полного и удобного внедрения ИИ в производство.
          </p>

          <div class="ourapp-onboarding__field">
            <label class="ourapp-onboarding__label" for="onb-email">
              Email
            </label>
            <input
              id="onb-email"
              type="email"
              class="ourapp-onboarding__input"
              placeholder="isaac@test.test"
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

          <div class="ourapp-onboarding__foot">
            Нажимая, вы соглашаетесь с&nbsp;офертой и&nbsp;обработкой персональных данных (152-ФЗ).
          </div>
        </form>
      </main>
    </div>
  )
}

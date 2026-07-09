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
import { resetHintTours } from "./hint-tour"

export const OnboardingPage: Component<{ onDone: () => void }> = (props) => {
  const platform = usePlatform()
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // «Авторизация» — кнопка-шутка: некликабельна, убегает от курсора в случайное
  // место экрана. transform от базового слота, диапазон ограничен вьюпортом,
  // чтобы не улетала за край.
  let runaway: HTMLButtonElement | undefined
  const [flee, setFlee] = createSignal({ x: 0, y: 0 })
  const dodge = () => {
    const b = runaway?.getBoundingClientRect()
    if (!b) return
    const margin = 16
    const baseX = b.left - flee().x
    const baseY = b.top - flee().y
    const maxX = Math.max(margin, window.innerWidth - b.width - margin)
    const maxY = Math.max(margin, window.innerHeight - b.height - margin)
    const targetX = margin + Math.random() * (maxX - margin)
    const targetY = margin + Math.random() * (maxY - margin)
    setFlee({ x: targetX - baseX, y: targetY - baseY })
  }

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
            Isaac объединяет современные ИИ-модели, ваши документы и готовые рабочие
            сценарии в одном пространстве. Любой сотрудник — любая задача: спросите,
            загрузите, поручите — и получите готовый результат.
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
            <button
              ref={runaway}
              type="button"
              class="ourapp-btn ourapp-btn--primary ourapp-onboarding__runaway"
              style={{ transform: `translate(${flee().x}px, ${flee().y}px)` }}
              onMouseEnter={dodge}
              onPointerDown={(e) => {
                e.preventDefault()
                dodge()
              }}
              onClick={(e) => e.preventDefault()}
              tabindex={-1}
              aria-hidden="true"
            >
              Регистрация
            </button>
          </div>

        </form>
      </main>
    </div>
  )
}

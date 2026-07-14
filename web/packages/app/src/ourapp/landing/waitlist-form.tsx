/**
 * Waitlist-форма публичного лендинга. Email → `billingApi.waitlist` (публичный
 * идемпотентный роут billing `POST /waitlist`). Состояния: idle / busy / success
 * / error. Базовая клиентская валидация email; сервер валидирует повторно.
 *
 * Namespace классов — `.isaac-lp-*` (см. landing.css). Компонент самодостаточен,
 * не тянет server/session-контекст (лендинг рендерится без них).
 */
import { createSignal, Show } from "solid-js"
import { billingApi } from "@/ourapp/billing-api"
import { ACCESS } from "./copy"

type State = "idle" | "busy" | "success" | "error"

// Прагматичная проверка «похоже на email» — тот же уровень, что z.string().email()
// на сервере: не пытаемся быть строже RFC, лишь отсекаем явный мусор до запроса.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function WaitlistForm() {
  const [email, setEmail] = createSignal("")
  const [state, setState] = createSignal<State>("idle")
  const [error, setError] = createSignal("")

  const submit = async (e: Event) => {
    e.preventDefault()
    if (state() === "busy") return
    const value = email().trim()
    if (!EMAIL_RE.test(value)) {
      setError("Проверьте адрес — похоже, в нём опечатка.")
      setState("error")
      return
    }
    setState("busy")
    setError("")
    const res = await billingApi.waitlist(value)
    if (res.ok) {
      setState("success")
      return
    }
    setError("Не удалось отправить заявку. Попробуйте ещё раз чуть позже.")
    setState("error")
  }

  return (
    <Show
      when={state() !== "success"}
      fallback={
        <div class="isaac-lp-waitlist__done" role="status">
          <span class="isaac-lp-waitlist__done-mark" aria-hidden="true">
            ✓
          </span>
          <p class="isaac-lp-waitlist__done-title">Заявка принята</p>
          <p class="isaac-lp-waitlist__done-sub">Пришлём приглашение на указанный адрес.</p>
        </div>
      }
    >
      <form class="isaac-lp-waitlist" onSubmit={submit} novalidate>
        <label class="isaac-lp-waitlist__label" for="isaac-lp-email">
          {ACCESS.formLabel}
        </label>
        <div class="isaac-lp-waitlist__row">
          <input
            id="isaac-lp-email"
            class="isaac-lp-waitlist__input"
            type="email"
            inputmode="email"
            autocomplete="email"
            placeholder={ACCESS.formPlaceholder}
            value={email()}
            disabled={state() === "busy"}
            onInput={(ev) => {
              setEmail(ev.currentTarget.value)
              if (state() === "error") setState("idle")
            }}
            aria-invalid={state() === "error"}
          />
          <button class="isaac-lp-waitlist__submit" type="submit" disabled={state() === "busy"}>
            {state() === "busy" ? "Отправляем…" : ACCESS.ctaLabel}
          </button>
        </div>
        <Show when={state() === "error"}>
          <p class="isaac-lp-waitlist__error" role="alert">
            {error()}
          </p>
        </Show>
      </form>
    </Show>
  )
}

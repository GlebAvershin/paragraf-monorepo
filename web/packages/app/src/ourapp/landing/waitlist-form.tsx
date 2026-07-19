/**
 * Waitlist-форма публичного лендинга — ПОКА НЕАКТИВНА (по решению 2026-07-18).
 * Поле почты и кнопка показываются, но приём заявок отключён: input/кнопка
 * `disabled`, submit не вешается, `billingApi.waitlist` НЕ вызывается. Когда приём
 * откроют — вернуть отправку (см. историю git: было idle/busy/success/error →
 * billing `POST /waitlist`).
 *
 * Namespace классов — `.isaac-lp-*` (см. landing.css). Компонент самодостаточен,
 * не тянет server/session-контекст (лендинг рендерится без них).
 */
import { ACCESS } from "./copy"

export function WaitlistForm() {
  return (
    // Не <form>: submit намеренно недоступен, ничего никуда не уходит.
    <div class="isaac-lp-waitlist" aria-disabled="true">
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
          disabled
          tabindex={-1}
          aria-hidden="true"
        />
        <button class="isaac-lp-waitlist__submit" type="button" disabled tabindex={-1} aria-hidden="true">
          {ACCESS.ctaLabel}
        </button>
      </div>
    </div>
  )
}

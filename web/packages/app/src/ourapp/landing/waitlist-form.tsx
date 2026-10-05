/**
 * Доступ на публичном лендинге оформляется через поддержку.
 * Самостоятельная регистрация и вызов `billingApi.waitlist` остаются отключены.
 *
 * Namespace классов — `.isaac-lp-*` (см. landing.css). Компонент самодостаточен,
 * не тянет server/session-контекст (лендинг рендерится без них).
 */
import { ACCESS } from "./copy"

export function WaitlistForm() {
  return (
    <div class="isaac-lp-waitlist">
      <a class="isaac-lp-btn isaac-lp-btn--primary isaac-lp-btn--lg" href="mailto:isaac.tech.russia@yandex.com">
        {ACCESS.ctaLabel}
      </a>
      <p class="isaac-lp-waitlist__contact">isaac.tech.russia@yandex.com</p>
    </div>
  )
}

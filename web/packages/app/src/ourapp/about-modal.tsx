/**
 * OurApp — модалка «О Isaac».
 *
 * Показывает название продукта, версию, назначение, юридические ссылки
 * (152-ФЗ обязателен), контакты поддержки. Открывается из Settings.
 */
import { Show, type Component } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"

// Версия берётся из Vite define или package.json через import.meta.env.
const APP_VERSION =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_OURAPP_VERSION) ||
  "0.1.0"

const SUPPORT_EMAIL = "isaac.tech.russia@yandex.com"
const SITE_URL = "https://isaac-ai.ru"
const OFFER_URL = "https://isaac-ai.ru/offer"
const PRIVACY_URL = "https://isaac-ai.ru/privacy"

export interface AboutModalProps {
  open: boolean
  onClose: () => void
}

export const AboutModal: Component<AboutModalProps> = (props) => {
  const openLink = (url: string) => {
    if (typeof window !== "undefined" && "api" in window) {
      const api = (window as { api?: { openLink?: (u: string) => void } }).api
      if (api?.openLink) {
        api.openLink(url)
        return
      }
    }
    window.open(url, "_blank")
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
        onClick={props.onClose}
      >
        <div
          class="ourapp-about-modal"
          role="dialog"
          aria-modal="true"
          aria-label="О Isaac"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            class="ourapp-about-modal__close"
            aria-label="Закрыть"
            onClick={props.onClose}
          >
            <Icon name="close" class="size-4" />
          </button>

          <div class="ourapp-about-modal__brand">
            <h2 class="ourapp-about-modal__title">Isaac</h2>
            <p class="ourapp-about-modal__version">Версия {APP_VERSION}</p>
          </div>

          <p class="ourapp-about-modal__lede">
            ИИ-агент для профессионалов. Разбирает ГОСТы и стандарты, проверяет документы
            на соответствие — по готовым сценариям под вашу профессию.
          </p>

          <div class="ourapp-about-modal__links">
            <button type="button" class="ourapp-about-modal__link" onClick={() => openLink(SITE_URL)}>
              Сайт
            </button>
            <button type="button" class="ourapp-about-modal__link" onClick={() => openLink(OFFER_URL)}>
              Оферта
            </button>
            <button type="button" class="ourapp-about-modal__link" onClick={() => openLink(PRIVACY_URL)}>
              Политика конфиденциальности
            </button>
          </div>

          <div class="ourapp-about-modal__support">
            Поддержка:{" "}
            <button
              type="button"
              class="ourapp-about-modal__link"
              onClick={() => openLink(`mailto:${SUPPORT_EMAIL}`)}
            >
              {SUPPORT_EMAIL}
            </button>
          </div>

          <p class="ourapp-about-modal__copyright">© {new Date().getFullYear()} Isaac. Все права защищены.</p>
        </div>
      </div>
    </Show>
  )
}

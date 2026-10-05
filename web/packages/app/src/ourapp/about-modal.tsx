/**
 * OurApp — модалка «О Isaac».
 *
 * Показывает название продукта, версию, назначение, юридические ссылки
 * (152-ФЗ обязателен), контакты поддержки. Открывается из Settings.
 */
import { type Component } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
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
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <div class="fixed inset-0 z-50 flex items-center justify-center">
          <Dialog.Overlay class="absolute inset-0 bg-black/40" />
          <Dialog.Content class="ourapp-about-modal" aria-label="О Isaac">
            <button
              type="button"
              class="ourapp-about-modal__close"
              aria-label="Закрыть"
              onClick={props.onClose}
            >
              <Icon name="close" class="size-4" />
            </button>

            <div class="ourapp-about-modal__brand">
              <Dialog.Title as="h2" class="ourapp-about-modal__title">
                Isaac
              </Dialog.Title>
              <p class="ourapp-about-modal__version">Версия {APP_VERSION}</p>
            </div>

            <Dialog.Description as="p" class="ourapp-about-modal__lede">
              Рабочее пространство с ИИ для юристов и бухгалтеров. Анализ документов,
              подготовка договоров и работа с налоговыми вопросами — в чате и готовых сценариях.
            </Dialog.Description>

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
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

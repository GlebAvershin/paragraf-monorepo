/**
 * Email sender.
 * In development (SMTP_HOST empty) — logs the email to console.
 * In production — sends via SMTP using nodemailer.
 */
import nodemailer from "nodemailer"
import { config } from "../config.ts"
import { logger } from "./logger.ts"

let transporter: nodemailer.Transporter | null = null
let verifyStarted = false

function getTransporter(): nodemailer.Transporter | null {
  if (!config.SMTP_HOST) return null
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    // 465 — implicit TLS; 587/прочие — STARTTLS (nodemailer апгрейдит сам).
    secure: config.SMTP_PORT === 465,
    // Реальный провайдер (есть SMTP_USER) на не-465 порту: ТРЕБУЕМ STARTTLS —
    // OTP-коды/уведомления не должны уходить открытым текстом (152-ФЗ). Локальный
    // Mailpit (dev, без auth) не трогаем — иначе незашифрованная отправка упадёт.
    requireTLS: config.SMTP_PORT !== 465 && Boolean(config.SMTP_USER),
    auth:
      config.SMTP_USER && config.SMTP_PASSWORD
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
        : undefined,
  })
  // Разовая проверка соединения: в логах сразу видно, корректно ли настроен
  // SMTP (особенно в проде) — иначе сбой всплывёт только при первом письме.
  if (!verifyStarted) {
    verifyStarted = true
    transporter.verify().then(
      () => logger.info({ host: config.SMTP_HOST, port: config.SMTP_PORT }, "SMTP transporter verified"),
      (err) =>
        logger.error(
          { err, host: config.SMTP_HOST, port: config.SMTP_PORT },
          "SMTP verify failed — emails may not be delivered",
        ),
    )
  }
  return transporter
}

export interface EmailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const t = getTransporter()
  if (!t) {
    logger.warn(
      { to: msg.to, subject: msg.subject, text: msg.text },
      "SMTP not configured — email logged to console (development mode)",
    )
    return
  }
  const info = await t.sendMail({
    from: config.SMTP_FROM,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  })
  logger.info({ to: msg.to, subject: msg.subject, messageId: info.messageId }, "Email sent")
}

export function magicLinkEmail(email: string, otp: string): EmailMessage {
  // OTP с пробелом для удобства чтения и копирования: "482 173"
  const otpPretty = `${otp.slice(0, 3)} ${otp.slice(3)}`
  return {
    to: email,
    subject: `Код для входа: ${otpPretty}`,
    text: [
      "Здравствуйте!",
      "",
      "Код для входа в приложение Isaac:",
      "",
      `  ${otpPretty}`,
      "",
      "Введите его в окне «Проверьте почту» в приложении на компьютере.",
      "Код действует 15 минут.",
      "",
      "Если вы не запрашивали вход — просто проигнорируйте это письмо.",
    ].join("\n"),
    html: `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, system-ui, sans-serif; background:#FBF9F4; color:#2A2723; padding:32px;">
  <div style="max-width:480px; margin:0 auto; background:#fff; border:1px solid #D8D2C5; border-radius:8px; padding:32px;">
    <h1 style="font-family:'IBM Plex Serif',Georgia,serif; font-weight:500; font-size:22px; margin:0 0 16px;">
      Вход в Isaac
    </h1>
    <p style="color:#5C5852; line-height:1.6; margin:0 0 24px;">
      Введите этот код в&nbsp;окне «Проверьте почту» в&nbsp;приложении на&nbsp;компьютере:
    </p>
    <div style="background:#F6F2EB; border:1px solid #D8D2C5; border-radius:8px; padding:20px; text-align:center; margin:0 0 24px;">
      <div style="font-family:'JetBrains Mono', Consolas, monospace; font-size:32px; letter-spacing:8px; color:#0B5345; font-weight:600;">
        ${otpPretty}
      </div>
    </div>
    <p style="color:#5C5852; font-size:13px; line-height:1.6; margin:0;">
      Код действует 15 минут. Если вы не запрашивали вход — просто проигнорируйте это письмо.
    </p>
  </div>
</body>
</html>`.trim(),
  }
}

// ===== Платёжные уведомления (ТЗ-02) =====

/** Базовая HTML-обёртка письма в фирменном стиле Isaac. */
function brandedHtml(title: string, bodyHtml: string): string {
  return `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, system-ui, sans-serif; background:#FBF9F4; color:#2A2723; padding:32px;">
  <div style="max-width:480px; margin:0 auto; background:#fff; border:1px solid #D8D2C5; border-radius:8px; padding:32px;">
    <h1 style="font-family:'IBM Plex Serif',Georgia,serif; font-weight:500; font-size:22px; margin:0 0 16px;">
      ${title}
    </h1>
    ${bodyHtml}
  </div>
</body>
</html>`.trim()
}

/** Формат суммы из копеек в «1 290 ₽». */
function formatRub(amountKopeck: number): string {
  const rub = Math.round(amountKopeck) / 100
  return `${rub.toLocaleString("ru-RU")} ₽`
}

/** Письмо «Платёж прошёл». */
export function paymentSucceededEmail(params: {
  to: string
  amountKopeck: number
  description: string
  creditsAdded?: number
  newBalance?: number
}): EmailMessage {
  const amount = formatRub(params.amountKopeck)
  const creditsLine =
    params.creditsAdded != null
      ? `Начислено кредитов: ${params.creditsAdded.toLocaleString("ru-RU")}.`
      : ""
  const balanceLine =
    params.newBalance != null
      ? `Текущий баланс: ${params.newBalance.toLocaleString("ru-RU")} кредитов.`
      : ""
  return {
    to: params.to,
    subject: `Платёж прошёл — ${amount}`,
    text: [
      "Здравствуйте!",
      "",
      `Платёж на ${amount} успешно прошёл.`,
      params.description,
      creditsLine,
      balanceLine,
      "",
      "Спасибо, что пользуетесь Isaac.",
    ]
      .filter(Boolean)
      .join("\n"),
    html: brandedHtml(
      "Платёж прошёл",
      `
      <p style="color:#5C5852; line-height:1.6; margin:0 0 16px;">
        Платёж на <strong style="color:#2A2723;">${amount}</strong> успешно прошёл.<br/>
        ${params.description}
      </p>
      ${creditsLine ? `<p style="color:#0B5345; font-weight:500; margin:0 0 8px;">${creditsLine}</p>` : ""}
      ${balanceLine ? `<p style="color:#5C5852; margin:0;">${balanceLine}</p>` : ""}`,
    ),
  }
}

/** Письмо «Не удалось списать оплату». */
export function paymentFailedEmail(params: {
  to: string
  amountKopeck: number
  reason: string
  attemptNumber?: number
}): EmailMessage {
  const amount = formatRub(params.amountKopeck)
  const attemptLine =
    params.attemptNumber != null ? `Попытка ${params.attemptNumber} из 3.` : ""
  return {
    to: params.to,
    subject: `Не удалось списать оплату — ${amount}`,
    text: [
      "Здравствуйте!",
      "",
      `Мы не смогли списать ${amount}.`,
      `Причина: ${params.reason}.`,
      attemptLine,
      "",
      "Проверьте карту в приложении Isaac на странице «Кредиты и подписка».",
      "Если в течение 7 дней оплата не пройдёт — подписка приостановится.",
    ]
      .filter(Boolean)
      .join("\n"),
    html: brandedHtml(
      "Не удалось списать оплату",
      `
      <p style="color:#5C5852; line-height:1.6; margin:0 0 16px;">
        Мы не смогли списать <strong style="color:#2A2723;">${amount}</strong>.<br/>
        Причина: ${params.reason}.<br/>
        ${attemptLine}
      </p>
      <p style="color:#5C5852; line-height:1.6; margin:0;">
        Проверьте карту на странице «Кредиты и подписка». Если в течение 7 дней
        оплата не пройдёт — подписка приостановится.
      </p>`,
    ),
  }
}

/** Письмо «Подписка приостановлена». */
export function subscriptionExpiredEmail(params: { to: string; planTitleRu: string }): EmailMessage {
  return {
    to: params.to,
    subject: "Подписка Isaac приостановлена",
    text: [
      "Здравствуйте!",
      "",
      `Подписка «${params.planTitleRu}» приостановлена — оплату не удалось провести за 7 дней.`,
      "",
      "Чтобы возобновить работу — привяжите карту и оплатите подписку заново",
      "на странице «Кредиты и подписка» в приложении.",
    ].join("\n"),
    html: brandedHtml(
      "Подписка приостановлена",
      `
      <p style="color:#5C5852; line-height:1.6; margin:0 0 16px;">
        Подписка «<strong style="color:#2A2723;">${params.planTitleRu}</strong>» приостановлена —
        оплату не удалось провести за 7 дней.
      </p>
      <p style="color:#5C5852; line-height:1.6; margin:0;">
        Чтобы возобновить работу — привяжите карту и оплатите подписку заново
        на странице «Кредиты и подписка».
      </p>`,
    ),
  }
}

/** Письмо «Тариф изменён». */
export function planChangedEmail(params: {
  to: string
  fromTitleRu: string
  toTitleRu: string
  /** true — upgrade применён сразу; false — downgrade с начала след. периода. */
  immediate: boolean
  effectiveDate?: Date
}): EmailMessage {
  const when = params.immediate
    ? "Изменение действует сразу."
    : `Изменение вступит в силу ${params.effectiveDate?.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) ?? "в начале следующего периода"}.`
  return {
    to: params.to,
    subject: `Тариф изменён: ${params.fromTitleRu} → ${params.toTitleRu}`,
    text: [
      "Здравствуйте!",
      "",
      `Тариф изменён: «${params.fromTitleRu}» → «${params.toTitleRu}».`,
      when,
    ].join("\n"),
    html: brandedHtml(
      "Тариф изменён",
      `
      <p style="color:#5C5852; line-height:1.6; margin:0 0 8px;">
        Тариф изменён: «${params.fromTitleRu}» → «<strong style="color:#0B5345;">${params.toTitleRu}</strong>».
      </p>
      <p style="color:#5C5852; line-height:1.6; margin:0;">${when}</p>`,
    ),
  }
}

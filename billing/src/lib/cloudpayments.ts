/**
 * CloudPayments REST API client.
 *
 * Docs: https://developers.cloudpayments.ru/#api
 *
 * Auth: HTTP Basic — username = Public ID, password = API Secret.
 * Base URL: https://api.cloudpayments.ru (configurable for test mode).
 *
 * Поток платежей в «Параграфе»:
 *   1. Первичная привязка карты — виджет на фронте генерирует cryptogram
 *      (с 3DS-подтверждением). Backend делает cards/auth на 1 ₽ + void
 *      (валидация карты без реального списания).
 *   2. Рекурренты (докупки, продление подписки) — tokens/charge по сохранённому
 *      токену, без 3DS.
 *
 * Все суммы в API CloudPayments передаются в рублях (decimal), НЕ в копейках.
 * Внутри биллинга деньги храним в копейках — конвертация здесь, на границе.
 *
 * ВНИМАНИЕ: cryptogram и token — чувствительные данные. Никогда не логируем
 * их значения (см. logger redaction).
 */
import { config } from "../config.ts"
import { logger } from "./logger.ts"

/** Стандартная обёртка ответа CloudPayments. */
export interface CloudPaymentsResponse<TModel = Record<string, unknown>> {
  /** true — операция прошла; false — отказ (см. Model.Reason / Message). */
  Success: boolean
  /** Текст ошибки (для Success=false). */
  Message: string | null
  /** Полезная нагрузка (TransactionId, Token, CardLastFour, ...). */
  Model?: TModel
}

export interface CloudPaymentsTransactionModel {
  TransactionId?: number
  /** Рекуррентный токен для последующих tokens/charge. */
  Token?: string
  CardLastFour?: string
  /** 'Visa' | 'MasterCard' | 'MIR' | 'Maestro' | ... */
  CardType?: string
  /** 'MM/YY' */
  CardExpDate?: string
  /** Код ошибки CloudPayments (5051 — недостаточно средств, и т.п.). */
  ReasonCode?: number
  Reason?: string
  Amount?: number
  Currency?: string
  /** Для 3DS — присутствует AcsUrl/PaReq (рекурренты по токену их не возвращают). */
  PaReq?: string
  AcsUrl?: string
  /** Признак, что нужно 3DS-подтверждение. */
  ThreeDsCallbackId?: string
}

export interface CardsAuthParams {
  /** Сумма в рублях (например, 1 для тестового холда). */
  amountRub: number
  currency?: string
  /** base64-cryptogram из CloudPayments Widget. */
  cryptogram: string
  /** Наш идентификатор плательщика (users.id) — нужен для рекуррентов. */
  accountId: string
  /** Назначение платежа (показывается в выписке/чеке). */
  description: string
  invoiceId?: string
  ipAddress?: string
  email?: string
  /** true — сохранить карту для рекуррентов (вернётся Token). */
  saveCard?: boolean
}

export interface TokensChargeParams {
  amountRub: number
  currency?: string
  /** Сохранённый рекуррентный токен. */
  token: string
  accountId: string
  description: string
  invoiceId: string
  email?: string
  jsonData?: Record<string, unknown>
}

export class CloudPaymentsError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message)
    this.name = "CloudPaymentsError"
  }
}

class CloudPaymentsClient {
  private readonly authHeader: string

  constructor(
    private readonly baseUrl: string,
    publicId: string,
    apiSecret: string,
    /** В test-режиме клиент не падает при пустых ключах (для dev). */
    public readonly configured: boolean,
  ) {
    this.authHeader = "Basic " + Buffer.from(`${publicId}:${apiSecret}`).toString("base64")
  }

  private async request<TModel = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<CloudPaymentsResponse<TModel>> {
    if (!this.configured) {
      throw new CloudPaymentsError("CloudPayments is not configured (missing keys)", 503, null)
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }

    if (!res.ok) {
      throw new CloudPaymentsError(
        `CloudPayments ${path} failed: HTTP ${res.status}`,
        res.status,
        parsed,
      )
    }

    // Не логируем тело целиком (может содержать чувствительные поля).
    const resp = parsed as CloudPaymentsResponse<TModel>
    logger.debug(
      { path, success: resp?.Success, message: resp?.Message },
      "CloudPayments response",
    )
    return resp
  }

  /**
   * Авторизация (холд) по криптограмме карты. Используется для:
   *   - первичной валидации карты (amount=1, потом void),
   *   - сохранения рекуррентного токена (saveCard=true).
   *
   * Для современных карт может вернуть Success=false + AcsUrl (требуется 3DS) —
   * но в нашем потоке 3DS уже пройден в виджете на фронте, поэтому сюда
   * приходит уже подтверждённая криптограмма.
   */
  async cardsAuth(
    params: CardsAuthParams,
  ): Promise<CloudPaymentsResponse<CloudPaymentsTransactionModel>> {
    return await this.request<CloudPaymentsTransactionModel>("/payments/cards/auth", {
      Amount: params.amountRub,
      Currency: params.currency ?? "RUB",
      IpAddress: params.ipAddress ?? "127.0.0.1",
      CardCryptogramPacket: params.cryptogram,
      AccountId: params.accountId,
      Description: params.description,
      InvoiceId: params.invoiceId,
      Email: params.email,
      // saveCard / SaveCard — попросить вернуть рекуррентный токен.
      SaveCard: params.saveCard ?? true,
    })
  }

  /**
   * Отмена холда (возврат заблокированной суммы) по TransactionId.
   * Используем сразу после cards/auth при привязке карты на 1 ₽.
   */
  async voidPayment(transactionId: number): Promise<CloudPaymentsResponse> {
    return await this.request("/payments/void", { TransactionId: transactionId })
  }

  /**
   * Рекуррентное списание по сохранённому токену (без 3DS).
   * Используется для докупок кредитов, продления подписки и доплат при upgrade.
   */
  async tokensCharge(
    params: TokensChargeParams,
  ): Promise<CloudPaymentsResponse<CloudPaymentsTransactionModel>> {
    return await this.request<CloudPaymentsTransactionModel>("/payments/tokens/charge", {
      Amount: params.amountRub,
      Currency: params.currency ?? "RUB",
      AccountId: params.accountId,
      Token: params.token,
      InvoiceId: params.invoiceId,
      Description: params.description,
      Email: params.email,
      JsonData: params.jsonData,
    })
  }
}

const publicId = config.CLOUDPAYMENTS_PUBLIC_ID ?? ""
const apiSecret = config.CLOUDPAYMENTS_API_SECRET ?? ""
const configured = publicId.length > 0 && apiSecret.length > 0

if (!configured) {
  logger.warn(
    "CloudPayments keys not set — payment endpoints will return 503. Set CLOUDPAYMENTS_PUBLIC_ID / CLOUDPAYMENTS_API_SECRET.",
  )
}

export const cloudpayments = new CloudPaymentsClient(
  config.CLOUDPAYMENTS_API_URL,
  publicId,
  apiSecret,
  configured,
)

// ===== Helpers =====

/** Копейки → рубли (для отправки в CloudPayments API). */
export function kopeckToRub(kopeck: number): number {
  return Math.round(kopeck) / 100
}

/** Нормализация бренда карты CloudPayments → наш внутренний код. */
export function normalizeCardBrand(cardType: string | undefined | null): string | null {
  if (!cardType) return null
  const t = cardType.toLowerCase()
  if (t.includes("visa")) return "visa"
  if (t.includes("master")) return "mastercard"
  if (t.includes("mir") || t.includes("мир")) return "mir"
  if (t.includes("maestro")) return "maestro"
  return t
}

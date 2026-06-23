/**
 * Клиент billing: движок берёт litellm-ключ юзера, чтобы звать шлюз от его имени
 * (бюджет/кредиты считаются per-user по этому ключу — как в desktop через провайдер).
 */
import { config } from "./config.ts"

interface MeResponse {
  subscription?: { litellmKey?: string } | null
}

/** Вернуть litellm virtual_key юзера по его JWT (или null, если нет подписки/ключа). */
export async function getLitellmKey(userJwt: string): Promise<string | null> {
  const res = await fetch(`${config.BILLING_URL}/me`, {
    headers: { authorization: `Bearer ${userJwt}` },
  }).catch(() => null)
  if (!res || !res.ok) return null
  const data = (await res.json().catch(() => null)) as MeResponse | null
  return data?.subscription?.litellmKey ?? null
}

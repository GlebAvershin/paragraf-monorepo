/**
 * Клиент gost-rag (база знаний ГОСТ). Помощник инженера заземляет ответы: движок дёргает /retrieve,
 * получает выдержки из стандартов (`context`) для системного промпта и резолвленные источники
 * (`sources`) для UI. Генерацию НЕ переносим сюда — она остаётся на шлюзе с ключом юзера (биллинг).
 *
 * Деградация мягкая: при недоступности сервиса возвращаем null → движок отвечает БЕЗ заземления,
 * а не падает (engineer-ассистент не должен умолкать из-за того, что gost-rag прилёг).
 */
import { config } from "./config.ts"

/** Источник для UI — совпадает со schema.Source бэкенда и web Source (source-viewer.tsx). */
export interface GostSource {
  doc_id: string
  title?: string
  clause_path?: string
  quote?: string
  view: { kind: string; url?: string; mime?: string; page?: number | null }
  available: boolean
}

export interface GostRetrieval {
  context: string
  top_score: number
  chunks: Array<{ gost_id: string; clause_path: string; score: number }>
  sources: GostSource[]
  /** Чем планнер разбил запрос в deep-режиме ([] / отсутствует = одиночный путь). */
  sub_queries?: string[]
}

const TIMEOUT_MS = 15_000 // retrieve = эмбеддинг запроса + поиск в Qdrant, должно быть быстро
// deep = ещё и планнер-вызов LLM (декомпозиция) + ретрив на под-вопрос; gost-rag сам падает в
// одиночный путь по своему таймауту планнера, так что этот лимит — верхняя страховка.
const DEEP_TIMEOUT_MS = 30_000

/** Ретрив выдержек ГОСТ под запрос. null ⇒ сервис недоступен/ошибка (движок деградирует без
 *  заземления). deep (тир Ultra) — декомпозиция на под-вопросы + fusion на стороне gost-rag;
 *  userKey — litellm-ключ юзера: планнер-вызов оплачивается его кредитами. */
export async function retrieveGost(
  query: string,
  topK?: number,
  opts?: { deep?: boolean; userKey?: string },
): Promise<GostRetrieval | null> {
  const deep = !!opts?.deep && !!opts?.userKey
  const res = await fetch(`${config.GOST_RAG_URL}/retrieve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query,
      ...(topK ? { top_k: topK } : {}),
      ...(deep ? { deep: true, user_key: opts?.userKey } : {}),
    }),
    signal: AbortSignal.timeout(deep ? DEEP_TIMEOUT_MS : TIMEOUT_MS),
  }).catch(() => null)
  if (!res || !res.ok) return null
  return (await res.json().catch(() => null)) as GostRetrieval | null
}

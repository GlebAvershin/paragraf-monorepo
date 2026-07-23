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

// Общий секрет с gost-rag: шлём его заголовком X-Internal-Key, gost-rag принимает /retrieve и
// /sources только с ним. Пусто (dev) → заголовок не шлём. Тот же паттерн, что ANSWER_SECRET у шлюза.
const internalKeyHeaders = (): Record<string, string> =>
  config.GOST_RAG_INTERNAL_KEY ? { "x-internal-key": config.GOST_RAG_INTERNAL_KEY } : {}

const TIMEOUT_MS = 15_000 // retrieve = эмбеддинг запроса + поиск в Qdrant, должно быть быстро
// deep = ещё и планнер-вызов LLM (декомпозиция) + ретрив на под-вопрос; gost-rag сам падает в
// одиночный путь по своему таймауту планнера, так что этот лимит — верхняя страховка.
const DEEP_TIMEOUT_MS = 30_000
const SOURCES_TIMEOUT_MS = 5_000 // /sources = чистый лукап по карте, без LLM/Qdrant

// Обозначение стандарта в тексте ответа — тот же паттерн, что extractSources() в web
// source-viewer.tsx (тире нормализуются в дефис, чтобы ключ совпал с картой источников).
const DESIGNATION = /(?:ГОСТ\s+Р|ГОСТ|СНиП|СанПиН|СП|ТР\s+ТС)\s+\d+(?:[.\-‐-―/]\d+)*/g

/** Уникальные обозначения ГОСТ/СП/… из текста ответа (для дорезолва «практических» ссылок). */
export function extractDesignations(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(DESIGNATION)) {
    seen.add(m[0].replace(/\s+/g, " ").replace(/[‐-―]/g, "-").trim())
  }
  return [...seen]
}

/** Резолв обозначений в просматриваемые источники (gost-rag POST /sources — лукап по карте).
 *  Fail-open: сервис недоступен/старый (без эндпоинта) ⇒ [] — плашки просто не дорезолвятся. */
export async function resolveSources(designations: string[]): Promise<GostSource[]> {
  if (designations.length === 0) return []
  const res = await fetch(`${config.GOST_RAG_URL}/sources`, {
    method: "POST",
    headers: { "content-type": "application/json", ...internalKeyHeaders() },
    body: JSON.stringify({ designations }),
    signal: AbortSignal.timeout(SOURCES_TIMEOUT_MS),
  }).catch(() => null)
  if (!res || !res.ok) return []
  const json = (await res.json().catch(() => null)) as { sources?: GostSource[] } | null
  return json?.sources ?? []
}

/** Ретрив выдержек ГОСТ под запрос. null ⇒ сервис недоступен/ошибка (движок деградирует без
 *  заземления). userKey (litellm-ключ юзера) шлём ВСЕГДА: эмбеддинг запроса и (в deep) планнер
 *  оплачиваются кредитами юзера — сервисного ключа нет (решение 2026-07-10; embedding-тир
 *  метрится без пола, см. billing computeCredits.floorCredits). deep (тир Ultra) — декомпозиция
 *  на под-вопросы + fusion на стороне gost-rag. */
export async function retrieveGost(
  query: string,
  topK?: number,
  opts?: { deep?: boolean; userKey?: string },
): Promise<GostRetrieval | null> {
  const deep = !!opts?.deep && !!opts?.userKey
  const res = await fetch(`${config.GOST_RAG_URL}/retrieve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...internalKeyHeaders() },
    body: JSON.stringify({
      query,
      ...(topK ? { top_k: topK } : {}),
      ...(opts?.userKey ? { user_key: opts.userKey } : {}),
      ...(deep ? { deep: true } : {}),
    }),
    signal: AbortSignal.timeout(deep ? DEEP_TIMEOUT_MS : TIMEOUT_MS),
  }).catch(() => null)
  if (!res || !res.ok) return null
  return (await res.json().catch(() => null)) as GostRetrieval | null
}

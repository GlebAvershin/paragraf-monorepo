/**
 * Ядро чата (engine): prompt → СЫРОЙ текст в gateway-app (РФ) → накопление частей
 * ассистента → SSE-события (контракт opencode).
 *
 * Движок БОЛЬШЕ не ходит в LiteLLM напрямую и не маскирует. Он шлёт сырой текст в
 * gateway-app (`ANSWER_URL`), который маскирует, выбирает/зовёт модель, валидирует (ML)
 * и демаскирует. Движок хранит сообщения (РФ), гейтит кредиты и релеит стрим в браузер.
 * См. docs/arch-migration.md.
 */
import { config } from "./config.ts"
import { publish } from "./bus.ts"
import { getLitellmKey } from "./billing.ts"
import { extractDesignations, resolveSources, retrieveGost, type GostSource } from "./gostrag.ts"
import { getSession, updateSession } from "./sessions.ts"
import {
  historyForGateway,
  insertMessage,
  insertPart,
  newId,
  updateMessage,
  updatePart,
  type StoredMessage,
  type StoredPart,
} from "./messages.ts"

// Активные генерации — по ключу userId:sessionID, чтобы кнопка «Стоп» в композере
// могла прервать именно этот стрим. Раньше движок вообще не реализовывал
// /session/:id/abort (эндпоинт из контракта opencode), поэтому SDK-вызов
// sdk.client.session.abort() улетал в 404 и молча проглатывался — кнопка «Стоп»
// была нерабочей в браузере (поймано на проде 2026-07-09).
const activeRuns = new Map<string, AbortController>()
const runKey = (userId: string, sessionID: string) => `${userId}:${sessionID}`

/** Прервать активную генерацию для сессии. Возвращает true, если такая была. */
export function abortRun(userId: string, sessionID: string): boolean {
  const key = runKey(userId, sessionID)
  const controller = activeRuns.get(key)
  if (!controller) return false
  controller.abort()
  return true
}

export interface PromptInput {
  userId: string
  token: string
  sessionID: string
  /** id сообщения юзера, сгенерённый рендерером (optimistic) — переиспользуем, чтобы
   *  SSE-реконсиляция совпала по id; иначе свой. */
  messageID?: string
  model: { providerID: string; modelID: string }
  agent?: string
  /** opencode-вариант (deep-thinking тумблер шлёт "high") — gateway-app транслирует в thinking. */
  variant?: string
  /** OurApp: "deep" (тир Ultra в Технологе) — gost-rag декомпозирует запрос на под-вопросы. */
  retrieval?: string
  parts: Array<{
    type: string
    text?: string
    mime?: string
    url?: string
    filename?: string
    /** OurApp: часть не должна показываться как основной текст сообщения в
     *  транскрипте (напр. полный шаблон сценария) — но модель её всё равно
     *  получает. См. web/.../build-request-parts.ts. */
    synthetic?: boolean
  }>
}

/** Извлечь картинки-сканы (file-части image/*) для server-side OCR в gateway. */
function extractAttachments(
  parts: PromptInput["parts"],
): Array<{ mime: string; dataBase64: string; filename?: string }> {
  return parts
    .filter((p) => p.type === "file" && p.mime?.startsWith("image/") && p.url)
    .map((p) => ({
      mime: p.mime!,
      filename: p.filename,
      dataBase64: p.url!.includes("base64,") ? p.url!.split("base64,")[1]! : p.url!,
    }))
}

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

/** Заголовки к gateway /answer: JSON + общий секрет (если задан) для гейта на стороне шлюза. */
function answerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (config.ANSWER_SECRET) headers["x-internal-key"] = config.ANSWER_SECRET
  return headers
}

// ── Заземление в ГОСТ (помощник инженера) ──────────────────────────────────────────────────
// Грундинг включён, когда выбран ГОСТ-агент или поднят глобальный флаг. Тогда движок дёргает
// gost-rag /retrieve, подмешивает выдержки стандартов в системный промпт и инструктирует модель
// отвечать ТОЛЬКО по ним и цитировать пункты — это повышает точность и даёт проверяемые источники.
function groundingEnabled(agent: string | undefined): boolean {
  return config.GOST_RAG_ENABLED || agent === "gost"
}

/** Текст запроса для ретрива/планнера: БЕЗ synthetic-частей (полный шаблон сценария — модель его
 *  видит в истории, но в эмбеддинг запроса и deep-планнеру должен уходить чистый вопрос юзера,
 *  а не роль-бойлерплейт «Ты — инженер-нормоконтролёр…»). Экспортирован для тестов. */
export function queryFromParts(parts: PromptInput["parts"]): string {
  const clean = parts.filter((p) => p.type === "text" && p.text && !p.synthetic)
  // Сценарий может прислать ТОЛЬКО synthetic-часть (без displayText) — тогда лучше шаблон, чем пусто.
  const chosen = clean.length > 0 ? clean : parts.filter((p) => p.type === "text" && p.text)
  return chosen
    .map((p) => p.text)
    .join(" ")
    .trim()
}

// Иерархия источников + полнота (фидбек клиента 2026-07-10: полное практическое решение ОДНИМ
// ответом вместо 4 уточняющих вопросов). «Практика с плашкой» легализована решением юзера —
// раньше модель давала её вопреки промпту, теперь поведение стабилизировано правилами.
// Экспортирована для тестов-инвариантов (test/grounding.test.ts).
export function groundingSystemPrompt(context: string, subQueries?: string[]): string {
  return [
    "Ты — инженерный ассистент по нормативной документации (ГОСТ/СП/СанПиН/ТР ТС).",
    "",
    "Иерархия источников — строго в этом порядке:",
    "1. БАЗА: факты из выдержек ниже. Каждый факт из базы подкрепляй ссылкой на пункт в формате",
    "   [ГОСТ NNNN-ГГГГ, п. X.Y], как в выдержках. Содержание пунктов по памяти не достраивай.",
    "2. ПРАКТИКА: если нужного параметра в выдержках нет — дай типовое значение из производственной",
    "   практики, ЯВНО пометив его: «⚠️ не из базы — проверьте по оригиналу стандарта». Значению из",
    "   практики НИКОГДА не приписывай номер пункта или стандарта, которого нет в выдержках.",
    "3. НЕ НАЙДЕНО: если ответа нет ни в базе, ни в практике — прямо скажи это и не выдумывай.",
    "",
    "Полнота: на практический вопрос (как сварить/установить/выбрать/оформить) закрой в ОДНОМ ответе",
    "весь набор параметров, который понадобится для выполнения работы, а не только буквально",
    "спрошенное. Пример для сварки: тип соединения и шва, сторона сварки (снаружи/изнутри), способ",
    "(ручная/полуавтомат/аргон), сварочные материалы, катет и размеры, разделка/зазор, контроль",
    "качества, обозначение шва в КД. Для других задач аналогично — предвосхищай очевидные следующие",
    "вопросы. Чеклист — пример, а не форма: на простой справочный вопрос отвечай прямо и без таблиц.",
    ...(subQueries && subQueries.length > 0
      ? [
          "",
          "Запрос раскладывается на под-вопросы — закрой в ответе КАЖДЫЙ из них:",
          ...subQueries.map((q, i) => `${i + 1}. ${q}`),
        ]
      : []),
    "",
    "Практический ответ завершай блоком «Итоговое решение»: 1–2 предложения человеческим языком,",
    "затем таблица «Параметр | Значение | Основание» (номер пункта или «практика»).",
    "",
    "Оформление:",
    "- НЕ комментируй саму выдержку: никаких «в выдержке не указано», «далее не приведено», «текст",
    "  обрывается». Нет значения в базе — используй уровень ПРАКТИКА или не приводи его.",
    "- Отвечай на русском, структурированно и по существу.",
    "",
    "=== Выдержки из стандартов ===",
    context,
    "=== Конец выдержек ===",
  ].join("\n")
}

// В «Источниках» показываем только документы, на которые ответ реально сослался — модель цитирует
// [ГОСТ …, п. …], а doc_id источника = тот же designation. Фолбэк на все выдержки, если совпадений
// нет (модель не процитировала в ожидаемом формате) — чтобы панель не оказалась пустой.
function citedSources(answer: string, sources: GostSource[]): GostSource[] {
  const cited = sources.filter((s) => answer.includes(s.doc_id))
  return cited.length > 0 ? cited : sources
}

const GOST_ABSTAIN =
  "В базе знаний ГОСТ не нашлось релевантных пунктов по этому запросу. " +
  "Уточните вопрос (укажите стандарт, материал или область) — возможно, он вне покрытия текущей базы."

// Заголовок сессии. После первого обмена генерируем краткий заголовок дешёвой моделью.
// Запрос идёт через gateway-app (как и основной чат) — там же маскирование.
//
// РФ-модель, не claude-haiku: (1) claude-* алиасы идут через OpenRouter —
// та же точка отказа, что у основного чата (см. инцидент с блокировкой
// OpenRouter 2026-07-07, из-за которого генерация заголовков массово падала
// в fallbackTitle); (2) для тривиальной задачи «заголовок в 3-6 слов»
// GigaChat Lite более чем достаточен и не гонит текст запроса за рубеж.
const TITLE_MODEL = "gigachat-lite"
const DEFAULT_TITLE = "Новая сессия"

async function generateTitle(key: string, userText: string, assistantText: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${config.ANSWER_URL}/answer`, {
      method: "POST",
      headers: answerHeaders(),
      body: JSON.stringify({
        model: TITLE_MODEL,
        userKey: key,
        stream: false,
        maxTokens: 30,
        messages: [
          {
            role: "system",
            content:
              "Сгенерируй короткий заголовок диалога на русском: 3–6 слов, по сути запроса. Без кавычек, без точки в конце, без префиксов вроде «Заголовок:».",
          },
          { role: "user", content: `Запрос: ${userText.slice(0, 600)}\n\nОтвет: ${assistantText.slice(0, 300)}` },
        ],
      }),
    })
    if (!res.ok) return undefined
    const json = (await res.json()) as { text?: string }
    const raw = json.text?.trim()
    if (!raw) return undefined
    const title = raw.replace(/^["'«»\s]+|["'«».\s]+$/g, "").slice(0, 80)
    return title || undefined
  } catch {
    return undefined
  }
}

// Фолбэк: первые слова запроса юзера, если LLM-заголовок не получился
// (модель недоступна/ключ не разрешает claude-haiku/таймаут). Иначе все сессии
// навсегда остаются «Новая сессия» — поймано на проде 2026-07-07.
//
// Промпты сценариев (wizard) структурированы markdown'ом (# заголовок, ##
// шаги, --- разделители) — без очистки это протекало в заголовок сессии
// буквально ("# Сварка патрубка ... --- ## 1. Что норм…"). Снимаем markdown-
// разметку ДО схлопывания в одну строку, чтобы построчные паттерны (^#, ^---)
// сработали корректно — поймано на проде 2026-07-08.
function fallbackTitle(userText: string): string | undefined {
  const stripped = userText
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
  const clean = stripped.replace(/\s+/g, " ").trim()
  if (!clean) return undefined
  if (clean.length <= 60) return clean
  const cut = clean.slice(0, 60)
  const lastSpace = cut.lastIndexOf(" ")
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + "…"
}

// Генерируем заголовок только для первого обмена (пока он дефолтный). Fire-and-forget:
// session.updated прилетит чуть позже, не задерживая ответ/idle.
async function maybeGenerateTitle(
  userId: string,
  sessionID: string,
  key: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const session = await getSession(userId, sessionID)
  if (!session || session.title !== DEFAULT_TITLE) return
  const title = (await generateTitle(key, userText, assistantText)) ?? fallbackTitle(userText)
  if (!title) return
  const updated = await updateSession(userId, sessionID, { title })
  if (updated) publish(userId, { type: "session.updated", properties: { info: updated } })
}

export async function runPrompt(input: PromptInput): Promise<{ info: StoredMessage; parts: StoredPart[] }> {
  const { userId, sessionID } = input
  const key = runKey(userId, sessionID)
  const controller = new AbortController()
  activeRuns.set(key, controller)
  try {
    return await runPromptInner(input, controller.signal)
  } finally {
    if (activeRuns.get(key) === controller) activeRuns.delete(key)
  }
}

async function runPromptInner(
  input: PromptInput,
  signal: AbortSignal,
): Promise<{ info: StoredMessage; parts: StoredPart[] }> {
  const { userId, sessionID } = input
  const now = Date.now()
  const agent = input.agent ?? "build"
  const query = queryFromParts(input.parts)

  // 1. Сообщение юзера + его текстовые части.
  const userMsg: StoredMessage = {
    id: input.messageID ?? newId("msg"),
    sessionID,
    role: "user",
    time: { created: now },
    agent,
    model: input.model,
  }
  await insertMessage(userId, userMsg)
  publish(userId, { type: "message.updated", properties: { info: userMsg } })

  let idx = 0
  for (const p of input.parts) {
    if (p.type !== "text" || !p.text) continue
    const part: StoredPart = {
      id: newId("prt"),
      sessionID,
      messageID: userMsg.id,
      type: "text",
      text: p.text,
      ...(p.synthetic ? { synthetic: true } : {}),
    }
    await insertPart(userId, idx++, part)
    publish(userId, { type: "message.part.updated", properties: { part } })
  }

  // 2. Сессия «занята».
  publish(userId, { type: "session.status", properties: { sessionID, status: { type: "busy" } } })

  // 3. Пустое сообщение ассистента + пустая текст-часть.
  const asstMsg: StoredMessage = {
    id: newId("msg"),
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: userMsg.id,
    modelID: input.model.modelID,
    providerID: input.model.providerID,
    mode: agent,
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: ZERO_TOKENS,
  }
  await insertMessage(userId, asstMsg)
  publish(userId, { type: "message.updated", properties: { info: asstMsg } })

  // id reasoning-части резервируем ВСЕГДА и ДО id text-части (рендерер сортирует части
  // лексически по id → reasoning пойдёт первой; text держим на idx 1). Саму reasoning-
  // часть создаём ЛЕНИВО на первом reasoning-дельте.
  const reasoningPartId = newId("prt")
  let reasoningPart: StoredPart | undefined

  const asstPart: StoredPart = { id: newId("prt"), sessionID, messageID: asstMsg.id, type: "text", text: "" }
  await insertPart(userId, 1, asstPart)
  publish(userId, { type: "message.part.updated", properties: { part: asstPart } })

  // 4. Стрим от gateway-app (он маскирует/зовёт модель/демаскирует).
  try {
    const key = await getLitellmKey(input.token)
    if (!key) throw new Error("Нет доступа к моделям (litellm-ключ не найден). Проверьте подписку.")

    // Заземление в ГОСТ: ретрив выдержек под запрос. null ⇒ сервис недоступен → отвечаем БЕЗ
    // заземления (не падаем). Пусто/ниже порога ⇒ честный abstain, без выдуманных пунктов.
    // retrieval="deep" (тир Ultra) — планнер-декомпозиция на стороне gost-rag; ключ юзера
    // передаётся, чтобы планнер-вызов списался с ЕГО кредитов (spend-logs → ETL).
    const gost = groundingEnabled(agent)
      ? await retrieveGost(query, config.GOST_TOP_K, { deep: input.retrieval === "deep", userKey: key })
      : null
    const grounded = !!gost && gost.chunks.length > 0 && gost.top_score >= config.GOST_MIN_SCORE
    const abstain = !!gost && !grounded // успешно искали в базе, но релевантного нет

    if (abstain) {
      asstPart.text = GOST_ABSTAIN
      await updatePart(userId, asstPart)
      publish(userId, { type: "message.part.updated", properties: { part: asstPart } })
    } else {
      // grounded ⇒ системный промпт с выдержками впереди истории; иначе обычная история.
      const history = await historyForGateway(userId, sessionID)
      const messages = grounded
        ? [{ role: "system", content: groundingSystemPrompt(gost!.context, gost!.sub_queries) }, ...history]
        : history
      const res = await fetch(`${config.ANSWER_URL}/answer`, {
        method: "POST",
        headers: answerHeaders(),
        body: JSON.stringify({
          model: input.model.modelID,
          variant: input.variant,
          userKey: key,
          messages,
          stream: true,
          sessionID,
          attachments: extractAttachments(input.parts),
        }),
        signal,
      })
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "")
        throw new Error(`gateway вернул ${res.status}: ${detail.slice(0, 200)}`)
      }

      await consumeAnswerStream(res.body, {
        // gateway сообщает выбранную модель (важно для «Авто»: input.model = "auto").
        onModel: async (m, p) => {
          asstMsg.modelID = m
          asstMsg.providerID = p
          await updateMessage(userId, asstMsg)
          publish(userId, { type: "message.updated", properties: { info: asstMsg } })
        },
        // Распознанный gateway'ем документ (OCR скана) — сохраняем как часть СООБЩЕНИЯ
        // ПОЛЬЗОВАТЕЛЯ, чтобы он попал в историю (многоходовые диалоги о документе).
        onDoc: async (docText) => {
          const docPart: StoredPart = { id: newId("prt"), sessionID, messageID: userMsg.id, type: "text", text: docText }
          await insertPart(userId, idx++, docPart)
          publish(userId, { type: "message.part.updated", properties: { part: docPart } })
        },
        onText: async (delta) => {
          asstPart.text = (asstPart.text as string) + delta
          await updatePart(userId, asstPart)
          publish(userId, { type: "message.part.updated", properties: { part: asstPart, delta } })
        },
        onReasoning: async (delta) => {
          if (!reasoningPart) {
            reasoningPart = {
              id: reasoningPartId,
              sessionID,
              messageID: asstMsg.id,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
            }
            await insertPart(userId, 0, reasoningPart)
          }
          reasoningPart.text = (reasoningPart.text as string) + delta
          await updatePart(userId, reasoningPart)
          publish(userId, { type: "message.part.updated", properties: { part: reasoningPart, delta } })
        },
      })

      // Закрываем reasoning-часть (time.end) — рендерер перестаёт считать её «в процессе».
      if (reasoningPart) {
        reasoningPart.time = { start: (reasoningPart.time as { start: number }).start, end: Date.now() }
        await updatePart(userId, reasoningPart)
        publish(userId, { type: "message.part.updated", properties: { part: reasoningPart } })
      }

      // Заземлённый ответ: вешаем источники в metadata text-части — web SourceViewer читает их
      // авторитетно (вместо регулярки по тексту). Поле уезжает в parts.data (jsonb) и доходит до
      // рендерера через listMessages/SSE без изменений контракта.
      if (grounded) {
        const shownSources = citedSources(asstPart.text as string, gost!.sources)
        // «Практика с плашкой»: модель упоминает стандарты не из ретрива (напр. ГОСТ 14771-76 из
        // общих знаний) — дорезолвиваем их по карте источников, чтобы плашки были кликабельны.
        // Fail-open: без /sources (старый gost-rag) просто ничего не добавится.
        const known = new Set(shownSources.map((s) => s.doc_id))
        const mentioned = extractDesignations(asstPart.text as string).filter((d) => !known.has(d))
        const practice = (await resolveSources(mentioned)).filter((s) => s.available)
        asstPart.metadata = {
          sources: [...shownSources, ...practice],
          grounding: { top_score: gost!.top_score, grounded: true },
        }
        await updatePart(userId, asstPart)
        publish(userId, { type: "message.part.updated", properties: { part: asstPart } })
      }

    }

    // Заголовок сессии (только первый обмен) — и для заземлённого/обычного ответа, и для abstain
    // (сам запрос осмысленный, хоть в базе и не нашлось). fire-and-forget, чтобы не задерживать idle.
    void maybeGenerateTitle(userId, sessionID, key, query, asstPart.text as string).catch(() => {})
  } catch (err) {
    // Отмена кнопкой «Стоп» — fetch с AbortSignal бросает именно это имя. Не
    // дописываем "⚠️ ошибка" в текст (юзер сам остановил, это не сбой) — рендерер
    // сам показывает "прервано" по asstMsg.error.name === "MessageAbortedError".
    const aborted = err instanceof Error && err.name === "AbortError"
    if (aborted) {
      asstMsg.error = { name: "MessageAbortedError", data: {} }
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      asstPart.text = (asstPart.text as string) + (asstPart.text ? "\n\n" : "") + `⚠️ ${msg}`
      await updatePart(userId, asstPart)
      publish(userId, { type: "message.part.updated", properties: { part: asstPart } })
      asstMsg.error = { name: "ProviderError", data: { message: msg } }
    }
  }

  // 5. Финализация + idle.
  asstMsg.time = { created: (asstMsg.time as { created: number }).created, completed: Date.now() }
  await updateMessage(userId, asstMsg)
  publish(userId, { type: "message.updated", properties: { info: asstMsg } })
  publish(userId, { type: "session.status", properties: { sessionID, status: { type: "idle" } } })
  await updateSession(userId, sessionID, {}) // bump time.updated

  return { info: asstMsg, parts: [asstPart] }
}

/** Разобрать SSE-стрим gateway-app: data: {type:"text"|"reasoning"|"done"|"error", delta?, message?}. */
async function consumeAnswerStream(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onText: (delta: string) => Promise<void>
    onReasoning: (delta: string) => Promise<void>
    onModel?: (model: string, provider: string) => Promise<void>
    onDoc?: (text: string) => Promise<void>
  },
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (!payload) continue
      let json:
        | { type?: string; delta?: string; message?: string; model?: string; provider?: string; text?: string }
        | undefined
      try {
        json = JSON.parse(payload)
      } catch {
        continue // частичный/служебный кадр
      }
      if (json?.type === "text" && json.delta) await handlers.onText(json.delta)
      else if (json?.type === "reasoning" && json.delta) await handlers.onReasoning(json.delta)
      else if (json?.type === "model" && json.model) await handlers.onModel?.(json.model, json.provider ?? "ourapp-ru")
      else if (json?.type === "doc" && json.text) await handlers.onDoc?.(json.text)
      else if (json?.type === "error") throw new Error(json.message || "gateway error")
      else if (json?.type === "done") return
    }
  }
}

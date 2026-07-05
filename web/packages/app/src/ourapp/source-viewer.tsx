/**
 * OurApp — источнико-НЕЗАВИСИМЫЙ просмотр исходника процитированного документа.
 *
 * Инженеру нужно открыть процитированный ГОСТ/СП и проверить ответ. Где/как хранятся документы — НЕ
 * решено (внешний портал сегодня; рендер нашего файла с бэкенда завтра), поэтому компонент зависит только
 * от контракта `Source.view` (kind/url/mime/page), а не от способа хранения. Сменим хранение — поменяется
 * резолвер (gost-sources.ts / будущий engine), а этот компонент НЕТ. См. gost-rag/SOURCE_INTERFACE.md.
 *
 * Источники приходят двумя путями:
 *  1) (будущее, авторитетно) engine кладёт структурный Source[] в metadata части ответа;
 *  2) (стопгап сейчас) extractSources() находит упоминания «ГОСТ …/СП …» в тексте ответа и резолвит их
 *     по статической карте GOST_SOURCES — работает уже сегодня, без изменений в engine.
 */
import { For, Show, type Component } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { GOST_SOURCES, type SourceKind } from "./gost-sources"

export interface SourceView {
  kind: SourceKind
  url?: string
  mime?: string
  page?: number
}

export interface Source {
  doc_id: string
  title?: string
  clause_path?: string
  quote?: string
  view: SourceView
  available: boolean
}

// Обозначение стандарта в тексте: ГОСТ Р / ГОСТ / СНиП / СанПиН / СП / ТР ТС + номер (с точками, дефисами,
// тире и слэшем). Тире нормализуем в дефис, чтобы ключ совпал с картой (как при ингесте на бэкенде).
const DESIGNATION = /(?:ГОСТ\s+Р|ГОСТ|СНиП|СанПиН|СП|ТР\s+ТС)\s+\d+(?:[.\-‐-―/]\d+)*/g

const normalize = (s: string) => s.replace(/\s+/g, " ").replace(/[‐-―]/g, "-").trim()

/** Стопгап: вытащить из текста ответа упоминания стандартов и резолвить в просматриваемые источники. */
export function extractSources(text: string): Source[] {
  const seen = new Set<string>()
  return [...text.matchAll(DESIGNATION)].flatMap((m) => {
    const id = normalize(m[0])
    if (seen.has(id)) return []
    seen.add(id)
    const d = GOST_SOURCES[id]
    if (!d) return []
    return [{ doc_id: id, title: d.title, view: { kind: d.kind, url: d.url, mime: d.mime }, available: d.kind !== "unavailable" }]
  })
}

const ITEM =
  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[13px] border-[var(--hairline-strong,#D8D2C5)] transition-colors"

export const SourceViewer: Component<{ sources: Source[] }> = (props) => (
  <Show when={props.sources.length > 0}>
    <div data-component="ourapp-source-viewer" class="flex flex-col gap-1.5 px-3 pt-2 pb-1">
      <span class="text-[11px] uppercase tracking-wide text-[var(--text-tertiary,#6B6660)]">
        Источники — открыть и проверить
      </span>
      <div data-slot="source-list" class="flex flex-wrap gap-2">
        <For each={props.sources}>
          {(s) => (
            <Show
              when={s.available && s.view.url}
              fallback={
                <span
                  data-slot="source-na"
                  class={`${ITEM} text-[var(--text-tertiary,#6B6660)] opacity-60`}
                  title="источник недоступен"
                >
                  {s.doc_id}
                  {s.clause_path ? `, п. ${s.clause_path}` : ""} — нет источника
                </span>
              }
            >
              <a
                data-slot="source-link"
                href={s.view.url}
                target="_blank"
                rel="noreferrer"
                title={`${s.title || s.doc_id}${s.view.kind === "external" ? " · внешний портал" : ""}`}
                class={`${ITEM} bg-[var(--ourapp-bg-surface,#fff)] hover:bg-[var(--ourapp-bg-surface-alt,#F6F2EB)] text-[var(--text-secondary,#4A453F)]`}
              >
                <Icon name="open-file" size="small" />
                <span>
                  {s.doc_id}
                  {s.clause_path ? `, п. ${s.clause_path}` : ""}
                </span>
              </a>
            </Show>
          )}
        </For>
      </div>
    </div>
  </Show>
)

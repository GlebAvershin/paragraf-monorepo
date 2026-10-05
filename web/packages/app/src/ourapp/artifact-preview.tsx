import {
  createMemo,
  createResource,
  ErrorBoundary,
  For,
  onCleanup,
  onMount,
  Show,
  Suspense,
  type Component,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useBeforeLeave } from "@solidjs/router"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  cleanDocumentHtml,
  downloadDocumentBlob,
  loadWorkbook,
  markdownDocumentHtml,
  workbookBlob,
} from "./document-content"
import { documentVersion, type DocumentDraft } from "./document-api"
import { OriginalDocument, WorkbookGrid } from "./document-viewers"
import { getSessionToken } from "./auth-storage"
import "./artifact-preview.css"

export interface ArtifactInfo {
  filename: string
  path: string
  bytes?: number
  html?: string
  text?: string
  blocks?: number
  blobUrl?: string
  sourceUrl?: string
  mime?: string
  downloadable?: boolean
  sessionID?: string
  documentKey?: string
}

type OpenDocument = ArtifactInfo & { tabKey: string; sessionID?: string; documentKey: string }
const [panel, setPanel] = createStore({ items: [] as OpenDocument[], active: "", expanded: false })
let panelOwner: string | null = null

function synchronizePanelOwner() {
  const owner = getSessionToken()
  if (owner === panelOwner) return
  setPanel({ items: [], active: "", expanded: false })
  panelOwner = owner
}

export function openArtifactPreview(info: ArtifactInfo) {
  synchronizePanelOwner()
  const sessionID =
    info.sessionID ?? (typeof location === "undefined" ? undefined : /\/session\/([^/]+)/.exec(location.pathname)?.[1])
  const documentKey = info.documentKey ?? `generated:${checksum(info.text ?? info.html ?? info.filename)}`
  const tabKey = `${sessionID ?? "local"}:${documentKey}`
  if (!panel.items.some((item) => item.tabKey === tabKey))
    setPanel("items", (items) => [...items, { ...info, tabKey, sessionID, documentKey }])
  setPanel("active", tabKey)
}

export function closeArtifactPreview() {
  setPanel("active", "")
}

export function useArtifactPanel() {
  return {
    artifact: () => panel.items.find((item) => item.tabKey === panel.active) ?? null,
    open: openArtifactPreview,
    close: closeArtifactPreview,
    isOpen: () => !!panel.active,
  }
}

export const ArtifactPreviewPanel: Component<{ class?: string }> = () => {
  synchronizePanelOwner()
  onMount(() => {
    window.addEventListener("ourapp:session-changed", synchronizePanelOwner)
    window.addEventListener("storage", synchronizePanelOwner)
  })
  onCleanup(() => {
    window.removeEventListener("ourapp:session-changed", synchronizePanelOwner)
    window.removeEventListener("storage", synchronizePanelOwner)
  })
  return (
    <aside
      hidden={!panel.active}
      class="ourapp-artifact-preview"
      classList={{ "ourapp-artifact-preview--expanded": panel.expanded }}
      aria-label="Предпросмотр документа"
    >
      <div class="isaac-document-tabs" role="tablist" aria-label="Открытые документы">
        <For each={panel.items}>
          {(info) => (
            <button
              type="button"
              role="tab"
              aria-selected={info.tabKey === panel.active}
              title={info.filename}
              onClick={() => setPanel("active", info.tabKey)}
            >
              {info.filename}
            </button>
          )}
        </For>
      </div>
      <For each={panel.items}>
        {(info) => (
          <div class="isaac-document-workspace" hidden={panel.active !== info.tabKey}>
            <ErrorBoundary
              fallback={
                <div class="isaac-document-notice" role="alert">
                  Не удалось открыть документ. Попробуйте загрузить его заново.
                  <button type="button" onClick={closeArtifactPreview}>
                    Закрыть панель
                  </button>
                </div>
              }
            >
              <Suspense
                fallback={
                  <p class="isaac-document-notice" role="status">
                    Открываем документ…
                  </p>
                }
              >
                <DocumentWorkspace info={info} />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
      </For>
    </aside>
  )
}

function DocumentWorkspace(props: { info: OpenDocument }) {
  const info = props.info
  const spreadsheet = /\.(xlsx|xls|csv)$/i.test(info.filename)
  const image = info.mime?.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(info.filename)
  let editor: HTMLDivElement | undefined
  let savedSelection: Range | undefined
  let savedDraft: DocumentDraft | null = null
  const [state, setState] = createStore({
    draft: null as DocumentDraft | null,
    revision: 0,
    edit: false,
    dirty: false,
    saving: false,
    exporting: false,
    exportStatus: "",
    scale: 0,
    width: 600,
    page: 1,
    pages: 1,
    error: "",
    status: "",
    closing: false,
  })
  const scale = () => state.scale || (spreadsheet || image ? 1 : Math.max(0.2, Math.min(1, (state.width - 48) / 794)))
  let resize: ResizeObserver | undefined
  onCleanup(() => resize?.disconnect())
  const [content] = createResource(async () => {
    const url = info.sourceUrl ?? info.blobUrl
    const original =
      url && /^(data:|blob:)/.test(url) ? await fetch(url).then((response) => response.arrayBuffer()) : undefined
    const workbook = spreadsheet ? await loadWorkbook(info.filename, original, info.text) : undefined
    const html = await (async () => {
      if (image || spreadsheet) return ""
      if (original && /\.docx$/i.test(info.filename)) {
        const mammoth = await import("mammoth/mammoth.browser.js" as string)
        return cleanDocumentHtml((await mammoth.convertToHtml({ arrayBuffer: original })).value)
      }
      if (original && /\.pdf$/i.test(info.filename) && !info.text) {
        const { extractText } = await import("unpdf")
        return markdownDocumentHtml((await extractText(new Uint8Array(original), { mergePages: true })).text)
      }
      const text =
        info.text ??
        (original && (/\.(txt|md|markdown)$/i.test(info.filename) || info.mime?.startsWith("text/"))
          ? new TextDecoder().decode(original)
          : "")
      return info.html ? cleanDocumentHtml(info.html) : markdownDocumentHtml(text)
    })()
    const version =
      info.sessionID && !image
        ? await documentVersion(info.sessionID, info.documentKey).catch((error: Error) => {
            setState("error", error.message)
            return null
          })
        : null
    savedDraft = version?.draft ?? (spreadsheet ? { kind: "sheet", cells: {} } : { kind: "text", html })
    setState({
      draft: savedDraft,
      revision: version?.revision ?? 0,
      status: version?.revision ? "Сохранённая версия" : "",
      dirty: false,
    })
    return { original, workbook, versionAvailable: !!version || !info.sessionID }
  })
  const html = () => (state.draft?.kind === "text" ? state.draft.html : "")
  const originalView = createMemo(
    () =>
      !image &&
      !spreadsheet &&
      content()?.original &&
      /\.(docx|pdf)$/i.test(info.filename) &&
      !state.edit &&
      !state.revision &&
      !state.dirty,
  )
  const changeHtml = () => {
    if (editor)
      setState({
        draft: { kind: "text", html: editor.innerHTML },
        dirty: true,
        status: "Есть несохранённые правки",
        exportStatus: "",
      })
  }
  const save = async () => {
    if (!state.draft || !state.dirty || state.saving) return
    const draft: DocumentDraft =
      state.draft.kind === "text"
        ? { kind: "text", html: cleanDocumentHtml(state.draft.html) }
        : { kind: "sheet", cells: JSON.parse(JSON.stringify(state.draft.cells)) }
    const snapshot = JSON.stringify(state.draft)
    setState({ saving: true, error: "" })
    try {
      if (!info.sessionID) throw new Error("Для сохранения документа откройте диалог.")
      if (!content()?.versionAvailable)
        throw new Error("Не удалось загрузить сохранённую версию. Откройте файл заново.")
      const version = await documentVersion(info.sessionID, info.documentKey, { revision: state.revision, draft })
      savedDraft = draft
      const unchanged = JSON.stringify(state.draft) === snapshot
      setState({
        revision: version.revision,
        dirty: !unchanged,
        status: unchanged ? "Сохранено в диалоге" : "Есть несохранённые правки",
      })
      if (unchanged && state.closing) {
        setState("closing", false)
        closeArtifactPreview()
      }
    } catch (error) {
      setState("error", error instanceof Error ? error.message : "Не удалось сохранить правки")
    } finally {
      setState("saving", false)
    }
  }
  const download = async (format: "original" | "docx" | "pdf" | "xlsx" | "csv") => {
    if (state.exporting) return
    setState({ error: "", exporting: true, exportStatus: "Готовим файл…" })
    try {
      if (format === "original") {
        if (!content()?.original)
          throw new Error("Оригинал этого старого файла не сохранился. Можно скачать восстановленную версию.")
        downloadDocumentBlob(
          new Blob([content()!.original!], { type: info.mime ?? "application/octet-stream" }),
          info.filename,
        )
        setState("exportStatus", `Файл подготовлен: ${info.filename}`)
        return
      }
      const base = info.filename.replace(/\.[^.]+$/, "")
      const name = `${base}${state.dirty || state.revision ? " — редакция" : ""}.${format}`
      if (state.draft?.kind === "sheet" && content()?.workbook) {
        downloadDocumentBlob(
          await workbookBlob(content()!.workbook!, state.draft.cells, format === "csv" ? `${base}.csv` : info.filename),
          name,
        )
        setState("exportStatus", `Файл подготовлен: ${name}`)
        return
      }
      const { exportHtmlDocument } = await import("./document-export")
      downloadDocumentBlob(await exportHtmlDocument(html(), format === "pdf" ? "pdf" : "docx", base), name)
      setState("exportStatus", `Файл подготовлен: ${name}`)
    } catch (error) {
      setState({ error: error instanceof Error ? error.message : "Не удалось подготовить файл", exportStatus: "" })
    } finally {
      setState("exporting", false)
    }
  }
  const command = (action: string, value?: string) => {
    editor?.focus()
    if (savedSelection && editor?.contains(savedSelection.commonAncestorContainer)) {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(savedSelection)
    }
    document.execCommand(action, false, value)
    changeHtml()
  }
  const rememberSelection = () => {
    const selection = window.getSelection()
    if (selection?.rangeCount && editor?.contains(selection.anchorNode))
      savedSelection = selection.getRangeAt(0).cloneRange()
  }
  const close = () => (state.dirty ? setState("closing", true) : closeArtifactPreview())
  const unload = (event: BeforeUnloadEvent) => {
    if (state.dirty) {
      event.preventDefault()
      event.returnValue = ""
    }
  }
  window.addEventListener("beforeunload", unload)
  onCleanup(() => window.removeEventListener("beforeunload", unload))
  useBeforeLeave((event) => {
    if (
      state.dirty &&
      !event.defaultPrevented &&
      !window.confirm(
        `В документе «${info.filename}» есть несохранённые правки. Перейти на другую страницу без сохранения?`,
      )
    )
      event.preventDefault()
  })
  return (
    <>
      <div class="isaac-document-heading">
        <div>
          <strong title={info.filename}>{info.filename}</strong>
          <span>{state.dirty ? "Не сохранено" : state.status || "Исходный документ"}</span>
        </div>
        <button
          type="button"
          aria-label={panel.expanded ? "Свернуть панель" : "Развернуть панель"}
          title={panel.expanded ? "Свернуть панель" : "Развернуть панель"}
          onClick={() => setPanel("expanded", !panel.expanded)}
        >
          {panel.expanded ? "↙" : "↗"}
        </button>
        <button type="button" aria-label="Закрыть" title="Закрыть" onClick={close}>
          ×
        </button>
      </div>
      <div class="isaac-document-actions">
        <Show when={!image}>
          <button
            type="button"
            disabled={!content()}
            aria-pressed={state.edit}
            onClick={() => setState("edit", !state.edit)}
          >
            {state.edit ? "Просмотр" : "Редактировать"}
          </button>
          <button
            type="button"
            class="isaac-document-save"
            disabled={!state.dirty || state.saving || !info.sessionID || !content()?.versionAvailable}
            onClick={() => void save()}
          >
            {state.saving ? "Сохраняем…" : "Сохранить"}
          </button>
        </Show>
        <select
          aria-label="Масштаб документа"
          value={state.scale}
          onChange={(event) => setState("scale", Number(event.currentTarget.value))}
        >
          <option value="0">По ширине</option>
          <For each={[0.5, 0.75, 1, 1.25, 1.5, 2]}>{(scale) => <option value={scale}>{scale * 100}%</option>}</For>
        </select>
        <select
          aria-label="Скачать документ"
          value=""
          disabled={!content() || state.exporting}
          onChange={(event) => {
            const value = event.currentTarget.value as "original" | "docx" | "pdf" | "xlsx" | "csv"
            if (value) void download(value)
            event.currentTarget.value = ""
          }}
        >
          <option value="">Скачать</option>
          <Show when={content()?.original}>
            <option value="original">Исходный файл</option>
          </Show>
          <Show
            when={spreadsheet}
            fallback={
              <Show when={!image}>
                <option value="docx">Версия DOCX</option>
                <option value="pdf">Версия PDF</option>
              </Show>
            }
          >
            <option value="xlsx">Версия XLSX</option>
            <option value="csv">CSV первого листа</option>
          </Show>
        </select>
      </div>
      <Show when={state.exportStatus}>
        <p class="isaac-document-notice" role="status">
          {state.exportStatus}
        </p>
      </Show>
      <Show when={state.closing}>
        <div class="isaac-document-notice">
          Сохранить изменения перед закрытием?
          <div class="isaac-document-actions">
            <button type="button" onClick={() => void save()}>
              Сохранить и закрыть
            </button>
            <button
              type="button"
              onClick={() => {
                setState({
                  dirty: false,
                  closing: false,
                  edit: false,
                  draft: savedDraft,
                  exportStatus: "",
                  status: state.revision ? "Сохранённая версия" : "",
                  error: "",
                })
                closeArtifactPreview()
              }}
            >
              Закрыть без сохранения
            </button>
            <button type="button" onClick={() => setState("closing", false)}>
              Продолжить редактирование
            </button>
          </div>
        </div>
      </Show>
      <Show when={state.error || content.error}>
        <p class="isaac-document-notice isaac-document-notice--error" role="alert">
          {state.error || "Не удалось открыть файл. Попробуйте загрузить его заново."}
        </p>
      </Show>
      <Show when={content.loading}>
        <p class="isaac-document-notice" role="status">
          Открываем документ…
        </p>
      </Show>
      <Show when={content() && !content()?.original && !info.blobUrl && info.mime === "ourapp/office"}>
        <p class="isaac-document-notice">
          Для этой старой загрузки сохранился только текст. Ниже восстановленное содержимое; оригинальная разметка
          недоступна.
        </p>
      </Show>
      <Show when={state.edit && !spreadsheet && !image}>
        <Show when={!/\.pdf$/i.test(info.filename)}>
          <p class="isaac-document-notice">
            Правки сохраняются как отдельная текстовая редакция. Заголовки, таблицы и списки остаются; сложная исходная
            вёрстка может отличаться. Оригинал не изменяется.
          </p>
        </Show>
        <div class="isaac-document-format" role="toolbar" aria-label="Форматирование документа">
          <For
            each={[
              ["bold", "Жирный", "Ж"],
              ["italic", "Курсив", "К"],
              ["underline", "Подчёркнутый", "Ч"],
              ["insertUnorderedList", "Маркированный список", "•"],
              ["insertOrderedList", "Нумерованный список", "1."],
              ["justifyLeft", "По левому краю", "⇤"],
              ["justifyCenter", "По центру", "↔"],
              ["justifyFull", "По ширине", "☰"],
              ["undo", "Отменить правку", "↶"],
              ["redo", "Повторить правку", "↷"],
            ]}
          >
            {([action, title, label]) => (
              <button
                type="button"
                aria-label={title}
                title={title}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => command(action)}
              >
                {label}
              </button>
            )}
          </For>
          <select aria-label="Стиль абзаца" onChange={(event) => command("formatBlock", event.currentTarget.value)}>
            <option value="p">Обычный текст</option>
            <option value="h1">Заголовок 1</option>
            <option value="h2">Заголовок 2</option>
            <option value="h3">Заголовок 3</option>
          </select>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() =>
              command(
                "insertHTML",
                "<table><tbody><tr><th>Заголовок 1</th><th>Заголовок 2</th></tr><tr><td>Значение</td><td>Значение</td></tr></tbody></table><p><br></p>",
              )
            }
          >
            Таблица
          </button>
        </div>
        <Show when={/\.pdf$/i.test(info.filename)}>
          <p class="isaac-document-notice">
            Редактируется текстовая версия PDF. Исходные страницы остаются доступны для скачивания.
          </p>
        </Show>
      </Show>
      <Show when={originalView() && /\.pdf$/i.test(info.filename)}>
        <div class="isaac-document-pagination">
          <button
            type="button"
            aria-label="Предыдущая страница"
            disabled={state.page <= 1}
            onClick={() => setState("page", state.page - 1)}
          >
            ‹
          </button>
          <span>
            Страница {state.page} из {state.pages}
          </span>
          <button
            type="button"
            aria-label="Следующая страница"
            disabled={state.page >= state.pages}
            onClick={() => setState("page", state.page + 1)}
          >
            ›
          </button>
        </div>
      </Show>
      <Show when={content()}>
        {(loaded) => (
          <Show
            when={spreadsheet && loaded().workbook}
            fallback={
              <div
                class="isaac-document-scroll"
                ref={(element) => {
                  setState("width", element.clientWidth || 600)
                  resize = new ResizeObserver(() => {
                    if (element.clientWidth) setState("width", element.clientWidth)
                  })
                  resize.observe(element)
                }}
              >
                <Show
                  when={image}
                  fallback={
                    <Show
                      when={originalView()}
                      fallback={
                        <Show when={state.draft?.kind === "text"}>
                          <div class="isaac-document-paper" style={{ zoom: scale() }}>
                            <Show
                              when={state.edit}
                              fallback={<div class="isaac-document-content" innerHTML={cleanDocumentHtml(html())} />}
                            >
                              <div
                                ref={(element) => {
                                  editor = element
                                  element.innerHTML = cleanDocumentHtml(html())
                                }}
                                role="textbox"
                                aria-label="Содержимое документа"
                                aria-multiline="true"
                                contentEditable
                                class="isaac-document-content isaac-document-editor"
                                onInput={changeHtml}
                                onMouseUp={rememberSelection}
                                onKeyUp={rememberSelection}
                                onBlur={rememberSelection}
                                onPaste={(event) => {
                                  event.preventDefault()
                                  const rich = event.clipboardData?.getData("text/html")
                                  command(
                                    "insertHTML",
                                    rich
                                      ? cleanDocumentHtml(rich)
                                      : markdownDocumentHtml(event.clipboardData?.getData("text/plain") ?? ""),
                                  )
                                }}
                              />
                            </Show>
                          </div>
                        </Show>
                      }
                    >
                      <OriginalDocument
                        buffer={loaded().original!}
                        filename={info.filename}
                        page={state.page}
                        scale={scale()}
                        onPages={(pages) => setState("pages", pages)}
                      />
                    </Show>
                  }
                >
                  <img
                    class="ourapp-artifact-preview__image"
                    src={info.sourceUrl ?? info.blobUrl}
                    alt={info.filename}
                    style={{ width: `${scale() * 100}%`, "max-width": "none" }}
                  />
                </Show>
              </div>
            }
          >
            <WorkbookGrid
              content={loaded().workbook!}
              edit={state.edit}
              scale={scale()}
              cells={state.draft?.kind === "sheet" ? state.draft.cells : {}}
              onChange={(sheet, address, value) => {
                if (state.draft?.kind !== "sheet") return
                setState("draft", {
                  kind: "sheet",
                  cells: { ...state.draft.cells, [sheet]: { ...state.draft.cells[sheet], [address]: value } },
                })
                setState({ dirty: true, status: "Есть несохранённые правки", exportStatus: "" })
              }}
            />
          </Show>
        )}
      </Show>
      <div class="isaac-document-footer">
        <span>{state.dirty ? "Правки ещё не сохранены" : state.status || "Оригинал сохранён отдельно от правок"}</span>
        <Show when={info.bytes}>
          <span>{(info.bytes! / 1024).toFixed(1)} КБ</span>
        </Show>
      </div>
    </>
  )
}

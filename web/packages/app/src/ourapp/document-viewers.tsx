import { createEffect, createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { WorkSheet } from "xlsx"
import { cellValue, type WorkbookContent, type CellChanges } from "./document-content"

export function OriginalDocument(props: {
  buffer: ArrayBuffer
  filename: string
  page: number
  scale: number
  onPages: (pages: number) => void
}) {
  const documentClass = `isaac-docx-${crypto.randomUUID()}`
  let container: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined
  const [state, setState] = createStore({ error: "", busy: true })
  let generation = 0
  const [pdf] = createResource(async () => {
    if (!/\.pdf$/i.test(props.filename)) return null
    const { getDocumentProxy } = await import("unpdf")
    const result = await getDocumentProxy(new Uint8Array(props.buffer.slice(0)))
    props.onPages(result.numPages)
    return result
  })
  onCleanup(() => {
    generation++
    void pdf.latest?.destroy()
  })
  createEffect(() => {
    const document = pdf()
    const page = props.page
    const scale = props.scale
    if (!document || !canvas) return
    const current = ++generation
    setState({ busy: true, error: "" })
    const render = async () => {
      const target = await document.getPage(Math.min(page, document.numPages))
      if (generation !== current || !canvas) return
      const base = target.getViewport({ scale: 1 })
      const viewport = target.getViewport({ scale: (scale * 794) / base.width })
      const next = window.document.createElement("canvas")
      next.width = viewport.width
      next.height = viewport.height
      await target.render({ canvasContext: next.getContext("2d")!, viewport }).promise
      if (generation !== current || !canvas) return
      canvas.width = next.width
      canvas.height = next.height
      canvas.getContext("2d")!.drawImage(next, 0, 0)
      setState("busy", false)
    }
    void render().catch(() => {
      if (generation === current)
        setState({ busy: false, error: "Не удалось отобразить страницу PDF. Можно скачать исходный файл." })
    })
  })
  createEffect(() => {
    if (!container || !/\.docx$/i.test(props.filename)) return
    const current = ++generation
    const render = async () => {
      const { renderAsync } = await import("docx-preview")
      const temporary = document.createElement("div")
      await renderAsync(props.buffer.slice(0), temporary, undefined, {
        className: documentClass,
        inWrapper: true,
        breakPages: true,
        useBase64URL: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
      })
      if (generation !== current || !container) return
      const { default: DOMPurify } = await import("dompurify")
      DOMPurify.sanitize(temporary, {
        IN_PLACE: true,
        ADD_TAGS: ["style"],
        FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input"],
        ADD_ATTR: ["target"],
      })
      temporary.querySelector(`.${documentClass}-wrapper`)?.classList.add("isaac-docx-wrapper")
      temporary.querySelectorAll(`section.${documentClass}`).forEach((page) => page.classList.add("isaac-docx"))
      temporary.querySelectorAll("a").forEach((link) => {
        link.target = "_blank"
        link.rel = "noopener noreferrer"
      })
      container.replaceChildren(...Array.from(temporary.childNodes))
      props.onPages(container.querySelectorAll("section.isaac-docx").length || 1)
      setState("busy", false)
    }
    void render().catch(() => {
      if (generation === current)
        setState({
          busy: false,
          error: "Не удалось отобразить исходный DOCX. Доступны редактируемый текст и скачивание оригинала.",
        })
    })
  })
  return (
    <>
      <Show when={state.busy || pdf.loading}>
        <p class="isaac-document-notice" role="status">
          Загружаем документ…
        </p>
      </Show>
      <Show when={state.error || pdf.error}>
        <p class="isaac-document-notice" role="alert">
          {state.error || "Не удалось прочитать PDF"}
        </p>
      </Show>
      <Show
        when={/\.pdf$/i.test(props.filename)}
        fallback={<div ref={container} class="isaac-original-docx" style={{ zoom: props.scale }} />}
      >
        <canvas ref={canvas} class="isaac-pdf-page" aria-label={`Страница ${props.page} документа ${props.filename}`} />
      </Show>
    </>
  )
}

export function WorkbookGrid(props: {
  content: WorkbookContent
  cells: CellChanges
  edit: boolean
  scale: number
  onChange: (sheet: string, address: string, value: string) => void
}) {
  const [state, setState] = createStore({ sheet: props.content.workbook.SheetNames[0], address: "A1" })
  const [library] = createResource(() => import("xlsx"))
  const sheet = () => props.content.workbook.Sheets[state.sheet]
  const range = createMemo(() => library()?.utils.decode_range(sheet()?.["!ref"] ?? "A1"))
  const rows = createMemo(() => Array.from({ length: Math.min(1000, (range()?.e.r ?? 0) + 1) }, (_, index) => index))
  const columns = createMemo(() => Array.from({ length: Math.min(100, (range()?.e.c ?? 0) + 1) }, (_, index) => index))
  const value = (address: string) => props.cells[state.sheet]?.[address] ?? cellValue(sheet()?.[address])
  const display = (address: string) =>
    props.cells[state.sheet]?.[address] ?? sheet()?.[address]?.w ?? String(sheet()?.[address]?.v ?? "")
  const merge = (row: number, column: number) =>
    sheet()?.["!merges"]?.find((item) => row >= item.s.r && row <= item.e.r && column >= item.s.c && column <= item.e.c)
  const width = (worksheet: WorkSheet, column: number) =>
    Math.min(400, Math.max(88, worksheet["!cols"]?.[column]?.wpx ?? (worksheet["!cols"]?.[column]?.wch ?? 16) * 7))
  return (
    <div class="isaac-workbook">
      <div class="isaac-workbook-formula">
        <span>{state.address}</span>
        <span aria-hidden="true">ƒx</span>
        <input
          aria-label="Значение или формула ячейки"
          value={value(state.address)}
          readOnly={!props.edit}
          onChange={(event) => props.onChange(state.sheet, state.address, event.currentTarget.value)}
        />
      </div>
      <div class="isaac-workbook-scroll">
        <Show when={library()}>
          {(XLSX) => (
            <table class="isaac-workbook-grid" aria-label={`Лист ${state.sheet}`} style={{ zoom: props.scale }}>
              <colgroup>
                <col style={{ width: "42px" }} />
                <For each={columns()}>{(column) => <col style={{ width: `${width(sheet(), column)}px` }} />}</For>
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="Номера строк" />
                  <For each={columns()}>{(column) => <th scope="col">{XLSX().utils.encode_col(column)}</th>}</For>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(row) => (
                    <tr
                      style={{ height: sheet()?.["!rows"]?.[row]?.hpx ? `${sheet()["!rows"]![row].hpx}px` : undefined }}
                    >
                      <th scope="row">{row + 1}</th>
                      <For each={columns()}>
                        {(column) => {
                          const address = XLSX().utils.encode_cell({ r: row, c: column })
                          const joined = merge(row, column)
                          if (joined && (joined.s.r !== row || joined.s.c !== column)) return null
                          return (
                            <td
                              style={props.content.styles?.[state.sheet]?.[address]}
                              colspan={joined ? joined.e.c - joined.s.c + 1 : 1}
                              rowspan={joined ? joined.e.r - joined.s.r + 1 : 1}
                              classList={{ "isaac-cell-selected": state.address === address }}
                            >
                              <Show
                                when={props.edit}
                                fallback={
                                  <button
                                    type="button"
                                    aria-label={`Ячейка ${address}: ${display(address)}`}
                                    onClick={() => setState("address", address)}
                                  >
                                    {display(address) || "\u00a0"}
                                  </button>
                                }
                              >
                                <input
                                  aria-label={`Ячейка ${address}`}
                                  value={value(address)}
                                  onFocus={() => setState("address", address)}
                                  onInput={(event) => props.onChange(state.sheet, address, event.currentTarget.value)}
                                />
                              </Show>
                            </td>
                          )
                        }}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          )}
        </Show>
      </div>
      <div class="isaac-workbook-sheets" role="tablist" aria-label="Листы книги">
        <For each={props.content.workbook.SheetNames}>
          {(name) => (
            <button
              type="button"
              role="tab"
              aria-selected={state.sheet === name}
              onClick={() => setState({ sheet: name, address: "A1" })}
            >
              {name}
            </button>
          )}
        </For>
      </div>
      <Show when={Object.keys(props.cells).length > 0}>
        <p class="isaac-document-notice">
          Формулы не пересчитываются в предпросмотре. После правок итоговые значения пересчитываются при открытии
          скачанной книги в Excel.
        </p>
      </Show>
      <Show when={(range()?.e.r ?? 0) >= 1000 || (range()?.e.c ?? 0) >= 100}>
        <p class="isaac-document-notice">В предпросмотре первые 1000 строк и 100 колонок. Скачивается вся книга.</p>
      </Show>
    </div>
  )
}

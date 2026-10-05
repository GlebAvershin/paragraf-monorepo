import DOMPurify from "dompurify"
import { Marked } from "marked"
import type { WorkBook } from "xlsx"

export type WorkbookContent = {
  workbook: WorkBook
  original?: ArrayBuffer
  styles?: Record<string, Record<string, Record<string, string>>>
}
export type CellChanges = Record<string, Record<string, string>>
const documentMarkdown = new Marked({ async: false, gfm: true, breaks: false })

export function cleanDocumentHtml(html: string): string {
  const tags = [
    "p",
    "div",
    "span",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "ul",
    "ol",
    "li",
    "blockquote",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "hr",
    "a",
    "img",
    "pre",
    "code",
    "sup",
    "sub",
  ]
  const template = document.createElement("template")
  template.innerHTML = html
  template.content.querySelectorAll("*").forEach((element) => {
    if (!tags.includes(element.tagName.toLowerCase())) {
      element.remove()
      return
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!["href", "src", "alt", "colspan", "rowspan", "style", "start"].includes(attribute.name))
        element.removeAttribute(attribute.name)
    }
    const href = element.getAttribute("href")
    if (href && !/^(https?:\/\/|mailto:|#)/i.test(href.trim())) element.removeAttribute("href")
    const source = element.getAttribute("src")
    if (source && !/^(data:image\/(png|jpeg|gif|webp);base64,|blob:)/i.test(source)) element.remove()
    for (const name of ["colspan", "rowspan"]) {
      if (element.hasAttribute(name))
        element.setAttribute(name, String(Math.max(1, Math.min(100, parseInt(element.getAttribute(name) ?? "1") || 1))))
    }
  })
  return DOMPurify.sanitize(template.innerHTML, {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ["href", "src", "alt", "colspan", "rowspan", "style", "start"],
    FORBID_CONTENTS: ["script", "style", "iframe", "object"],
  })
    .replace(/style="([^"]*)"/g, (_, style: string) => {
      const safe = style
        .split(";")
        .filter((item) =>
          /^(text-align:\s*(left|right|center|justify)|font-weight:\s*(bold|[1-9]00)|font-style:\s*italic|text-decoration:\s*(underline|line-through))\s*$/i.test(
            item.trim(),
          ),
        )
      return safe.length ? `style="${safe.join(";")}"` : ""
    })
    .replace(/<img\b[^>]*src="(?!data:image\/(?:png|jpeg|gif|webp);base64,|blob:)[^"]*"[^>]*>/gi, "")
}

export function markdownDocumentHtml(text: string): string {
  return cleanDocumentHtml(documentMarkdown.parse(text, { async: false }))
}

export async function loadWorkbook(filename: string, original?: ArrayBuffer, text?: string): Promise<WorkbookContent> {
  const XLSX = await import("xlsx")
  if (original) {
    const workbook = XLSX.read(original, { type: "array", cellStyles: true, cellDates: false })
    const styles = /\.xlsx$/i.test(filename) ? await workbookStyles(original) : undefined
    return { workbook, original, styles }
  }
  const workbook = XLSX.utils.book_new()
  const sections = (text ?? "").split(/\n\n---\n\n/)
  for (const [index, section] of sections.entries()) {
    const heading = /^### Лист «(.+)»\s*\n/.exec(section)
    const source = section.replace(/^### Лист «.+»\s*\n/, "").trim()
    const sheet = heading
      ? XLSX.utils.aoa_to_sheet(
          source
            .split(/\r?\n/)
            .map((line) => line.split(/\s\|\s/).map((cell) => cell.replace(/^"|"$/g, "").replace(/""/g, '"'))),
        )
      : XLSX.read(source, { type: "string" }).Sheets.Sheet1
    XLSX.utils.book_append_sheet(
      workbook,
      sheet ?? XLSX.utils.aoa_to_sheet([]),
      (heading?.[1] ?? `Лист ${index + 1}`).slice(0, 31),
    )
  }
  return { workbook }
}

export function cellValue(cell: import("xlsx").CellObject | undefined): string {
  if (!cell) return ""
  return cell.f ? `=${cell.f}` : String(cell.v ?? "")
}

async function workbookStyles(original: ArrayBuffer) {
  const { default: JSZip } = await import("jszip")
  const archive = await JSZip.loadAsync(original)
  const parse = (text: string) => new DOMParser().parseFromString(text, "application/xml")
  const stylesEntry = archive.file("xl/styles.xml")
  if (!stylesEntry) return undefined
  const styles = parse(await stylesEntry.async("string"))
  const fonts = Array.from(styles.getElementsByTagName("fonts")[0]?.children ?? [])
  const fills = Array.from(styles.getElementsByTagName("fills")[0]?.children ?? [])
  const formats = Array.from(styles.getElementsByTagName("cellXfs")[0]?.children ?? [])
  const rgb = (node?: Element) => {
    const color = node?.getAttribute("rgb")
    return color && /^[\da-f]{6,8}$/i.test(color) ? `#${color.slice(-6)}` : undefined
  }
  const css = formats.map((format) => {
    const font = fonts[Number(format.getAttribute("fontId") ?? 0)]
    const fill = fills[Number(format.getAttribute("fillId") ?? 0)]
    const alignment = format.getElementsByTagName("alignment")[0]
    const result: Record<string, string> = {}
    if (font?.getElementsByTagName("b").length) result["font-weight"] = "700"
    if (font?.getElementsByTagName("i").length) result["font-style"] = "italic"
    if (font?.getElementsByTagName("u").length) result["text-decoration"] = "underline"
    const fontSize = font?.getElementsByTagName("sz")[0]?.getAttribute("val")
    if (fontSize && Number(fontSize) > 0 && Number(fontSize) < 100) result["font-size"] = `${fontSize}pt`
    const color = rgb(font?.getElementsByTagName("color")[0])
    const background = rgb(fill?.getElementsByTagName("fgColor")[0])
    if (color) result.color = color
    if (background) result["background-color"] = background
    const horizontal = alignment?.getAttribute("horizontal")
    if (horizontal && ["left", "center", "right", "justify"].includes(horizontal)) result["text-align"] = horizontal
    const vertical = alignment?.getAttribute("vertical")
    if (vertical && ["top", "center", "bottom"].includes(vertical))
      result["vertical-align"] = vertical === "center" ? "middle" : vertical
    return result
  })
  const workbook = parse(await archive.file("xl/workbook.xml")!.async("string"))
  const relations = parse(await archive.file("xl/_rels/workbook.xml.rels")!.async("string"))
  const result: Record<string, Record<string, Record<string, string>>> = {}
  for (const sheet of Array.from(workbook.getElementsByTagName("sheet"))) {
    const relation = Array.from(relations.getElementsByTagName("Relationship")).find(
      (item) => item.getAttribute("Id") === sheet.getAttribute("r:id"),
    )
    const target = relation?.getAttribute("Target")
    const entry = target
      ? archive.file(target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`)
      : null
    if (!entry) continue
    const xml = parse(await entry.async("string"))
    result[sheet.getAttribute("name")!] = Object.fromEntries(
      Array.from(xml.getElementsByTagName("c"))
        .filter((cell) => cell.hasAttribute("s"))
        .map((cell) => [cell.getAttribute("r")!, css[Number(cell.getAttribute("s"))] ?? {}]),
    )
  }
  return result
}

export async function workbookBlob(content: WorkbookContent, changes: CellChanges, filename: string): Promise<Blob> {
  const XLSX = await import("xlsx")
  const workbook = XLSX.read(XLSX.write(content.workbook, { type: "array", bookType: "xlsx" }), { type: "array" })
  for (const [name, cells] of Object.entries(changes)) {
    const sheet = workbook.Sheets[name]
    if (!Object.hasOwn(workbook.Sheets, name) || !sheet) continue
    for (const [address, value] of Object.entries(cells)) {
      const previous = sheet[address]
      sheet[address] = value.startsWith("=")
        ? { ...previous, t: "n", f: value.slice(1), v: undefined }
        : value.trim() !== "" && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value) && previous?.t !== "s"
          ? { ...previous, t: "n", v: Number(value), f: undefined, w: undefined }
          : { ...previous, t: "s", v: value, f: undefined, w: undefined }
    }
  }
  if (/\.csv$/i.test(filename)) {
    return new Blob(["\ufeff", XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]])], {
      type: "text/csv;charset=utf-8",
    })
  }
  if (!content.original || !/\.xlsx$/i.test(filename)) {
    return new Blob([XLSX.write(workbook, { type: "array", bookType: "xlsx", cellStyles: true })], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })
  }
  const { default: JSZip } = await import("jszip")
  const archive = await JSZip.loadAsync(content.original)
  const workbookXml = new DOMParser().parseFromString(
    await archive.file("xl/workbook.xml")!.async("string"),
    "application/xml",
  )
  const relationships = new DOMParser().parseFromString(
    await archive.file("xl/_rels/workbook.xml.rels")!.async("string"),
    "application/xml",
  )
  const sheets = Array.from(workbookXml.getElementsByTagName("sheet"))
  for (const [name, cells] of Object.entries(changes)) {
    if (!Object.keys(cells).length) continue
    const sheet = sheets.find((item) => item.getAttribute("name") === name)
    const relation = Array.from(relationships.getElementsByTagName("Relationship")).find(
      (item) => item.getAttribute("Id") === sheet?.getAttribute("r:id"),
    )
    const target = relation?.getAttribute("Target")
    if (!target) throw new Error("Не удалось сохранить структуру листа")
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`
    const entry = archive.file(path)
    if (!entry) throw new Error("Лист не найден в исходном файле")
    const xml = new DOMParser().parseFromString(await entry.async("string"), "application/xml")
    const namespace = xml.documentElement.namespaceURI
    const data = xml.getElementsByTagName("sheetData")[0]
    for (const [address, value] of Object.entries(cells)) {
      const rowNumber = address.replace(/^[A-Z]+/, "")
      const existing = Array.from(data.getElementsByTagName("row")).find((item) => item.getAttribute("r") === rowNumber)
      const row = existing ?? xml.createElementNS(namespace, "row")
      row.setAttribute("r", rowNumber)
      if (!existing) data.appendChild(row)
      const old = Array.from(row.children).find((item) => item.getAttribute("r") === address)
      const cell = old ?? xml.createElementNS(namespace, "c")
      cell.setAttribute("r", address)
      cell.replaceChildren()
      cell.removeAttribute("t")
      if (value.startsWith("=")) {
        const formula = xml.createElementNS(namespace, "f")
        formula.textContent = value.slice(1)
        cell.appendChild(formula)
      } else if (
        value.trim() !== "" &&
        /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value) &&
        content.workbook.Sheets[name]?.[address]?.t !== "s"
      ) {
        const numeric = xml.createElementNS(namespace, "v")
        numeric.textContent = value
        cell.appendChild(numeric)
      } else {
        cell.setAttribute("t", "inlineStr")
        const inline = xml.createElementNS(namespace, "is")
        const text = xml.createElementNS(namespace, "t")
        text.setAttribute("xml:space", "preserve")
        text.textContent = value
        inline.appendChild(text)
        cell.appendChild(inline)
      }
      if (!old) row.appendChild(cell)
      Array.from(row.children)
        .sort(
          (left, right) =>
            XLSX.utils.decode_cell(left.getAttribute("r")!).c - XLSX.utils.decode_cell(right.getAttribute("r")!).c,
        )
        .forEach((item) => row.appendChild(item))
    }
    Array.from(data.children)
      .sort((left, right) => Number(left.getAttribute("r")) - Number(right.getAttribute("r")))
      .forEach((item) => data.appendChild(item))
    archive.file(path, new XMLSerializer().serializeToString(xml))
  }
  if (Object.values(changes).some((cells) => Object.keys(cells).length)) {
    archive.remove("xl/calcChain.xml")
    Array.from(relationships.getElementsByTagName("Relationship"))
      .filter((item) => item.getAttribute("Type")?.endsWith("/calcChain"))
      .forEach((item) => item.remove())
    archive.file("xl/_rels/workbook.xml.rels", new XMLSerializer().serializeToString(relationships))
    const typesEntry = archive.file("[Content_Types].xml")
    if (typesEntry) {
      const types = new DOMParser().parseFromString(await typesEntry.async("string"), "application/xml")
      Array.from(types.getElementsByTagName("Override"))
        .filter((item) => item.getAttribute("PartName") === "/xl/calcChain.xml")
        .forEach((item) => item.remove())
      archive.file("[Content_Types].xml", new XMLSerializer().serializeToString(types))
    }
    const calculation =
      workbookXml.getElementsByTagName("calcPr")[0] ??
      workbookXml.createElementNS(workbookXml.documentElement.namespaceURI, "calcPr")
    calculation.setAttribute("fullCalcOnLoad", "1")
    calculation.setAttribute("forceFullCalc", "1")
    workbookXml.documentElement.appendChild(calculation)
    archive.file("xl/workbook.xml", new XMLSerializer().serializeToString(workbookXml))
  }
  return archive.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
}

export function downloadDocumentBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename.replace(/[\\/:*?"<>|]/g, "_")
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

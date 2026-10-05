import { describe, expect, test } from "bun:test"
import { cleanDocumentHtml, loadWorkbook, markdownDocumentHtml, workbookBlob } from "./document-content"
import { exportHtmlDocument } from "./document-export"
import * as XLSX from "xlsx"
import JSZip from "jszip"
import { marked } from "marked"

describe("document workspace", () => {
  test("keeps document Markdown independent of asynchronous chat plugins", () => {
    const previous = marked.defaults.async
    marked.setOptions({ async: true })
    try {
      expect(markdownDocumentHtml("# Документ")).toContain("<h1>Документ</h1>")
    } finally {
      marked.setOptions({ async: previous })
    }
  })
  test("renders semantic document structure and removes executable and remote content", () => {
    const html = markdownDocumentHtml(
      "# Договор\n\n**Сумма** — 1000 ₽\n\n| Пункт | Условие |\n| --- | --- |\n| 1 | Оплата |",
    )
    expect(html).toContain("<h1>Договор</h1>")
    expect(html).toContain("<strong>Сумма</strong>")
    expect(html).toContain("<table>")
    const safe = cleanDocumentHtml(
      '<p onclick="alert(1)" style="color:red;background:url(https://example.com/leak);text-align:center">Текст</p><script>bad()</script><a href="javascript:alert(1)">Ссылка</a><img src="https://example.com/leak"><iframe src="https://example.com"></iframe>',
    )
    expect(safe).toContain("text-align:center")
    expect(safe).not.toMatch(/onclick|javascript:|background|<script|<iframe|https:\/\/example/)
  })

  test("exports edited XLSX preserving other sheets, formulas, merges and archive content", async () => {
    const book = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Название", "Значение"],
      ["Сумма", 1000],
      ["Код", "00123"],
    ])
    sheet.B4 = { t: "n", f: "B2*2", v: 2000 }
    sheet["!ref"] = "A1:B4"
    sheet["!merges"] = [XLSX.utils.decode_range("A1:B1")]
    XLSX.utils.book_append_sheet(book, sheet, "Расчёты")
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Не изменять", 42]]), "Архив")
    const zip = await JSZip.loadAsync(XLSX.write(book, { type: "array", bookType: "xlsx" }))
    zip.file("customXml/isaac.txt", "Оригинальные метаданные")
    const original = await zip.generateAsync({ type: "arraybuffer" })
    const content = await loadWorkbook("example.xlsx", original)
    const edited = await workbookBlob(content, { Расчёты: { B2: "2500", B3: "00456" } }, "example.xlsx")
    const result = XLSX.read(await edited.arrayBuffer(), { type: "array" })
    expect(result.Sheets.Расчёты.B2.v).toBe(2500)
    expect(result.Sheets.Расчёты.B3.v).toBe("00456")
    expect(result.Sheets.Расчёты.B4.f).toBe("B2*2")
    expect(result.Sheets.Расчёты["!merges"]).toEqual(sheet["!merges"])
    expect(result.Sheets.Архив.B1.v).toBe(42)
    const outputZip = await JSZip.loadAsync(await edited.arrayBuffer())
    expect(await outputZip.file("customXml/isaac.txt")!.async("string")).toBe("Оригинальные метаданные")
    expect(await outputZip.file("xl/styles.xml")!.async("string")).toBe(
      await zip.file("xl/styles.xml")!.async("string"),
    )
  })

  test("restores legacy spreadsheet text with named sheets", async () => {
    const loaded = await loadWorkbook(
      "balance.xlsx",
      undefined,
      '### Лист «Расчёты»\n\n№ | Контрагент | Сумма\n1 | "ООО «Альфа»" | 1000',
    )
    expect(loaded.workbook.SheetNames).toEqual(["Расчёты"])
    expect(loaded.workbook.Sheets.Расчёты.B2.v).toBe("ООО «Альфа»")
  })

  test("exports formatted text, nested lists and tables into an actual DOCX", async () => {
    const blob = await exportHtmlDocument(
      "<h1>Договор</h1><p><strong>Сумма</strong> — 1000 ₽</p><ul><li>Первый<ul><li>Вложенный</li></ul></li></ul><table><tr><th>Пункт</th><th>Условие</th></tr><tr><td>1</td><td>Оплата</td></tr></table>",
      "docx",
      "Договор",
    )
    const archive = await JSZip.loadAsync(await blob.arrayBuffer())
    const xml = await archive.file("word/document.xml")!.async("string")
    expect(xml).toContain("Договор")
    expect(xml).toContain("Вложенный")
    expect(xml).toContain("<w:tbl>")
    expect(xml).toContain("<w:b/>")
    expect(xml).not.toContain("**Сумма**")
  })

  test("exports readable Cyrillic PDF with merged cells and nested lists", async () => {
    const html =
      '<h1>Договор проверки</h1><ul><li>Первый<ul><li>Вложенный пункт</li></ul></li></ul><table><tr><th rowspan="2">Услуга</th><th colspan="2">Сумма</th></tr><tr><td>Цена</td><td>Налог</td></tr><tr><td>Проверка</td><td>1000</td><td>200</td></tr></table>'
    const blob = await exportHtmlDocument(html, "pdf", "Договор проверки")
    const { extractText } = await import("unpdf")
    const result = await extractText(new Uint8Array(await blob.arrayBuffer()), { mergePages: true })
    expect(result.text).toContain("Договор проверки")
    expect(result.text).toContain("Вложенный пункт")
    expect(result.text).toContain("1000")
    expect(result.text).toContain("Налог")
  })

  test("preserves embedded image aspect ratio in DOCX and images in PDF", async () => {
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPgDnb9j4wZ0AUA0voNESVG0ogAAAAASUVORK5CYII="
    const html = `<p>Изображение</p><p><img src="${image}"></p>`
    const docx = await exportHtmlDocument(html, "docx", "Изображение")
    const archive = await JSZip.loadAsync(await docx.arrayBuffer())
    const xml = await archive.file("word/document.xml")!.async("string")
    const size = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml)
    expect(Number(size?.[1])).toBe(Number(size?.[2]) * 2)
    expect(Object.keys(archive.files).some((path) => path.startsWith("word/media/") && path.endsWith(".png"))).toBe(
      true,
    )
    const pdf = await exportHtmlDocument(html, "pdf", "Изображение")
    expect(new TextDecoder().decode(await pdf.arrayBuffer())).toContain("/Subtype /Image")
  })
})

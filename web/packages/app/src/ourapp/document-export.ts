import { cleanDocumentHtml } from "./document-content"
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces"

function rootFor(html: string) {
  const root = document.createElement("div")
  root.innerHTML = cleanDocumentHtml(html)
  return root
}

function imageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  if (bytes.length >= 10 && bytes[0] === 71 && bytes[1] === 73)
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 255) break
      const marker = bytes[offset + 1]
      const length = view.getUint16(offset + 2)
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      if (length < 2) break
      offset += length + 2
    }
  }
  throw new Error("Не удалось прочитать изображение в документе")
}

async function normalizeImages(root: HTMLElement) {
  for (const image of Array.from(root.querySelectorAll("img"))) {
    const source = image.getAttribute("src") ?? ""
    if (/^data:image\/(png|jpeg);base64,/i.test(source)) continue
    const response = await fetch(source)
    if (!response.ok) throw new Error("Не удалось прочитать изображение для экспорта")
    const bitmap = await createImageBitmap(await response.blob())
    try {
      const canvas = document.createElement("canvas")
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0)
      image.setAttribute("src", canvas.toDataURL("image/png"))
    } finally {
      bitmap.close()
    }
  }
}

export async function exportHtmlDocument(html: string, format: "docx" | "pdf", title: string): Promise<Blob> {
  const root = rootFor(html)
  if (!root.textContent?.trim() && !root.querySelector("img")) throw new Error("Документ пуст")
  await normalizeImages(root)
  if (format === "pdf") return htmlPdf(root, title)
  const docx = await import("docx")
  type Inline = import("docx").TextRun | import("docx").ExternalHyperlink | import("docx").ImageRun
  const runs = (
    node: Node,
    style: { bold?: boolean; italics?: boolean; underline?: object; superScript?: boolean; subScript?: boolean } = {},
  ): Inline[] => {
    if (node.nodeType === Node.TEXT_NODE) return [new docx.TextRun({ text: node.textContent ?? "", ...style })]
    if (!(node instanceof HTMLElement)) return []
    if (node.tagName === "BR") return [new docx.TextRun({ break: 1 })]
    const next = {
      ...style,
      ...(["B", "TH", "STRONG"].includes(node.tagName) ? { bold: true } : {}),
      ...(["I", "EM"].includes(node.tagName) ? { italics: true } : {}),
      ...(node.tagName === "U" ? { underline: {} } : {}),
      ...(node.tagName === "SUP" ? { superScript: true } : {}),
      ...(node.tagName === "SUB" ? { subScript: true } : {}),
      ...(node.style.fontWeight === "bold" || Number(node.style.fontWeight) >= 600 ? { bold: true } : {}),
      ...(node.style.fontStyle === "italic" ? { italics: true } : {}),
      ...(node.style.textDecoration === "underline" ? { underline: {} } : {}),
    }
    if (node.tagName === "A" && /^https?:\/\//i.test(node.getAttribute("href") ?? "")) {
      return [
        new docx.ExternalHyperlink({
          link: node.getAttribute("href")!,
          children: [new docx.TextRun({ text: node.textContent ?? "", style: "Hyperlink" })],
        }),
      ]
    }
    if (node.tagName === "IMG") {
      const source = node.getAttribute("src") ?? ""
      const match = /^data:image\/(png|jpeg|gif);base64,(.+)$/.exec(source)
      if (!match) return []
      const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0))
      const dimensions = imageDimensions(bytes)
      const scale = Math.min(1, 640 / dimensions.width, 850 / dimensions.height)
      return [
        new docx.ImageRun({
          data: bytes,
          type: match[1] === "jpeg" ? "jpg" : (match[1] as "png" | "gif"),
          transformation: { width: dimensions.width * scale, height: dimensions.height * scale },
        }),
      ]
    }
    return Array.from(node.childNodes).flatMap((child) => runs(child, next))
  }
  const blocks = (parent: Element, level = 0): (import("docx").Paragraph | import("docx").Table)[] => {
    return Array.from(parent.childNodes).flatMap((node): (import("docx").Paragraph | import("docx").Table)[] => {
      if (node.nodeType === Node.TEXT_NODE)
        return node.textContent?.trim() ? [new docx.Paragraph({ children: runs(node) })] : []
      if (!(node instanceof HTMLElement)) return []
      if (["UL", "OL"].includes(node.tagName))
        return Array.from(node.children).flatMap((item, index) => [
          new docx.Paragraph({
            ...(node.tagName === "UL"
              ? { bullet: { level: Math.min(level, 8) } }
              : {
                  indent: { left: (level + 1) * 360 },
                  children: [
                    new docx.TextRun(`${Number(node.getAttribute("start") ?? 1) + index}. `),
                    ...Array.from(item.childNodes)
                      .filter((child) => !(child instanceof HTMLElement && ["UL", "OL"].includes(child.tagName)))
                      .flatMap((child) => runs(child)),
                  ],
                }),
            ...(node.tagName === "UL"
              ? {
                  children: Array.from(item.childNodes)
                    .filter((child) => !(child instanceof HTMLElement && ["UL", "OL"].includes(child.tagName)))
                    .flatMap((child) => runs(child)),
                }
              : {}),
          }),
          ...Array.from(item.children)
            .filter((child) => ["UL", "OL"].includes(child.tagName))
            .flatMap((child) => {
              const container = document.createElement("div")
              container.appendChild(child.cloneNode(true))
              return blocks(container, level + 1)
            }),
        ])
      if (node.tagName === "TABLE") {
        return [
          new docx.Table({
            width: { size: 100, type: docx.WidthType.PERCENTAGE },
            rows: Array.from(
              node.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr"),
            ).map(
              (row) =>
                new docx.TableRow({
                  tableHeader: !!row.querySelector("th"),
                  children: Array.from(row.children).map(
                    (cell) =>
                      new docx.TableCell({
                        columnSpan: Number(cell.getAttribute("colspan") ?? 1),
                        rowSpan: Number(cell.getAttribute("rowspan") ?? 1),
                        margins: { top: 100, bottom: 100, left: 100, right: 100 },
                        children: cell.querySelector("p, div, ul, ol")
                          ? blocks(cell)
                          : [new docx.Paragraph({ children: runs(cell, { bold: cell.tagName === "TH" }) })],
                      }),
                  ),
                }),
            ),
          }),
        ]
      }
      if (node.tagName === "DIV" && node.querySelector("p,table,h1,h2,h3,ul,ol")) return blocks(node, level)
      const heading = /^H([1-6])$/.exec(node.tagName)
      const alignment = node.style.textAlign
      return [
        new docx.Paragraph({
          heading: heading
            ? [
                docx.HeadingLevel.HEADING_1,
                docx.HeadingLevel.HEADING_2,
                docx.HeadingLevel.HEADING_3,
                docx.HeadingLevel.HEADING_4,
                docx.HeadingLevel.HEADING_5,
                docx.HeadingLevel.HEADING_6,
              ][Number(heading[1]) - 1]
            : undefined,
          alignment:
            alignment === "center"
              ? docx.AlignmentType.CENTER
              : alignment === "right"
                ? docx.AlignmentType.RIGHT
                : alignment === "justify"
                  ? docx.AlignmentType.JUSTIFIED
                  : docx.AlignmentType.LEFT,
          spacing: { after: 140, line: 300 },
          children: runs(node),
        }),
      ]
    })
  }
  return docx.Packer.toBlob(
    new docx.Document({
      creator: "Isaac",
      title,
      styles: { default: { document: { run: { font: "Times New Roman", size: 24 } } } },
      sections: [
        {
          properties: {
            page: {
              size: { width: 11906, height: 16838 },
              margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
            },
          },
          children: blocks(root),
        },
      ],
    }),
  )
}

async function htmlPdf(root: HTMLElement, title: string): Promise<Blob> {
  const [pdfModule, fonts] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")])
  const pdf = pdfModule.default
  pdf.addVirtualFileSystem(fonts.default)
  const inline = (
    node: Node,
    style: { bold?: boolean; italics?: boolean; decoration?: "underline" } = {},
  ): Content[] => {
    if (node.nodeType === Node.TEXT_NODE) return [{ text: node.textContent ?? "", ...style }]
    if (!(node instanceof HTMLElement)) return []
    if (node.tagName === "BR") return ["\n"]
    if (node.tagName === "IMG") return []
    const next = {
      ...style,
      ...(["STRONG", "B", "TH"].includes(node.tagName) ||
      node.style.fontWeight === "bold" ||
      Number(node.style.fontWeight) >= 600
        ? { bold: true }
        : {}),
      ...(["I", "EM"].includes(node.tagName) || node.style.fontStyle === "italic" ? { italics: true } : {}),
      ...(node.tagName === "U" || node.style.textDecoration === "underline"
        ? { decoration: "underline" as const }
        : {}),
    }
    if (node.tagName === "A")
      return [{ text: node.textContent ?? "", link: node.getAttribute("href") ?? undefined, ...next }]
    return Array.from(node.childNodes).flatMap((child) => inline(child, next))
  }
  const imageBlock = (image: Element): Content => ({
    image: image.getAttribute("src")!,
    fit: [480, 640],
    margin: [0, 4, 0, 8],
  })
  const blocks = (parent: Element): Content[] =>
    Array.from(parent.childNodes).flatMap((node): Content[] => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent?.trim() ? [{ text: node.textContent }] : []
      if (!(node instanceof HTMLElement)) return []
      if (node.tagName === "IMG") return [imageBlock(node)]
      if (node.tagName === "TABLE") {
        const rows = Array.from(
          node.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr"),
        )
        const body: TableCell[][] = rows.map(() => [])
        const occupied = new Set<string>()
        rows.forEach((row, rowIndex) => {
          let column = 0
          for (const cell of Array.from(row.children)) {
            const colSpan = Number(cell.getAttribute("colspan") ?? 1)
            const rowSpan = Math.min(rows.length - rowIndex, Number(cell.getAttribute("rowspan") ?? 1))
            while (
              Array.from({ length: colSpan }, (_, offset) => occupied.has(`${rowIndex}:${column + offset}`)).some(
                Boolean,
              )
            )
              column++
            body[rowIndex][column] = {
              stack: blocks(cell),
              colSpan,
              rowSpan,
              margin: [4, 4, 4, 4],
              bold: cell.tagName === "TH",
            }
            for (let rowOffset = 0; rowOffset < rowSpan; rowOffset++) {
              for (let columnOffset = 0; columnOffset < colSpan; columnOffset++) {
                occupied.add(`${rowIndex + rowOffset}:${column + columnOffset}`)
                if (rowOffset || columnOffset) body[rowIndex + rowOffset][column + columnOffset] = { text: "" }
              }
            }
            column += colSpan
          }
        })
        const columns = Math.max(0, ...body.map((row) => row.length))
        return body.length && columns
          ? [
              {
                table: {
                  widths: Array.from({ length: columns }, () => "*"),
                  body: body.map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? { text: "" })),
                },
                margin: [0, 8, 0, 12],
              },
            ]
          : []
      }
      if (node.tagName === "UL")
        return [{ ul: Array.from(node.children).map((item) => ({ stack: blocks(item) })), margin: [0, 4, 0, 8] }]
      if (node.tagName === "OL")
        return [
          {
            ol: Array.from(node.children).map((item) => ({ stack: blocks(item) })),
            start: Number(node.getAttribute("start") ?? 1),
            margin: [0, 4, 0, 8],
          },
        ]
      if (node.tagName === "DIV" && node.querySelector("p,table,h1,h2,h3,ul,ol")) return blocks(node)
      const heading = /^H([1-6])$/.exec(node.tagName)
      const alignment = node.style.textAlign
      return [
        {
          text: inline(node),
          fontSize: heading ? 20 - Number(heading[1]) * 2 : 12,
          bold: !!heading,
          margin: [0, heading ? 12 : 0, 0, 8],
          alignment: ["left", "center", "right", "justify"].includes(alignment)
            ? (alignment as "left" | "center" | "right" | "justify")
            : "left",
        },
        ...Array.from(node.querySelectorAll("img")).map(imageBlock),
      ]
    })
  const definition: TDocumentDefinitions = {
    info: { title, creator: "Isaac" },
    pageSize: "A4",
    pageMargins: [56, 56, 56, 56],
    defaultStyle: { font: "Roboto", fontSize: 12, lineHeight: 1.3 },
    content: blocks(root),
    footer: (page, pages) => ({ text: `${page} / ${pages}`, alignment: "center", fontSize: 9 }),
  }
  return pdf.createPdf(definition).getBlob()
}

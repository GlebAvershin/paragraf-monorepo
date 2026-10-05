/**
 * OurApp — клиентский экспорт markdown → DOCX.
 *
 * Работает в renderer'е без зависимости от модели. Пользователь может скачать
 * любой ответ ассистента как .docx — независимо от поддержки tool-вызовов
 * выбранной моделью.
 *
 * Dynamic import библиотеки `docx` (~600KB) — раздуваем bundle только при
 * первом нажатии «Скачать .docx».
 */

import { openArtifactPreview, type ArtifactInfo } from "./artifact-preview"

/**
 * Зарегистрировать функцию downloadMarkdownAsDocx в глобальном scope, чтобы
 * UI-пакет (без cross-package import'а) мог её вызвать. Вызывается из app.tsx
 * на старте через side-effect.
 */
if (typeof window !== "undefined") {
  ;(window as { ourappDocExport?: typeof downloadMarkdownAsDocx }).ourappDocExport =
    (md: string, opts?: ExportOptions) => downloadMarkdownAsDocx(md, opts ?? {})
}

export interface ExportOptions {
  /** Заголовок документа. Если опущен — берётся первая строка-заголовок из markdown. */
  title?: string
  /** Имя файла (без .docx). Если опущен — слаг из title или "document". */
  filename?: string
  /** Если true — после генерации откроет preview-панель (DOCX → HTML через mammoth). */
  showPreview?: boolean
  /** Если true — не скачивать файл, только показать preview. */
  skipDownload?: boolean
}

/**
 * Главная функция — конвертирует markdown в DOCX, триггерит браузерное скачивание,
 * опционально показывает preview-панель. Возвращает true если успех.
 */
export async function downloadMarkdownAsDocx(
  markdown: string,
  opts: ExportOptions = {},
): Promise<boolean> {
  const trimmed = markdown.trim()
  if (!trimmed) return false

  const title = opts.title ?? extractTitleFromMarkdown(trimmed) ?? "Документ"
  const baseName = opts.filename ?? slugify(title) ?? "document"

  try {
    const cleaned = stripMetaBlocks(trimmed)
    const { markdownDocumentHtml, downloadDocumentBlob } = await import("./document-content")
    const { exportHtmlDocument } = await import("./document-export")
    const html = markdownDocumentHtml(cleaned)
    const blob = await exportHtmlDocument(html, "docx", title)
    const fullName = `${baseName}.docx`
    if (!opts.skipDownload) downloadDocumentBlob(blob, fullName)
    if (opts.showPreview) {
      const info: ArtifactInfo = {
        filename: fullName, path: fullName, bytes: blob.size,
        html, text: cleaned, blobUrl: URL.createObjectURL(blob),
      }
      openArtifactPreview(info)
    }
    return true
  } catch (err) {
    console.error("[doc-export] DOCX generation failed", err)
    return false
  }
}


/**
 * Убирает технические блоки, которые модель (особенно GigaChat) пишет как текст:
 * "ФАЙЛ", "[filename.docx]", "(Attachement:...)", ссылки на скачивание и т.д.
 */
function stripMetaBlocks(md: string): string {
  // Phase 1: remove inline patterns that GigaChat embeds (may be mid-paragraph)
  let cleaned = md
    // [Filename.docx] — fake attachment link
    .replace(/\[.*?\.docx\]/gi, "")
    // (Attachement:...) or (Attachment:...) — fake download URL
    .replace(/\(Attach[ea]?ment[:%][^)]*\)/gi, "")

  // Phase 2: remove whole lines that are meta-noise
  cleaned = cleaned
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      // "## ФАЙЛ" or "ФАЙЛ" heading
      if (/^#{0,3}\s*ФАЙЛ\s*$/i.test(t)) return false
      // Standalone "Filename.docx" line
      if (/^[\w\sА-Яа-яёЁ\-_.]+\.docx\s*$/i.test(t) && t.length < 120) return false
      // "доступен в формате .docx, прикреплён ниже..."
      if (/доступен в формате\s+\.?docx/i.test(t)) return false
      if (/прикреплён ниже/i.test(t)) return false
      if (/можешь скачать/i.test(t)) return false
      // Line that became empty after phase 1
      if (!t) return false
      return true
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return cleaned
}

function extractTitleFromMarkdown(md: string): string | null {
  const heading = /^#\s+(.+)$/m.exec(md)
  if (heading) return heading[1].trim()
  const firstLine = md.split(/\r?\n/).find((l) => l.trim().length > 0)
  if (firstLine) return firstLine.replace(/^#+\s*/, "").slice(0, 80)
  return null
}

function slugify(s: string): string | null {
  const cleaned = s
    .toLowerCase()
    .replace(/[«»"'„"]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
  return cleaned || null
}

/**
 * DOCX text extraction via `mammoth`.
 * Returns clean Markdown-ish text, preserving headings and lists.
 */
import mammoth from "mammoth"
import type { DocSource, ParsedDoc } from "../types.ts"
import { loadBytes } from "./loader.ts"

// `convertToMarkdown` exists at runtime but isn't in mammoth's bundled types
// (only convertToHtml/extractRawText are). Declare its precise shape so we get
// full typing without an `as any` cast.
interface MammothMessage {
  type: string
  message: string
}
interface MammothResult {
  value: string
  messages: MammothMessage[]
}
type ConvertToMarkdown = (input: { buffer: Buffer }) => Promise<MammothResult>
const convertToMarkdown = (mammoth as unknown as { convertToMarkdown: ConvertToMarkdown })
  .convertToMarkdown

export async function parseDocx(source: DocSource): Promise<ParsedDoc> {
  const bytes = await loadBytes(source)
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // convertToMarkdown preserves structure (headings, lists, bold) better than extractRawText.
  const result = await convertToMarkdown({ buffer })

  const warnings = result.messages
    .filter((m) => m.type === "warning" || m.type === "error")
    .map((m) => m.message)

  // Mammoth aggressively backslash-escapes common punctuation in markdown output
  // (e.g. `.` → `\.`, `-` → `\-`, `!` → `\!`). For LLM consumption these escapes
  // are noise — strip them. Markdown chars that ARE structural (`#`, `*`, `_`, `>`)
  // are preserved.
  const cleaned = result.value.replace(/\\([.\-!?,:;()[\]{}<>+=~`'"])/g, "$1").trim()

  return {
    text: cleaned,
    metadata: {
      warnings,
    },
  }
}

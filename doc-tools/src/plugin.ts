/**
 * opencode plugin shape — exposes our parsers/generators as agent tools.
 *
 * NOTE: This file imports `@opencode-ai/plugin` and `@opencode-ai/llm`,
 * which only resolve when this package lives inside the opencode monorepo fork.
 * Until then, this file is reference-only; tests run on the pure functions.
 *
 * When integrating into the fork:
 *   1. Move this package to `packages/doc-tools/`.
 *   2. Add `"@opencode-ai/plugin": "workspace:*"` to dependencies.
 *   3. Register `DocToolsPlugin` in the desktop entrypoint's plugin list.
 */

// @ts-expect-error — resolves when in the opencode monorepo fork
import { tool, type Plugin } from "@opencode-ai/plugin"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { parsePdf, parseDocx, parseXlsx, xlsxToMarkdown, parseAny } from "./parsers/index.ts"
import { generateDocx } from "./generators/index.ts"
import type { DocxBlock } from "./types.ts"

export const DocToolsPlugin: Plugin = async (_ctx: unknown) => {
  return {
    tool: {
      parse_document: tool({
        description:
          "Извлечь текст из документа (PDF, DOCX, XLSX/CSV). Возвращает plain-text/markdown для анализа моделью. Используй когда пользователь приложил файл договора, отчёта или таблицы.",
        args: {
          path: tool.schema.string().describe("Абсолютный путь к файлу на диске пользователя."),
          format: tool.schema
            .enum(["pdf", "docx", "xlsx"])
            .optional()
            .describe("Формат файла. Если не указан — определяется по расширению."),
        },
        async execute(args: { path: string; format?: "pdf" | "docx" | "xlsx" }) {
          const parsed = await parseAny({ path: args.path, format: args.format })
          return {
            text: parsed.text,
            metadata: parsed.metadata,
          }
        },
      }),

      generate_docx: tool({
        description:
          "Сгенерировать DOCX-файл из структурированных блоков (заголовки, параграфы, таблицы) и сохранить на диск. Используй для финального документа: договор, претензия, пояснительная записка.",
        args: {
          outputPath: tool.schema.string().describe("Куда сохранить сгенерированный файл (.docx)."),
          title: tool.schema.string().optional().describe("Заголовок документа (метаданные)."),
          blocks: tool.schema
            .array(
              tool.schema.union([
                tool.schema.object({
                  kind: tool.schema.literal("heading"),
                  level: tool.schema.union([
                    tool.schema.literal(1),
                    tool.schema.literal(2),
                    tool.schema.literal(3),
                  ]),
                  text: tool.schema.string(),
                }),
                tool.schema.object({
                  kind: tool.schema.literal("paragraph"),
                  text: tool.schema.string(),
                  bold: tool.schema.boolean().optional(),
                  italic: tool.schema.boolean().optional(),
                }),
                tool.schema.object({
                  kind: tool.schema.literal("table"),
                  rows: tool.schema.array(tool.schema.array(tool.schema.string())),
                }),
                tool.schema.object({
                  kind: tool.schema.literal("spacer"),
                }),
              ]),
            )
            .describe("Массив блоков документа в порядке вывода."),
        },
        async execute(args: { outputPath: string; title?: string; blocks: readonly DocxBlock[] }) {
          const bytes = await generateDocx({
            title: args.title,
            blocks: args.blocks,
          })
          const abs = path.resolve(args.outputPath)
          await writeFile(abs, bytes)
          return { savedTo: abs, bytes: bytes.byteLength }
        },
      }),
    },
  }
}

// Re-export the pure functions for direct use (testing, non-opencode contexts).
export { parsePdf, parseDocx, parseXlsx, xlsxToMarkdown, parseAny, generateDocx }

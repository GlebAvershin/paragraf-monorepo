/**
 * OurApp — построение запроса из заполненного сценария (ТЗ-01 §6).
 *
 * Превращает сценарий + ответы в `Prompt` (ContentPart[]), который ставится
 * в composer и отправляется через обычный sendFollowupDraft — так мы
 * реюзаем streaming, guard кредитов и billing.
 *
 * file_upload шаги парсятся локально и прикрепляются как image-attachment-part
 * с extractedText — ровно как делает composer (attachments.ts):
 *   - office-документы (PDF/DOCX/XLSX) → parseOfficeDocumentLocally, mime "ourapp/office";
 *   - сканы-картинки (JPG/PNG/…) → ocrImageToText (локальный OCR), mime "ourapp/scanned-doc".
 * submit.ts (sendFollowupDraft) инлайнит текст обеих веток в запрос (поэтому даже
 * GigaChat «видит» документы) и маскирует ПДн для зарубежных моделей (152-ФЗ).
 */
import { uuid } from "@/utils/uuid"
import type { ContentPart, ImageAttachmentPart } from "@/context/prompt"
import { parseOfficeDocumentLocally } from "../doc-parse"
import { renderTemplate } from "./render-template"
import type { Scenario, ScenarioAnswers } from "./types"

/** Скан-картинка (фото/скан документа) — уходит картинкой в gateway на OCR (РФ). */
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|tiff?)$/i
function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXT.test(file.name)
}

/** Прочитать файл как data:URL (base64) для отправки картинки в gateway. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error("read failed"))
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "")
    r.readAsDataURL(file)
  })
}

export interface BuiltScenarioPrompt {
  /** Готовые части для prompt.set(). */
  parts: ContentPart[]
  /** Сколько файлов прикреплено (для аналитики/UI). */
  attachmentCount: number
  /**
   * Короткая сводка «что юзер реально ввёл в шагах» (label: ответ) — это,
   * а НЕ полный шаблон с инструкциями роли/структуры ответа, показывается
   * в чате как сообщение юзера (см. build-request-parts.ts: полный текст
   * уходит synthetic-частью в модель, эта сводка — обычной видимой частью).
   * Иначе юзер видит в своём же сообщении «Ты — инженер-нормоконтролёр…» —
   * запутывает (фидбэк 2026-07-02).
   */
  displayText: string
}

/** «Label: ответ» по каждому заполненному шагу — то, что видит юзер в чате. */
function buildDisplayText(scenario: Scenario, answers: ScenarioAnswers): string {
  const lines: string[] = []
  for (const step of scenario.steps) {
    const value = answers[step.id]
    if (value === undefined || value === null) continue
    let text: string
    if (step.type === "file_upload") {
      if (!Array.isArray(value) || value.length === 0) continue
      text = value.map((f) => f.name).join(", ")
    } else if (step.type === "boolean") {
      if (typeof value !== "boolean") continue
      text = value ? "да" : "нет"
    } else {
      if (typeof value !== "string" || value.trim().length === 0) continue
      text = value.trim()
    }
    lines.push(`${step.label}: ${text}`)
  }
  return lines.join("\n")
}

/**
 * Собрать prompt-части из сценария и ответов. Файлы парсятся параллельно.
 */
export async function buildScenarioPrompt(
  scenario: Scenario,
  answers: ScenarioAnswers,
): Promise<BuiltScenarioPrompt> {
  const text = renderTemplate(scenario.promptTemplate, answers)

  // Собираем все файлы из file_upload шагов.
  const files: File[] = []
  for (const step of scenario.steps) {
    if (step.type !== "file_upload") continue
    const value = answers[step.id]
    if (Array.isArray(value)) files.push(...value)
  }

  const attachments: ImageAttachmentPart[] = []
  if (files.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) throw new Error("Суммарный размер вложений сценария — до 20 МБ.")
  for (const file of files) {
    if (isImageFile(file)) {
      // Скан-картинка: прикрепляем КАК ЕСТЬ (image/*). OCR делает gateway (РФ), как и в
      // композере (attachments.ts) — картинка идёт browser→engine→gateway, не покидая РФ.
      const url = await fileToDataUrl(file).catch(() => "")
      if (!url) continue
      attachments.push({
        type: "image",
        id: uuid(),
        filename: file.name,
        mime: file.type || "image/png",
        dataUrl: url,
      })
      continue
    }
    const parsed = await parseOfficeDocumentLocally(file).catch(() => null)
    if (!parsed) continue
    attachments.push({
      type: "image",
      id: uuid(),
      filename: parsed.filename,
      mime: "ourapp/office",
      dataUrl: await fileToDataUrl(file),
      extractedText: parsed.text,
      originalMime: file.type || "application/octet-stream",
    })
  }

  // Порядок: сначала вложения (документы), затем текст-инструкция.
  const parts: ContentPart[] = [
    ...attachments,
    { type: "text", content: text, start: 0, end: text.length },
  ]

  return { parts, attachmentCount: attachments.length, displayText: buildDisplayText(scenario, answers) }
}

/**
 * Валидация ответов: все required-шаги заполнены. Возвращает id незаполненных.
 */
export function findMissingRequired(scenario: Scenario, answers: ScenarioAnswers): string[] {
  const missing: string[] = []
  for (const step of scenario.steps) {
    if (!step.required) continue
    const value = answers[step.id]
    const filled =
      step.type === "file_upload"
        ? Array.isArray(value) && value.length > 0
        : step.type === "boolean"
          ? typeof value === "boolean"
          : typeof value === "string" && value.trim().length > 0
    if (!filled) missing.push(step.id)
  }
  return missing
}

/** Рекомендуемая для сценария модель-код (для preview стоимости / выбора). */
export function scenarioModelCode(scenario: Scenario): string | undefined {
  return scenario.preferredModel
}

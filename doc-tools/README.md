# @ourapp/doc-tools

Парсеры PDF/DOCX/XLSX и генератор DOCX. Самостоятельный пакет: разрабатывается и тестируется отдельно, потом переезжает в форк `opencode/packages/doc-tools/` и подключается как агентный плагин.

## Зачем отдельно

- **Тестируется юнит-тестами**, не требуя поднятого opencode и LLM.
- **Pure JS** — никаких нативных зависимостей, работает в Bun из коробки.
- **Не блокирует** работу над Gateway/Billing — параллельный трек.
- Когда форк готов — просто меняем `package.json` зависимости и регистрируем плагин.

## Стек

| Задача | Библиотека | Почему |
|---|---|---|
| PDF → текст | `unpdf` | Pure JS, Bun-friendly, без native deps |
| DOCX → markdown | `mammoth` | Стандарт де-факто, сохраняет структуру |
| XLSX/CSV → данные | `xlsx` (SheetJS) | Самая зрелая JS-библиотека для таблиц |
| Текст → DOCX | `docx` | Pure JS генератор, поддерживает таблицы/стили |

## API (как pure functions)

```ts
import { parsePdf, parseDocx, parseXlsx, parseAny, generateDocx } from "@ourapp/doc-tools"

// Парсеры — принимают путь к файлу ИЛИ Uint8Array/ArrayBuffer.
const pdf = await parsePdf({ path: "/path/to/contract.pdf" })
//        ↳ { text: "## Страница 1\n\n...", metadata: { pages: 12, warnings: [] } }

const docx = await parseDocx({ buffer: uploadedBytes })
//         ↳ { text: "# Договор...", metadata: { warnings: [...] } }

const xlsx = await parseXlsx({ path: "/balance.xlsx" })
//         ↳ { sheets: [{ name, rows }, ...], metadata: { sheetCount, totalRows } }

// Auto-detect по расширению.
const any = await parseAny({ path: "/upload.docx" })

// Генератор: структурные блоки → DOCX-байты.
const bytes = await generateDocx({
  title: "Претензия",
  blocks: [
    { kind: "heading", level: 1, text: "ПРЕТЕНЗИЯ" },
    { kind: "paragraph", text: "В адрес ООО «Ромашка»..." },
    { kind: "table", rows: [["№", "Сумма"], ["1", "100 000 руб."]] },
  ],
})
await Bun.write("/output/претензия.docx", bytes)
```

## API (как opencode-плагин)

В форке opencode, после переезда:

```ts
// packages/desktop/src/main/plugins.ts (или аналогичный entrypoint)
import { DocToolsPlugin } from "@ourapp/doc-tools/plugin"
// Регистрируется наряду с другими плагинами; tools `parse_document` и `generate_docx`
// становятся доступны агенту автоматически.
```

Агент тогда видит два инструмента:

- `parse_document(path, format?)` → возвращает извлечённый текст и метаданные
- `generate_docx(outputPath, title?, blocks[])` → создаёт DOCX, возвращает путь

## Quick start

```bash
bun install
bun test           # round-trip тесты (без внешних фикстур)
bun test --watch
```

## Добавление test fixtures

Положите реальные файлы в `test/fixtures/` (gitignored):

```
test/fixtures/
├── sample-contract.pdf
├── sample-contract.docx
└── sample-balance.xlsx
```

PDF-парсер протестируется на них автоматически (см. `test/parsers.test.ts`, `describe.skipIf`).

## Ограничения текущей версии

- **OCR не поддерживается** — скан-копии PDF возвращают warning, текст не извлечётся. Phase 2: добавим `tesseract.js`.
- **Максимум 50 MB** на документ (hard cap в `loader.ts`).
- **Таблицы в PDF** парсятся как плоский текст — структура колонок может потеряться.
- **Изображения в DOCX** игнорируются (mammoth их отбрасывает по умолчанию).

## Roadmap

| Что | Когда |
|---|---|
| OCR через tesseract.js | Phase 2 |
| Извлечение таблиц из PDF с структурой | Phase 2 (если нужно по фидбэку) |
| DOCX-шаблоны (Jinja-style placeholders) | Phase 2 (для сценариев типа «договор по параметрам») |
| Сравнение двух DOCX (diff) | Phase 2 (сценарий «сравнение редакций договора») |

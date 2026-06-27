# Источнико-независимый интерфейс к исходнику документа

**Зачем:** инженеру нужно открыть процитированный ГОСТ/СП и глазами проверить ответ модели. Где/как мы
храним документы — ПОКА НЕ РЕШЕНО (внешний портал сегодня; рендер нашего файла с бэкенда завтра). Поэтому
фронт зависит от стабильного контракта `Source`, а НЕ от способа хранения.

## Контракт (один на всё)

Цитата `{gost_id, clause_path, quote}` → **резолвится** в `Source` (`schema.py`):

```
Source {
  doc_id: "ГОСТ 34028-2016"      // канонический id == gost_id
  title:  "Прокат арматурный…"
  clause_path: "5.2.1"           // → «п. 5.2.1»
  quote:  "…"                    // что подсветить
  view: {                        // ← ЕДИНСТВЕННОЕ, от чего зависит фронт
    kind: "external" | "backend" | "unavailable"
    url:  "https://…/g.pdf"  ИЛИ  "/api/sources/<doc_id>"
    mime: "application/pdf"
    page: 12 | null              // диплинк-страница (best-effort)
  }
  available: bool                // false → «источник недоступен»
}
```

**Развязка хранения:** решение «где лежат документы» = это запись в `data/sources.yaml` (`gost_id → view`).
Сменили хранение (внешний портал → наш файл) — правим ТОЛЬКО `kind/url` там; **фронт не меняется**.

## Поток

```
gost-rag.sources.resolve_citations(answer.citations) -> [Source]
   → engine (прокидывает Source в ответе/SSE)
   → web  <SourceViewer source={src} />     // рендерит по view, не зная про хранение
```

Бэкенд готов: `data/sources.yaml` (24 документа), `sources.py` (`resolve_source` / `resolve_citations`),
`schema.Source`/`SourceView`, тесты (`tests/test_sources.py`). Демо: `scripts/ask.py` печатает ссылку-исходник
под каждой цитатой.

## Фронт-компонент (спецификация)

`SourceViewer(props: { source: Source })` — рендер ТОЛЬКО по `source.view`:

| view.kind | поведение |
|---|---|
| `external` | кнопка/ссылка «Открыть источник» → новая вкладка `url`; опц. `<iframe src=url>` для inline PDF; пометка «внешний портал» |
| `backend`  | встроенный рендер нашего файла: PDF.js по `url` (`/api/sources/<doc_id>`), переход на `page`, подсветка `quote` |
| `unavailable` | дизейбл-состояние «источник недоступен» (но цитата `doc_id`/`clause_path` всё равно показана) |

Эскиз (SolidJS, `web/packages/app/.../SourceViewer.tsx`):

```tsx
export function SourceViewer(props: { source: Source }) {
  const v = props.source.view
  if (!props.source.available || v.kind === "unavailable")
    return <span class="src-na">источник недоступен · {props.source.doc_id} п. {props.source.clause_path}</span>
  const label = `${props.source.doc_id}${props.source.clause_path ? `, п. ${props.source.clause_path}` : ""}`
  if (v.kind === "external")
    return <a class="src-ext" href={v.url} target="_blank" rel="noreferrer" title="внешний портал">
             📄 Открыть источник — {label}
           </a>
  // kind === "backend": наш файл-стрим → встроенный просмотрщик с диплинком и подсветкой
  return <PdfViewer url={v.url} page={v.page ?? undefined} highlight={props.source.quote} caption={label} />
}
```

`PdfViewer` — обёртка над PDF.js: грузит `url`, скроллит к `page`, ищет/подсвечивает `highlight` (quote).
Для `external` PDF тоже можно отдать в `PdfViewer` через `<iframe>`/проксирование — но это уже выбор UX.

## Эволюция хранения (без правок фронта)

1. **Сейчас:** `kind: external` + URL портала (из разметки). Инженер открывает первоисточник.
2. **Когда захостим файлы:** добавить бэкенд-эндпоинт `GET /api/sources/<doc_id>` (стрим PDF/HTML);
   в `sources.yaml` поменять запись на `kind: backend, url: /api/sources/<doc_id>`. Фронт-компонент тот же.
3. **Диплинк к пункту:** при ингесте можно записать `clause_path → page` (для PDF) в `sources.yaml`/sidecar →
   `view.page` заполняется, `backend` рендер прыгает на страницу, `quote` подсвечивается.
4. **Иные типы документов** (не ГОСТ): тот же контракт — добавляем запись в `sources.yaml`, `mime` задаёт рендер.

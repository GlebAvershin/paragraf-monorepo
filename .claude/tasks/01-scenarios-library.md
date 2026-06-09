# ТЗ-01: Библиотека сценариев-мастеров

**Размер:** L (3-4 недели работы одного разработчика)
**Приоритет:** 🔴 Главная фича продукта — без неё проект "очередной чат с ИИ"

---

## 1. Контекст и зачем

Целевая аудитория «Параграфа» (юристы и бухгалтеры в РФ/СНГ, 40+ лет, документоёмкая работа) **не привыкла к "пустому чату с ИИ"**. Без структурированного фронта на запуск приложения, юзер не понимает, что туда писать. Это **главная проблема всех ChatGPT-подобных продуктов** для непрограммистов.

Решение — **сценарии-мастера**: пошаговые формы под конкретную задачу профессии. Юзер не пишет промпт — он отвечает на 3-5 вопросов формы, агент сам формирует сильный промпт, прогоняет через выбранную модель и возвращает готовый результат (часто — в виде .docx).

Это **главная дифференциация** против КонсультантПлюс/Гарант (у них нет ИИ-генерации) и против голого ChatGPT (там нет структуры под профессию).

## 2. Объём (что в скоупе MVP)

**10-14 сценариев суммарно**, по 5-7 на вертикаль:

### Юристы (5-7 сценариев):
1. **Проверка договора на риски** — юзер загружает .docx/.pdf договора, агент возвращает список рисков с указанием пунктов, на что обратить внимание, что доработать. Результат — .docx-отчёт.
2. **Составить договор по параметрам** — мастер: тип договора (услуг/поставки/аренды/ND A), стороны, предмет, цена, срок, особые условия. Результат — готовый шаблон договора в .docx.
3. **Подготовить претензию** — мастер: к кому, на основе чего, что требуем, срок исполнения. Опционально приложить договор. Результат — претензия в .docx.
4. **Сравнить две редакции** — юзер загружает 2 версии документа, агент возвращает структурированный diff с пояснением каждого изменения. Результат — markdown-таблица + .docx.
5. **Краткое содержание документа** — загрузка длинного документа (договор, постановление, решение суда), агент возвращает структурированное саммари. Результат — текст в чате.
6. *(опционально)* **Подготовить исковое заявление** — мастер: суть спора, истец, ответчик, требования, доказательства. Результат — иск в .docx.
7. *(опционально)* **Проверка контрагента по реквизитам** — мастер: ИНН/ОГРН. Агент возвращает структуру компании, риски, рекомендации.

### Бухгалтеры (5-7 сценариев):
1. **Проверка первичного документа** — загрузка счёта/накладной/УПД. Агент проверяет реквизиты, корректность НДС, типичные ошибки. Результат — отчёт.
2. **Ответ на требование ФНС** — мастер: тип требования (камеральная, выездная, требование документов), номер требования, дата получения, суть. Результат — ответ в .docx.
3. **Объяснение положения НК на пальцах** — мастер: статья НК, контекст применения. Результат — простое объяснение в чате.
4. **Сверка реквизитов контрагента** — мастер: ИНН/ОГРН. Результат — выписка ЕГРЮЛ-style + риски.
5. **Пояснительная записка к отчёту** — мастер: тип отчёта (РСБУ, МСФО, налоговая), период, существенные изменения. Результат — пояснительная в .docx.
6. *(опционально)* **Расчёт налогов на УСН/ОСН** — мастер: режим, выручка, расходы, период. Результат — пошаговый расчёт.
7. *(опционально)* **Шаблон акта сверки** — мастер: контрагент, период, итоговые суммы. Результат — акт в .docx.

**Не в скоупе MVP:** интеграция с КонсультантПлюс/Гарант (платная), интеграция с 1С (отдельный проект), маркетплейс пользовательских сценариев (Phase 4).

## 3. Модель данных

Каждый сценарий — это **JSON-конфиг + опциональный SolidJS-компонент** для нестандартной формы:

```ts
// desktop/packages/app/src/ourapp/scenarios/types.ts
export interface Scenario {
  /** Уникальный идентификатор. snake_case. */
  id: string

  /** Вертикали, в которых сценарий показывается. */
  verticals: Array<"lawyer" | "accountant">

  /** Краткое название в сайдбаре. */
  title: string

  /** Короткое описание (tooltip / карточка). */
  lede: string

  /** Иконка (см. `desktop/packages/ui/src/components/icon.tsx` или эмодзи). */
  icon?: string

  /** Шаги мастера. */
  steps: ScenarioStep[]

  /** Шаблон системного промпта. Подставляются ответы шагов как {{step_id}}. */
  promptTemplate: string

  /** Рекомендуемая модель (если null — юзер сам выбирает). */
  preferredModel?: "claude-sonnet" | "claude-opus" | "gigachat-pro" | "gigachat-max"

  /** Что делать с результатом. */
  resultAction:
    | { type: "show_in_chat" }
    | { type: "generate_docx", filenameTemplate: string }
    | { type: "generate_table" }
}

export type ScenarioStep =
  | TextStep
  | LongTextStep
  | SelectStep
  | FileUploadStep
  | BooleanStep
  | DateStep

interface BaseStep {
  id: string             // snake_case, попадает в шаблон как {{step_id}}
  label: string          // основной вопрос
  hint?: string          // подсказка под полем
  required?: boolean
  validate?: (value: unknown) => string | null
}

interface TextStep extends BaseStep {
  type: "text"
  placeholder?: string
  maxLength?: number
}

interface LongTextStep extends BaseStep {
  type: "long_text"
  placeholder?: string
  rows?: number
}

interface SelectStep extends BaseStep {
  type: "select"
  options: Array<{ value: string; label: string; description?: string }>
}

interface FileUploadStep extends BaseStep {
  type: "file_upload"
  accept: string[] // [".pdf", ".docx"]
  multiple?: boolean
}

interface BooleanStep extends BaseStep {
  type: "boolean"
}

interface DateStep extends BaseStep {
  type: "date"
}
```

## 4. UI-компоненты

Создать новые в `desktop/packages/app/src/ourapp/scenarios/`:

### 4.1 `scenario-launcher.tsx`
Кликабельный пункт в сайдбаре (уже частично есть в `welcome-sidebar.tsx`). При клике открывает `ScenarioWizard` поверх чата.

### 4.2 `scenario-wizard.tsx`
Полноэкранный мастер (overlay, не модалка — чтобы было место для длинных форм). Компоненты:

- **Header:** название сценария + крестик закрытия.
- **Progress dots:** "Шаг 2 из 5" + точки.
- **Step content:** рендерит соответствующий компонент шага.
- **Footer:** "Назад" / "Далее". На последнем шаге — "Запустить".

Стиль — DESIGN.md (кремовый фон, серифные заголовки, emerald-акцент).

### 4.3 `scenario-step-*.tsx` (по одному на тип)
- `step-text.tsx`
- `step-long-text.tsx`
- `step-select.tsx` (radio-карточки, не dropdown — лучше UX для непрограммистов)
- `step-file-upload.tsx` (использует существующий `attachments.ts`)
- `step-boolean.tsx`
- `step-date.tsx`

### 4.4 `scenario-result.tsx`
Экран показа результата ПОСЛЕ запуска. Структура:
- Заголовок "Результат" + название сценария
- Контент (markdown-рендер ответа модели через существующий `message-part.tsx` логика рендеринга)
- Действия: "Скачать .docx" / "Скопировать" / "Открыть в чате для уточнения"
- Если `resultAction.type === "generate_docx"` — автоматически вызывает `ourappDocExport` сразу.

## 5. Шаблон промпта

Шаблон в `promptTemplate` использует Mustache-style плейсхолдеры:

```
Ты — опытный юрист с 15+ лет практики в коммерческом праве РФ.

Задача: подготовить претензию.

Контекст:
- Получатель: {{recipient}}
- Основание: {{basis}}
- Требование: {{demand}}
- Срок исполнения: {{deadline_days}} дней
{{#has_attached_contract}}
- Приложен договор: см. attached_document
{{/has_attached_contract}}

Сформируй текст претензии в официально-деловом стиле, со ссылками на статьи ГК РФ.
Структура: преамбула (стороны, реквизиты), описание нарушения, юридическая
квалификация, требования, срок, последствия. Используй заголовки и нумерацию пунктов.
```

Простой движок подстановки достаточно: `{{key}}` заменяется на значение, `{{#bool}}...{{/bool}}` — условный блок. Можно взять [mustache.js](https://www.npmjs.com/package/mustache) (~5kb).

## 6. Запуск сценария — что делает код

```ts
async function runScenario(scenario: Scenario, answers: Record<string, unknown>, sessionID: string) {
  // 1. Сформировать промпт из шаблона + ответы
  const prompt = renderTemplate(scenario.promptTemplate, answers)

  // 2. Собрать прикреплённые файлы (если есть file_upload шаги) — конвертируем
  //    их в attachments как делает composer (см. attachments.ts/add())
  const attachments = await buildAttachmentsFromAnswers(scenario, answers)

  // 3. Создать draft и отправить через тот же sendFollowupDraft что и обычный чат
  //    (это позволяет реюзать всю инфраструктуру: streaming, guard кредитов, billing)
  const draft = makeFollowupDraft({
    sessionID,
    prompt: [...attachments, { type: "text", content: prompt }],
    model: scenario.preferredModel ?? userSelectedModel(),
    metadata: { scenarioId: scenario.id }, // для аналитики
  })

  await sendFollowupDraft({ ..., draft })

  // 4. После завершения стриминга — если resultAction.type === "generate_docx",
  //    автоматически дёрнуть window.ourappDocExport(lastAssistantMessage, { showPreview: true })
}
```

## 7. Файлы для создания / редактирования

**Создать:**
- `desktop/packages/app/src/ourapp/scenarios/types.ts`
- `desktop/packages/app/src/ourapp/scenarios/index.ts` — экспорт всех сценариев
- `desktop/packages/app/src/ourapp/scenarios/scenario-wizard.tsx`
- `desktop/packages/app/src/ourapp/scenarios/scenario-wizard.css`
- `desktop/packages/app/src/ourapp/scenarios/step-*.tsx` (6 файлов)
- `desktop/packages/app/src/ourapp/scenarios/scenario-result.tsx`
- `desktop/packages/app/src/ourapp/scenarios/render-template.ts` (Mustache-like)
- `desktop/packages/app/src/ourapp/scenarios/run-scenario.ts` (главная логика запуска)
- `desktop/packages/app/src/ourapp/scenarios/library/` — папка с json/ts конфигами сценариев:
  - `lawyer-contract-review.ts`
  - `lawyer-contract-draft.ts`
  - `lawyer-claim.ts`
  - `lawyer-compare-versions.ts`
  - `lawyer-summary.ts`
  - `accountant-primary-doc-check.ts`
  - `accountant-fns-reply.ts`
  - `accountant-tax-code-explain.ts`
  - `accountant-counterparty-check.ts`
  - `accountant-explanatory-note.ts`

**Изменить:**
- `desktop/packages/app/src/ourapp/welcome-sidebar.tsx` — `onPickScenario` теперь открывает `ScenarioWizard`, не просто переход.
- `desktop/packages/app/src/ourapp/scenario-library.ts` (если файл существует — заменить контент; иначе создать) — старая placeholder-библиотека сценариев заменяется на реальную.
- `desktop/packages/app/src/pages/session.tsx` — пробросить открытие wizard'а.

## 8. Принимочные критерии

- [ ] В сайдбаре каждой вертикали показываются её 5-7 сценариев (отдельно юрист/бухгалтер).
- [ ] Клик по сценарию открывает мастер (overlay поверх чата) в кремовом стиле DESIGN.md.
- [ ] Все 6 типов шагов (text/long_text/select/file_upload/boolean/date) корректно рендерятся и валидируются.
- [ ] Прогресс-дотс показывает текущий шаг.
- [ ] "Назад" сохраняет ответы при возврате.
- [ ] При запуске промпт подставляется в шаблон, файлы прикрепляются, отправляется через существующий sendFollowupDraft → guard кредитов срабатывает корректно.
- [ ] При `resultAction.type === "generate_docx"` после ответа модели автоматически открывается preview-панель + скачивание.
- [ ] Хотя бы 5 сценариев для юристов и 5 для бухгалтеров проходят happy-path с реальной моделью (Sonnet или GigaChat Pro).
- [ ] Аналитика: каждый запуск сценария логируется в `usage_events.metadata` через billing (поле `scenario_id`).

## 9. Реюз существующей инфраструктуры

- Загрузка файлов в шаге `file_upload` — через `attachments.ts` (уже есть парсинг PDF/DOCX/XLSX).
- Отправка промпта — через `sendFollowupDraft` (получаем guard кредитов, streaming, билинг).
- Рендер ответа — через `message-part.tsx` (получаем markdown, syntax highlight, кнопку "Скачать .docx").
- Стилистика — через CSS-переменные DESIGN.md (`--ourapp-*`).

## 10. Подводные камни

- **Промпт-инжиниринг важнее интерфейса.** Нужно итерировать промпт каждого сценария на реальных примерах — что выдаёт Sonnet vs GigaChat Pro vs Opus, какие ошибки повторяются. Заложить 30% времени на это.
- **PDF юридических документов** часто скан-копии — Claude Vision справится, но GigaChat нет. Может потребоваться warning юзеру "выберите Sonnet/Opus для PDF-сканов".
- **Длинные договоры** (100+ страниц) могут превысить контекст модели. Нужен fallback: первые N страниц + предупреждение.
- **Совпадение мастер-шага и параметра промпта.** ID шага должен быть в snake_case и совпадать с плейсхолдером промпта (легко ошибиться). Сделать unit-тест: `validateScenario(scenario)` проверяет что все `{{xxx}}` плейсхолдеры покрыты шагами.

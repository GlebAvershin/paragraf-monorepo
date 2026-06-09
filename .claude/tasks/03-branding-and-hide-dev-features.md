# ТЗ-03: Брендинг + скрытие dev-фич opencode

**Размер:** M (1-2 недели)
**Приоритет:** 🟠 Без неё нельзя релизить публичную сборку

---

## 1. Контекст

Наш форк `desktop/` базируется на `opencode` (от Anthropic / anomalyco) — это IDE-агент для разработчиков. У него много фич, **которые не нужны и пугают** нашу аудиторию (юристы/бухгалтеры, 40+, без IT-фона):

- Терминальная панель (нижняя)
- File tree сайдбар проектов
- Code-diff viewer
- LSP (Language Server Protocol) интеграция
- Permission prompts с упоминанием bash/git
- Команды `/run`, `/diff`, `/edit-file`
- Иконки разработческого тула
- Splash-экран opencode
- Брендинг "opencode" в About / меню / окне

Нам нужно превратить opencode в **«Параграф»** — продукт для непрограммистов. Визуально и функционально.

## 2. Объём

**В скоупе:**
- Замена иконки приложения (taskbar, окно, splash, exe-метадата)
- Замена splash-экрана при загрузке
- Замена названия "opencode" на "Параграф" везде в UI и метаданных
- Скрытие dev-панелей: терминал, file tree, code diff, LSP-инфо
- Удаление dev-команд из slash-menu (`/run`, `/diff`, etc.)
- Применение DESIGN.md к chat-area и всем оставшимся экранам (кремовый фон, шрифты, цвета)
- About / Help содержимое — наш текст
- Подключение шрифтов IBM Plex Serif, Onest, JetBrains Mono (offline-сборка)
- Локализация: русский по умолчанию, переключение в settings

**Не в скоупе:**
- Полная локализация всех ошибок (только основные)
- Custom theme builder для пользователей
- Tutorial / coachmarks (отдельная задача)

## 3. Иконки и splash

### 3.1 Иконки

Создать набор:
- `512x512` PNG — мастер-файл
- `256x256`, `128x128`, `64x64`, `32x32`, `16x16` — производные
- `.ico` (Windows) — содержит все размеры
- `.icns` (macOS) — содержит все размеры
- `.png` для Linux

**Дизайн иконки:**
- Базовый знак — стилизованная **§** (символ параграфа, ключевой узнаваемый элемент в названии)
- Цвета: emerald `#0B5345` на кремовом `#FBF9F4` фоне
- Округлая рамка под macOS / Windows 11 squircle

Файлы кладутся в:
- `desktop/packages/desktop/icons/512x512.png` (мастер)
- `desktop/packages/desktop/icons/icon.ico`
- `desktop/packages/desktop/icons/icon.icns`
- `desktop/packages/desktop/build/` (для electron-builder)

В `desktop/package.json` или `electron-builder.json`:
```json
{
  "build": {
    "appId": "ai.paragraf.desktop",
    "productName": "Параграф",
    "win": { "icon": "icons/icon.ico" },
    "mac": { "icon": "icons/icon.icns" },
    "linux": { "icon": "icons/" }
  }
}
```

### 3.2 Splash-экран (loading)

Файл `desktop/packages/desktop/src/renderer/loading.tsx` (или аналог в форке):

Заменить opencode splash на:
- Кремовый фон (`#FBF9F4`)
- По центру — большая серифная "Параграф" (IBM Plex Serif 32px)
- Под названием — emerald spinner или прогресс-бар
- Без emoji, без подсказок про разработку

## 4. Скрытие dev-фич

### 4.1 Терминал-панель

Файл: `desktop/packages/app/src/pages/session.tsx` (искать `TerminalPanel`).

```tsx
// Было:
<TerminalPanel />

// Стало:
// {import.meta.env.DEV && <TerminalPanel />}
// либо просто удалить
```

Дополнительно убрать импорт `useTerminal`, `TerminalPanel`, и `node-pty` зависимости из package.json (опционально — для уменьшения bundle size).

### 4.2 File tree (sidebar проектов)

В opencode сайдбар имеет файловое дерево проекта. Найти его (поиск по "FileTree", "ProjectTree", "file-explorer") и скрыть рендер.

Наш WelcomeSidebar (`desktop/packages/app/src/ourapp/welcome-sidebar.tsx`) уже заменяет дефолтный сайдбар, но нужно убедиться что в layout (`desktop/packages/app/src/pages/layout.tsx`) не рендерится оригинальный.

### 4.3 Code-diff viewer

Найти компонент `DiffChanges`, `CodeDiff`, `SessionDiff`. В chat-area их рендер происходит для сообщений с tool-вызовами `edit`, `write`. Условный рендер:

```tsx
const HIDDEN_TOOLS = new Set(["edit", "write", "bash", "read"])
{!HIDDEN_TOOLS.has(toolPart.name) && <ToolResultRender ... />}
```

### 4.4 LSP-индикаторы

Поиск по "LSP", "language-server" — скрыть.

### 4.5 Permission prompts с упоминанием bash/git

В `desktop/packages/app/src/context/permission.tsx` (или аналог) — если запрос разрешения на bash/git/edit, **не показывать диалог**, а сразу отказать. Эти инструменты для юриста бесполезны и могут испугать.

### 4.6 Slash-команды `/run`, `/diff`, `/edit-file`

Найти список команд (поиск `command-registry` или `useCommands`). Отфильтровать dev-команды:

```ts
const ALLOWED_COMMANDS_FOR_USERS = new Set(["help", "new", "clear", "settings"])

const userCommands = allCommands.filter(c => ALLOWED_COMMANDS_FOR_USERS.has(c.name))
```

## 5. Замена брендинга

### 5.1 Поиск всех упоминаний "opencode"

```bash
grep -r "opencode" desktop/packages/app/src --include="*.ts" --include="*.tsx" -l
grep -r "OpenCode" desktop/packages/app/src --include="*.ts" --include="*.tsx" -l
```

Заменить:
- `"opencode"` → `"Параграф"` в UI-строках (label, title, placeholder, error msg)
- `"opencode"` → `"paragraf"` в data-атрибутах, конфигах, идентификаторах (где-возможно — но не ломать API-контракты с upstream)
- `"OpenCode"` (capitalized) → `"Параграф"` в названиях окон

**ОСТАВИТЬ как есть:**
- Импорты из `@opencode-ai/*` пакетов (это upstream)
- Имена опенсорс-пакетов в node_modules
- Внутренние идентификаторы агентов и tool'ов (это API-контракт)

### 5.2 Window title

Файл: `desktop/packages/desktop/src/main.ts` (или аналог).

```ts
const window = new BrowserWindow({
  title: "Параграф",
  ...
})
```

### 5.3 About / Help экраны

В Settings → "О приложении" (уже частично есть) сделать кнопку "О Параграфе" → модалка:
- Логотип "Параграф" большой
- Версия (динамически из package.json)
- "ИИ-агент для юристов и бухгалтеров"
- Ссылка на сайт (когда будет)
- Ссылка на оферту, политику конфиденциальности (152-ФЗ обязательно)
- Email для поддержки
- Копирайт

Help — отдельная страница `/help` со списком FAQ:
- Как загрузить документ?
- Как выбрать модель?
- Что такое кредиты?
- Безопасны ли мои данные?
- Как отменить подписку?

## 6. DESIGN.md в chat-area

Сейчас sidebar и onboarding в стиле DESIGN.md (кремовый, серифный), но **chat-area** (центральная часть с сообщениями) — нет. Применить:

### 6.1 Шрифты

В `desktop/packages/app/src/index.css` или `desktop/packages/ui/src/styles.css`:

```css
@import "@fontsource/ibm-plex-serif/400.css";
@import "@fontsource/ibm-plex-serif/500.css";
@import "@fontsource/ibm-plex-serif/400-italic.css";
@import "@fontsource/onest/300.css";
@import "@fontsource/onest/400.css";
@import "@fontsource/onest/500.css";
@import "@fontsource/onest/600.css";
@import "@fontsource/onest/700.css";
@import "@fontsource/jetbrains-mono/400.css";

:root {
  --font-family-serif: "IBM Plex Serif", Georgia, serif;
  --font-family-sans: "Onest", -apple-system, system-ui, sans-serif;
  --font-family-mono: "JetBrains Mono", Consolas, monospace;
}
```

Установить пакеты:
```bash
cd desktop && bun add @fontsource/ibm-plex-serif @fontsource/onest @fontsource/jetbrains-mono
```

### 6.2 Цвета

```css
:root {
  /* Backgrounds */
  --color-bg-base: #FBF9F4;          /* кремовый фон */
  --color-bg-surface: #FFFFFF;       /* карточки, поля */
  --color-bg-surface-alt: #F6F2EB;   /* шапки таблиц, code blocks */

  /* Text */
  --color-text-primary: #2A2723;
  --color-text-secondary: #5C5852;
  --color-text-tertiary: #8B8680;

  /* Borders */
  --color-hairline: #E5DFD0;
  --color-hairline-strong: #D8D2C5;

  /* Accent */
  --color-accent: #0B5345;          /* emerald — наш ключевой акцент */
  --color-accent-hover: #094035;

  /* States */
  --color-success: #2D7A4F;
  --color-warning: #8B6E2E;
  --color-error: #991B1B;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg-base: #15120F;
    --color-bg-surface: #1F1B17;
    /* ... */
  }
}
```

### 6.3 Chat message-area

В `desktop/packages/ui/src/components/message-part.tsx` (или связанных CSS):
- Фон chat-area → `var(--color-bg-base)` (кремовый)
- Bubble юзер-сообщений → лёгкий фон `var(--color-bg-surface-alt)`, серифный заголовок
- Bubble ассистент-сообщений — без фона, прямо на background, шрифт Onest

Это надо аккуратно — не сломать существующую разметку. Делать постепенно с проверкой каждого изменения.

## 7. Локализация

### 7.1 Русский по умолчанию

Файл: `desktop/packages/desktop/src/renderer/i18n/ru.ts` — заполнить (он скорее всего уже частично создан, но не полный).

В файле инициализации i18n (`useLanguage`):

```ts
const defaultLanguage = "ru" // было "en"
```

### 7.2 Переключатель

В Settings → "Язык" (новая секция):
- Русский (по умолчанию)
- English (для разработки/QA)

## 8. Файлы для создания / редактирования

**Создать:**
- `desktop/packages/desktop/icons/512x512.png` + .ico + .icns
- `desktop/packages/app/src/pages/help.tsx` (страница FAQ)
- `desktop/packages/app/src/ourapp/about-modal.tsx` (модалка "О Параграфе")
- Если нет — `desktop/packages/desktop/src/renderer/i18n/ru.ts` (полная локализация)

**Изменить:**
- `desktop/package.json` — `productName`, `appId`, icons
- `desktop/electron-builder.json` (если есть) — то же
- `desktop/packages/desktop/src/main.ts` — window title, app name
- `desktop/packages/desktop/src/renderer/loading.tsx` — splash
- `desktop/packages/app/src/pages/session.tsx` — убрать TerminalPanel
- `desktop/packages/app/src/pages/layout.tsx` — file tree, dev sidebars
- `desktop/packages/app/src/context/permission.tsx` — auto-deny bash/git/edit
- `desktop/packages/app/src/index.css` (или ui/src/styles.css) — шрифты, переменные цветов
- `desktop/packages/ui/src/components/message-part.tsx` (+ CSS) — chat area styling
- Все файлы с "opencode" в UI-строках → "Параграф" (см. grep выше)

## 9. Принимочные критерии

- [ ] При запуске приложения иконка в taskbar — § на кремовом фоне, не opencode-логотип.
- [ ] Splash-экран — "Параграф" серифом, кремовый фон, emerald spinner.
- [ ] В title window'а — "Параграф", не "opencode".
- [ ] В About-модалке — название "Параграф", версия, копирайт.
- [ ] Нет терминал-панели снизу.
- [ ] Нет file-tree сайдбара.
- [ ] Нет code-diff просмотрщика в сообщениях.
- [ ] Slash-команды показывают только разрешённые (help, new, clear, settings).
- [ ] При попытке использовать tool `bash`/`git`/`edit-file` — отказ без диалога.
- [ ] Chat-area в кремовом фоне, body-текст в Onest, заголовки в IBM Plex Serif.
- [ ] Шрифты не подгружаются с CDN — встроены в bundle (offline-сборка работает).
- [ ] При первом запуске интерфейс на русском, в Settings можно переключить на English.
- [ ] grep по "opencode" в нашем коде (без node_modules, без upstream-пакетов) — пусто или близко к этому.

## 10. Подводные камни

- **Не лезть в @opencode-ai/* пакеты** — это upstream. Все правки в нашем форке `desktop/packages/app` и `desktop/packages/desktop`. Иначе при подтягивании upstream-обновлений всё сломается.
- **DOM-структура chat-area сложная.** message-part.tsx — большой файл с десятками компонентов. Менять CSS аккуратно — могут поехать ширины, скроллы, sticky-headers.
- **Шрифты IBM Plex Serif для кириллицы** — официальный пакет содержит кириллицу, но `@fontsource` иногда отделяет subsets. Использовать `@fontsource/ibm-plex-serif/cyrillic.css` если нужно.
- **Электрон-сборка иконок.** На Windows иконка в .exe ставится через `rcedit` (electron-builder вызывает её), которая иногда падает на RU-сетях из-за скачивания. Делать сборку на CI (GitHub Actions) или подготовить кеш заранее.
- **Локализация — это много работы.** Не пытаться сразу 100% покрытие. Фокус: онбординг + сайдбар + composer + tools UI + ошибки. Settings/About — потом.
- **Permission prompts** — opencode при запросе разрешения на shell-tool показывает диалог. Перехватывать ДО показа, иначе юзер увидит проскакивающий технический popup.

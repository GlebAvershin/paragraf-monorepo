# Дизайн-система OurApp (рабочее название «Параграф»)

> Источник правды для всех визуальных решений. Любая UI-работа в `desktop/` — сверяется с этим документом.
> Превью живёт в `design/preview.html` — открой в браузере, чтобы увидеть систему в работе.

## 1. Контекст продукта

- **Что это:** десктоп ИИ-агент для юристов и бухгалтеров в РФ/СНГ. Форк [`anomalyco/opencode`](https://github.com/anomalyco/opencode) (Electron + SolidJS + Tailwind + Kobalte).
- **Кто пользователь:** профессионал 30–60 лет, документоёмкая работа, не айтишник. Конкуренты в восприятии — КонсультантПлюс, Гарант, голый ChatGPT.
- **Project type:** desktop AI agent (чат + работа с документами + библиотека сценариев + биллинг). Не IDE.
- **Memorable thing:** «Серьёзный профессиональный инструмент с тёплой подачей и премиальной типографикой, говорящий на современном русском визуальном языке».

## 2. Эстетическое направление

**Restrained Editorial.** Помесь серьёзного финансового издания (лучшие развороты «Ведомостей» / «Коммерсанта Weekend») и современного продуктивного приложения. Типографика делает основную работу. Декорация минимальная, но не отсутствует.

- **Уровень декорации:** intentional (тонкая бумажная зернистость на фоне, hairline-разделители, нумерация секций как в нормативке).
- **Mood:** серьёзный, тёплый, уважительный к документу. Не IDE, не «весёлый SaaS», не корпоративный Helvetica-template.
- **Чего избегаем:** градиенты (особенно фиолетовые), иконки-в-кружочках, центровка всего, decorative blobs, AI slop в любых проявлениях.

## 3. Типографика

| Роль | Шрифт | Загрузка | Веса |
|---|---|---|---|
| Display / акцент (название, заголовки сценариев, blockquote) | **IBM Plex Serif** | Google Fonts | 400, 500, italic 400 |
| Body / UI (всё остальное) | **Onest** | Google Fonts | 300, 400, 500, 600, 700 |
| Tabular (таблицы, цифры, биллинг) | **Onest** + `font-variant-numeric: tabular-nums` | — | 500 |
| Mono (API-токены, code-блоки) | **JetBrains Mono** | Google Fonts | 400, 500 |

**Шкала кеглей (px):** 12 · 14 · 16 (base) · 18 · 22 · 28 · 36 · 48 · 56.
**Line-height:** body 1.5–1.6, headings 1.05–1.2.
**Letter-spacing:** display `-0.02em`, body 0, uppercase-метки `0.08em–0.18em`.

**Почему так:**
- IBM Plex Serif несёт «премиум-серьёзный» сигнал и имеет сильную кириллицу. Это рычаг дифференциации от КонсультантПлюс/Гарант (которые all-sans).
- Onest — современный гротеск с очень хорошей кириллицей, не overused как Inter/Roboto, бесплатный.
- JetBrains Mono — стандарт для технических надписей, кириллица отличная.

**Запрещено как primary:** Inter, Roboto, Arial, Helvetica, Open Sans, Montserrat, Poppins, Space Grotesk, system-ui. Это AI-slop-сигнал.

## 4. Цвет

### Light (дефолт)

| Роль | HEX | Назначение |
|---|---|---|
| Bg page | `#FBF9F4` | Тёплый off-white. Главный «премиум-рычаг». Не #FFF |
| Bg surface | `#FFFFFF` | Карточки, всплывающие над фоном без теней |
| Bg surface-alt | `#F6F2EB` | Сайдбары, top-bar |
| Bg inset | `#F1EDE3` | Code-блоки, утопленные элементы |
| Hairline | `#E8E3DB` | 1px-разделители |
| Hairline strong | `#D8D2C5` | Бордеры инпутов и карточек |
| Text primary | `#1A1614` | Тёплый near-black, не #000 |
| Text secondary | `#5C5852` | Warm gray, основной для UI-меток |
| Text tertiary | `#8B8680` | Метаданные, плейсхолдеры, captions |
| **Accent** (primary) | `#0B5345` | Deep emerald. Главный цвет действия |
| Accent hover | `#0D6B58` | Шаг светлее для hover-состояний |
| Accent muted | `#0B53450F` (6% alpha) | Фоны активных пунктов, success-алёрты |
| Accent ink | `#053026` | Текст поверх accent-muted фонов |
| Highlight | `#C8A85C` | Приглушённое золото. Премиум-бэйджи, второстепенные акценты |
| Highlight muted | `#C8A85C1A` | |
| Success | `#0B5345` | Reuse эмеральда — палитра уважает себя |
| Warning | `#B45309` | Warm amber, не неон |
| Warning muted | `#B453091A` | |
| Error | `#991B1B` | Oxblood, не Bootstrap red |
| Error muted | `#991B1B1A` | |
| Info | `#475569` | Slate blue |

### Dark (опциональный режим)

Не инверсия — переработанные surfaces.

| Роль | HEX |
|---|---|
| Bg page | `#15120F` (warm graphite) |
| Bg surface | `#1F1B17` |
| Bg surface-alt | `#25201B` |
| Bg inset | `#2B251F` |
| Hairline | `#2E2924` |
| Text primary | `#EDE8DF` |
| Text secondary | `#B5AFA4` |
| Text tertiary | `#847E72` |
| Accent | `#1A8A6B` (ярче эмеральд для контраста) |
| Accent hover | `#1FA17F` |
| Highlight | `#D4B872` |
| Warning | `#D97706` |
| Error | `#DC2626` |
| Info | `#94A3B8` |

**Принципы:** сатурация всех цветов в dark ниже на 10–15%, accent сдвинут к более яркому для WCAG-контраста на тёмном фоне.

### Цветовые риски (осознанные)

1. **Кремовый фон вместо чисто белого.** Расходимся со всеми RU-SaaS. Цена: часть пользователей 50+ может прочесть как «пожелтевший экран» — следить за фидбэком пилота, держать `pure-white` как настройку наготове.
2. **Deep emerald вместо safe navy.** Категориальный дефолт legal-tech — тёмно-синий. Эмерольд = «закон + деньги + природа», уникален в категории. Цена: проверка WCAG обязательна, не использовать только цвет как сигнал.

## 5. Spacing

- **Base unit:** 4px.
- **Density:** comfortable (не compact как КонсультантПлюс, не spacious как Apple Notes).
- **Шкала:** 2 · 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 px.
- **Padding контейнеров:** карточки 22–28px, основные экраны 32–48px по горизонтали.
- **Сайдбар (chat):** 264px ширина.
- **Max content width** в чате/тексте: 720px (комфортная длина строки для чтения юридических текстов).

## 6. Layout

**Hybrid:** grid-disciplined для оболочки приложения, creative-editorial для библиотек.

- **App shell (chat):** трёх-панельный — сайдбар сценариев/история (264px) → центр (чат / документ) → опциональный document-preview справа (выезжает по требованию).
- **Scenario library:** editorial-композиция — главный сценарий крупно (span 2×2), остальные карточки разного размера. Не три-колоночная сеть с иконками-в-кружочках.
- **Billing / settings:** двух-колоночная сетка (главная карточка слева 1.4fr, мета-карточка справа 1fr).

## 7. Border-radius

Иерархичный — определяет «тон» элемента:

| Уровень | Значение | Применение |
|---|---|---|
| sm | 6px | Input, badge, sidebar-item |
| md | 10px | Button, card, modal trigger |
| lg | 14px | Card, mockup-окно, modal, chat-bubble |
| full | 9999px | Avatar, pill, progress-bar fill |

Запрещено: 4px (слишком dev), 20px+ (слишком детский / SaaS-template).

## 8. Motion

**Intentional, не expressive.** Аудитория 40+, не 25.

| Тип | Длительность | Easing |
|---|---|---|
| Hover (color tint) | 50ms | linear |
| Entrance (fade + 4px translate) | 150ms | ease-out |
| Modal (scale 0.96→1 + fade) | 200ms | cubic-bezier(0.32, 0.72, 0.36, 1) |
| Theme switch (bg + text) | 300ms | ease |
| Streaming AI text (word-by-word fade-in) | ~80ms на слово | ease-out |

**Запрещено:** bouncy springs, scroll-driven parallax, infinite-loop декоративные анимации, motion-as-decoration.

## 9. Декорация

- **Бумажная зернистость на фоне:** `radial-gradient(rgba(26,22,20,0.025) 1px, transparent 1px); background-size: 4px 4px;`. На dark: `rgba(255,255,255,0.018)`. Очень тонкая, не «текстура».
- **Hairline-разделители:** 1px `var(--hairline)`. Как в печатном журнале.
- **Нумерация секций:** `01 / mockup`, `02 / specimens` — в JetBrains Mono, малым кеглем, цвет `--text-tertiary`. Тон «нормативного документа» без пафоса.

## 10. Учёт расхода (UI-единица)

**Кредиты + переменный множитель модели.** Юзер платит в ₽, получает кредиты на месяц (по подписке) + опциональную докупку (вне подписки, переносится на 1 месяц).

| Модель | Множитель |
|---|---|
| GigaChat Lite, GPT-mini | 1.0× кредит |
| Claude Sonnet, GPT-4o | 1.5× кредит |
| Claude Opus, o1-pro | 2.2× кредит |

**Единица кредита** ≈ обработка ~1 500 токенов входа + 500 токенов ответа на Lite-модели. Точные значения настраиваются в `gateway/litellm-config.yaml` через цены провайдеров.

**Где показываем:**
1. Сайдбар (компакт): `1 173 / 1 700 кредитов · Сброс через 4 дня · «Профи»`.
2. Перед запуском задачи: оценка стоимости — `~12 кредитов · Sonnet 1.5×`.
3. Страница «Кредиты и подписка»: прогресс месяца, тарифная таблица (множители), история платежей с колонкой «Кредиты», CTA «Докупить +500 кредитов · 1 290 ₽».

## 11. Использование в коде

**Tailwind theme.** Все токены доступны через `var(--*)` CSS-переменные. В `desktop/packages/ui/src/styles/theme.css` будет создан слой ourapp-tokens, который перекрывает opencode-овский Radix-gray.

```css
:root {
  --ourapp-bg-page: #FBF9F4;
  --ourapp-accent: #0B5345;
  --ourapp-font-display: 'IBM Plex Serif', serif;
  --ourapp-font-body: 'Onest', sans-serif;
  /* ... все токены из секций 4–8 ... */
}
[data-theme="dark"] { /* override block */ }
```

**SolidJS / Kobalte:** компоненты opencode (`packages/ui/src/components/*`) переиспользуем как есть — они принимают токены через CSS-переменные. Брендирующий слой — в `packages/desktop/src/renderer/styles.css`.

**Шрифты:** хостим через `@fontsource/ibm-plex-serif`, `@fontsource/onest`, `@fontsource/jetbrains-mono` (npm) — не через CDN Google Fonts (offline-сборка должна работать).

## 12. Скрываем dev-фичи opencode

(Перенос из плана, чтобы было в одном месте.)

В форке `desktop/`:
- Отключить terminal-панель (`node-pty`-привязки).
- Скрыть file-tree, code-diff, LSP.
- Спрятать VS Code-расширение из сборки.
- Тема `dev` / IDE-цветовые JSON-схемы (`amoled`, `dracula`, `monokai`, etc.) — выпилить из дефолтов, оставить только наши `light` и `dark`.

## 13. Decisions Log

| Дата | Решение | Обоснование |
|---|---|---|
| 2026-05-24 | Дизайн-система создана | `/design-consultation`. Направление — Restrained Editorial. Light как дефолт, dark опциональный |
| 2026-05-24 | Шрифт display — IBM Plex Serif | Премиум-сигнал, дифференциация от КонсультантПлюс/Гарант, сильная кириллица |
| 2026-05-24 | Шрифт body — Onest | Современный RU-оптимизированный гротеск, не overused, бесплатный |
| 2026-05-24 | Accent — deep emerald `#0B5345` | «Закон + деньги + природа», уникален в категории RU legal-tech |
| 2026-05-24 | Фон — кремовый `#FBF9F4`, не белый | Премиум-восприятие, ассоциация с бумажным документом |
| 2026-05-24 | Единица учёта в UI — кредиты с множителем модели | Отмена прежнего решения «задачи в месяц» (раздел 5/10 плана). Прозрачнее, честнее, мэппится на провайдерские цены. Модель: подписка + докупка |

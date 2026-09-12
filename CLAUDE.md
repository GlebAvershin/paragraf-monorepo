# OurApp — context for Claude Code sessions

> This file is read by Claude Code at the start of any session in `D:\TEMKA`.
> Keep it scannable. Detailed plan lives in `~/.claude/plans/hidden-purring-nest.md`.
> Design system lives in `DESIGN.md` — read it before any visual/UI work.

## What we're building

Desktop AI agent for **lawyers and accountants in Russia/CIS** (Phase 4: managers). Fork of [`anomalyco/opencode`](https://github.com/anomalyco/opencode) (Electron + SolidJS) with our own LLM Gateway, billing, and document tools layered on top.

Vertical 1 = lawyers, Vertical 2 = accountants, both ship in MVP. Two-door UX, shared infrastructure, different scenario libraries.

## Tech stack

- **Language:** TypeScript everywhere
- **Runtime:** Bun (matches opencode)
- **Backend:** Hono (Bun server framework)
- **DB:** PostgreSQL + Drizzle ORM
- **Gateway:** LiteLLM Proxy (Docker) — abstracts Claude/GPT/GigaChat
- **Frontend:** SolidJS + Tailwind + Kobalte (inherited from opencode fork)
- **Desktop shell:** Electron (inherited from opencode fork)
- **Document parsing:** unpdf, mammoth, SheetJS, docx
- **Payments:** CloudPayments (recurrent subscriptions)

## Project layout

```
D:\TEMKA\
├── README.md           Top-level navigation & smoke-test cookbook
├── CLAUDE.md           This file (Claude Code context)
├── .claude/skills/     Dev-team skills (gstack) — DO NOT ship in product
├── web/                Веб-рендерер (форк opencode, SolidJS) — наш фронт. Был отдельным
│                       репо github.com/GlebAvershin/glar; влит в монорепо 2026-06-26.
│                       upstream opencode БОЛЬШЕ НЕ подключён — код наш, используем
│                       свободно. dev: `bun run --cwd web dev:web` (vite :5173).
├── engine/             Наш чат-движок (Hono + Postgres) с контрактом opencode. Веб → сюда.
├── billing/            Bun/Hono: users, OTP auth, subscriptions, credits, payments, ETL.
├── doc-tools/          Pure-TS parsers (PDF/DOCX/XLSX) + DOCX generator. Tests pass 10/10.
└── landing/            Маркетинговый лендинг (Astro, :4321).
```

> **СЛИЯНИЕ glar → `web/` (2026-06-26).** Раньше было 3 репо (monorepo + gateway + glar).
> По просьбе команды свели к **2**: `web/` (бывший glar) влит в монорепо как обычный наш
> код — `.git`/`upstream`-связь с anomalyco/opencode убрана, pristine `opencode/` удалён.
> «Не зависим от opencode» = операционно (репа не тянет upstream); код всё ещё производный
> от opencode и используется свободно. **Историческое:** все ссылки `desktop/<…>` ниже =
> теперь `web/<…>` (каталог переименован при слиянии).

> **РАЗВОРОТ АРХИТЕКТУРЫ (2026-06-27) — модель/маскирование/ML ушли в gateway (РФ).**
> Граница теперь по кнопке «отправить»: monorepo = всё ДО (UI/сценарии/БД/бэкенд), gateway
> (`paragraf-gateway`, **РФ**) = всё ПОСЛЕ (вызов модели, маскирование, демаск, ML-валидация).
> В gateway добавлен Bun/Hono app-слой (`app/`, :4100) перед LiteLLM с endpoint `/answer`.
> Движок шлёт ему СЫРОЙ текст (+ картинки-сканы как attachments); gateway делает OCR,
> маскирование, выбор модели («auto»), вызов модели, ML-валидацию и демаск. **Поэтому ВСЕ
> заметки ниже про клиентские маскирование/OCR/авто-модель (renderer, `web/ourapp/pii`,
> `auto-model/classify`) УСТАРЕЛИ** — это всё переехало в gateway, а клиентский `web/ourapp/pii`
> (masker + ocr) и client classify/resolve УДАЛЕНЫ. Полный план/статус/контракты —
> `docs/arch-migration.md` (фазы 1–5 + авто-модель + уборка — сделаны).

> **gateway вынесен в ОТДЕЛЬНЫЙ репо** (github.com/GlebAvershin/paragraf-gateway —
> зарубежный деплой, см. DEPLOY.md). Для локального дева клонируется соседней папкой
> `../paragraf-gateway`; `up.ps1`/`down.ps1` смотрят туда (override `$env:PARAGRAF_GATEWAY_DIR`).
> Внутренняя структура шлюза (litellm-config.yaml, docker-compose.yml, .env) не изменилась —
> ссылки на `gateway/<файл>` ниже теперь относятся к корню репо paragraf-gateway.

## Phase 1 (local-first) — running services

When the user says "поднять стек" they mean the **4 components below**. NB:
Docker containers (gateway_litellm, gateway_postgres, billing_postgres) **disappear
on Docker Desktop restart** — after a machine reboot you must re-run `docker compose up -d`
in BOTH gateway/ and billing/, or `/me`, `/limits` and model calls all 500 with
`ECONNREFUSED`. This bit us repeatedly; always check all four are up before debugging app code.

**One-command stack** (recommended): `D:\TEMKA\up.ps1` brings up gateway + billing
Postgres, **applies manual migrations** (idempotent), starts the billing service in
a separate window (OTP login codes appear there), and starts the **ETL worker loop**
(credits don't decrement without it). `down.ps1` stops billing+ETL (add `-Docker` to
also stop containers). Desktop is launched separately (printed at the end). Run from
a normal PowerShell: `cd D:\TEMKA; .\up.ps1`. The scripts are ASCII-only and use
`$ErrorActionPreference="Continue"` so native-tool stderr (docker progress, psql
NOTICE) doesn't abort them.

```bash
# bun is NOT on PATH in fresh shells — prefix: PATH="C:/Users/Home/.bun/bin:$PATH"
# (or in PowerShell: $env:PATH = "C:\Users\Home\.bun\bin;$env:PATH")

# 1. Gateway (LiteLLM + its Postgres)
cd /d/TEMKA/../paragraf-gateway && docker compose up -d   # отдельный репо; exposes :4000

# 2. Billing Postgres (container) + service (bun process)
cd /d/TEMKA/billing && docker compose up -d        # postgres on :5433
NODE_ENV=production bun run src/index.ts &          # exposes :3000

# 3. Desktop (Electron via electron-vite). Use --cwd, NOT Set-Location — the
#    background shell ignores cwd changes and Electron then can't find the app.
bun run --cwd /d/TEMKA/desktop dev:desktop          # renderer on :5173

# 4. Verify ALL of:
curl http://localhost:4000/health/liveliness        # → "I'm alive!"
curl http://localhost:3000/health/readiness         # → {"status":"ok","db":"ok"}
```

**Health-check one-liner** (run this first when something 500s):
```bash
curl -s -o /dev/null -w "gw:%{http_code} " http://localhost:4000/health/liveliness; \
curl -s -o /dev/null -w "bill:%{http_code}\n" http://localhost:3000/health/readiness
# anything other than gw:200 bill:200 → a service/container is down, fix that BEFORE app code
```

### Auth in dev (OTP login)
По умолчанию SMTP не настроен (`SMTP_HOST` пуст) → OTP-код **печатается в консоль
billing**, не шлётся письмом. Чтобы войти: запросить код в приложении, затем grep
по выводу billing: `Код для входа: NNN NNN`. Login is OTP-only now (magic-link URL +
/auth/verify + /auth/web-callback were removed — see PATCHES / git log).

### Вход — ТОЛЬКО по allowlist (2026-07-01, security-фикс)
**Самозапись закрыта.** Раньше `/auth/verify-otp` авто-создавал юзера+подписку+
LiteLLM-ключ+кредиты на ЛЮБОЙ подтверждённый email → любой владелец почты сам
заводил рабочий кабинет за наш счёт (случайная авторизация + утечка бюджета).
Теперь `/magic-link` шлёт код **только** заранее заведённому активному юзеру
(status=active), `/verify-otp` **не создаёт** пользователей — только вход
существующего. Неизвестный/blocked email → тот же ответ, что неверный код
(204 на magic-link, 400 на verify — не раскрываем существование аккаунта).
**Кабинеты создаём вручную:** `cd billing && bun run create-user <email> ["Имя"]`
(нужен поднятый LiteLLM-шлюз :4000 + `db:seed`). Идемпотентно.
**Брутфорс-защита OTP:** новый запрос кода гасит прежние (в любой момент валиден
1 код); 5 неверных попыток → код исчерпан (колонка `magic_link_tokens.attempts`,
миграция `2026-07-01-otp-attempts.sql`). После лока — просто запросить новый код.
**Известные пределы (не блокеры MVP):** OTP хранится несолёным SHA-256 (при утечке
БД 10⁶ предвычислимы — но TTL 15 мин + allowlist + лок сужают риск); JWT
заблокированного юзера живёт до 30 дней (нет отзыва токена — для отзыва нужен
короткий TTL/blocklist). Тесты: `bun run test:e2e` (OTP-путь) 6/6.

**SMTP (ТЗ — 2026-06-14).** Код отправки (`lib/email.ts`, nodemailer) рабочий и
**проверен вживую** через локальный перехватчик **Mailpit** (`billing/docker-compose.yml`,
SMTP :1025, web-UI http://localhost:8025). Три режима в `.env` (см. `.env.example`):
(1) пусто → консоль; (2) `SMTP_HOST=127.0.0.1 SMTP_PORT=1025` → Mailpit;
(3) прод-провайдер. **РЕКОМЕНДАЦИЯ — Yandex Cloud Postbox** (транзакционный сервис,
2000 писем/мес бесплатно, РФ-инфра/152-ФЗ; эндпоинт+креды из консоли Postbox). НЕ
личная Яндекс.Почта (с 29.06.2026 бесплатный SMTP Почты отключают) и не Yandex 360
(платный). Альтернативы: Mailopost / SMTP.bz / Unisender Go. Примеры в `.env.example`. **Грабли:** в dev именно `127.0.0.1`, НЕ `localhost` — Bun на Windows
не резолвит localhost для SMTP (`DNSException ETIMEOUT`). `email.ts` при старте делает
`transporter.verify()` и логирует успех/ошибку. `465`→implicit TLS, `587`/прочее→STARTTLS.
OTP-письмо и платёжные уведомления рендерятся (кириллица, HTML) — поймано Mailpit 2/2.

### CloudPayments billing (ТЗ-02)
Payment endpoints (`/payments/*`, `/webhooks/cloudpayments`) return **503** unless
`CLOUDPAYMENTS_PUBLIC_ID` / `CLOUDPAYMENTS_API_SECRET` are set — this is correct
graceful degradation, not a bug. To exercise the full flow without a real acquirer:
```bash
# integration test against an in-process CloudPayments mock (hits real billing Postgres)
cd /d/TEMKA/billing && bun run test:payments   # 7 tests: card-bind, topup, decline, webhook HMAC, idempotency
```

Test user already exists in DB: `test@example.com` with virtual_key `sk-nk7YaSwLZijpZj9Gyyisgw` ($2 budget, 4 models, Free plan).

## Commands (build / lint / test / typecheck)

`bun` is NOT on PATH in fresh shells — prefix every command:
`$env:PATH = "C:\Users\Home\.bun\bin;$env:PATH"` (PowerShell) or
`PATH="C:/Users/Home/.bun/bin:$PATH"` (bash).

**Keep all three of our packages green on `typecheck` — a new error means your change introduced it.**

| Package | Dir | Typecheck | Test (all) | Single test |
|---|---|---|---|---|
| app (desktop fork) | `desktop/packages/app` | `bun run typecheck` (`tsgo -b`) | `bun run test:unit` | `bun test --preload ./happydom.ts ./src/ourapp/<x>.test.ts` |
| billing | `billing` | `bun run typecheck` (`tsc --noEmit`) | `bun test` | `bun test test/payments-flow.test.ts` |
| doc-tools | `doc-tools` | `bun run typecheck` | `bun test` | `bun test test/<x>.test.ts` |

- **App tests need the happy-dom preload** (`--preload ./happydom.ts`) — bare `bun test <file>` in `packages/app` fails on DOM globals. Watch: `bun run test:unit:watch`. E2E: `bun run test:e2e` (Playwright).
- **Filter by test name:** append `-t "<substring>"` to any `bun test` command.
- **Billing has dedicated suites:** `bun run test:payments` (CloudPayments mock, hits real Postgres) and `bun run test:e2e` (golden §13 path). Both set `CLOUDPAYMENTS_*` env internally; under a combined `bun test` run the env-singleton must match across files (see ТЗ-05/06 lesson).
- **Lint** (whole fork, from `desktop/`): `bun run lint` (oxlint). **Whole-fork typecheck:** `bun turbo typecheck`. **Don't** run `bun test` from `desktop/` root — it intentionally errors (`"do not run tests from root"`); cd into the package.
- **DB (billing):** `bun run db:push` (schema from `schema.ts`, `--force`), `bun run db:seed` (plans + model_rates), `bun run db:studio`. Manual migrations are applied separately — see the ТЗ-01/02 lesson on applying, not just writing, them.
- **Dev servers** (full stack: see "Phase 1 — running services"): billing `bun run dev` (`:3000`, hot); app `bun run --cwd desktop dev:desktop` (Electron) or `dev:web` (renderer only, `:5173`); ETL worker `NODE_ENV=production bun run src/worker/etl.ts` (one-shot — credits don't decrement without it).

## Conventions

- **Locale:** UI text in Russian. Code/comments in English unless they capture domain terms.
- **Money:** kopecks (RUB) and micro-cents (USD) — never floats. See `billing/src/db/schema.ts`.
- **Secrets:** never commit. `.env.example` documents the schema, `.env` is gitignored.
- **Tests:** `bun test` in each package. Round-trip-style preferred over fixtures.
- **Logging:** `pino` with secret redaction. Never log `litellmKey`, `apiKey`, `master_key`.

## Stack — what's where

| Concern | Location | Notes |
|---|---|---|
| LLM provider config | `desktop/packages/llm/src/providers/anthropic.ts` | Patched: auto-detect Bearer when baseURL ≠ api.anthropic.com |
| User config schema | `desktop/packages/opencode/src/config/provider.ts` | Includes our `bearer?: boolean` field |
| Smoke-test for the patch | `desktop/scripts/verify-bearer-patch.ts` | 8 cases, runs offline |
| Default Gateway target | `desktop/.opencode/opencode.jsonc` | `baseURL: http://localhost:4000` |
| Skill format reference | `.claude/skills/careful/SKILL.md` | Borrowed pattern for our future scenarios |

## Dev tooling — gstack (Garry Tan's Claude Code setup)

Installed in **project-local mode** at `.claude/skills/`. 51 skills available; use the ones below day-to-day:

| Skill | When to invoke |
|---|---|
| `/office-hours` | Start of session — what are we working on |
| `/plan-ceo-review` | Before starting a feature — strategic sanity check |
| `/careful` | Before any destructive op (drop table, force push, db wipe) |
| `/investigate` | Debug sessions |
| `/review` | Before merging a branch |
| `/qa` | UI testing (uses headless Chromium) |
| `/context-save`, `/context-restore` | End / start of work session — preserve state |
| `/learn` | Capture knowledge we just gained |

Skip: `/ios-*` (not our stack), `/design-shotgun` (not now), `/cso` (later, before prod).

`/gstack-upgrade` refreshes gstack from upstream. Re-run `./setup --local` after `git pull` because Windows uses file copies, not symlinks.

## Design system

Always read `DESIGN.md` before making any visual or UI decisions. All font choices, colors, spacing, motion, and aesthetic direction are defined there. Do not deviate without explicit user approval. In QA mode, flag any code that doesn't match `DESIGN.md`. Working preview lives at `design/preview.html` — open in browser to see the system live.

**Билинг-модель (важно — отменяет старое «задачи в месяц»):** Кредиты с переменным множителем модели. Юзер платит ₽, получает кредиты по подписке + опционально докупает (докупленные не сгорают месяц). Множители: Lite 1.0×, Sonnet 1.5×, Opus 2.2×. Под капотом — токены × прайс-лист провайдера. См. DESIGN.md §10 и план §5/§10.

## What NOT to do

- **All fork/UI work goes in `web/`** (бывший glar). `opencode/` pristine-клон удалён при слиянии 2026-06-26; upstream больше не подключён.
- **Don't write to `~/.claude/`** — it's the global agent config, off-limits. Project-local at `.claude/` is fine.
- **Don't import gstack skills into the product** — those are dev tools for us, not features for end users. End-user scenarios live in `web/packages/scenarios/` (to be created in Phase 2).
- **Don't use real `ANTHROPIC_API_KEY` in committed files.** Always `.env` or the LiteLLM `gateway/.env`.

## Where the plan lives

`~/.claude/plans/hidden-purring-nest.md` — full strategic plan, architecture, MVP scope, GTM, risks, billing design. Update this file when decisions change.

## Operational notes

- **Docker env reload:** `docker compose restart litellm` does NOT re-read `.env`.
  After editing `gateway/.env`, use `docker compose up -d --force-recreate litellm`
  to recreate the container with new env vars.
- **Claude через шлюз ↔ tpm/rpm-лимиты ключа (КРИТИЧНО, 2026-06-13).** LiteLLM 1.85.1
  (`main-stable`) v3 rate-лимитер при наличии `tpm_limit`/`rpm_limit` на virtual-key
  **протекает внутренними полями** (`_litellm_rate_limit_descriptors`,
  `_litellm_{tpm,rpm}_reserved_{tokens,model,scopes,…}`) прямо в тело запроса к Anthropic
  → Claude отвечает `400 "… Extra inputs are not permitted"` (GigaChat/Yandex не задеты —
  у них свой transform). `drop_params`/`additional_drop_params` НЕ спасают (полей много,
  whack-a-mole), env `LITELLM_DISABLE_V3_RATE_LIMITER` не помог. **Фикс:** не ставить
  tpm/rpm на ключи — `billing/routes/subscriptions.ts` `createKey` больше их не передаёт
  (лимитируем через `maxBudgetUsd` + кредиты). Существующим ключам сбросить:
  `POST /key/update {key, tpm_limit:null, rpm_limit:null}` + рестарт litellm (сброс кэша).
  Вернуть rpm/tpm можно после пина/фикса версии LiteLLM. NB: `main-stable` — подвижный
  тег. **ЗАПИННУТО (2026-06-14):** `gateway/docker-compose.yml` теперь ссылается на
  иммутабельный digest `ghcr.io/berriai/litellm-database@sha256:fb757549de0da017a597ee4b9be0bfb55c49cde77898abe789fa3ad37d770c69`
  (= 1.85.1), а не на `:main-stable` — случайный re-pull больше не подменит версию.
  Бамп версии: вернуть `:main-stable`, `docker compose pull litellm`, перепроверить
  tpm/rpm-баг (тест выше), снять новый digest. Возврат rpm/tpm на ключи — только после
  такой проверки на конкретном digest.
- **Фолбэки шлюза ОТКЛЮЧЕНЫ (2026-06-14).** В `litellm-config.yaml` был мёртвый фолбэк
  `claude-sonnet/opus → gpt-4o`, но `OPENAI_API_KEY=sk-placeholder` → при сбое Anthropic
  клиент получал не ответ, а 401 gpt-4o (ложная отказоустойчивость). Закомментирован.
  Сознательно НЕ включён тихий фолбэк на РФ-модель: для юр/бух-документов незаметная
  подмена Claude→GigaChat = скрытая просадка качества (хуже явной ошибки). GigaChat-pro
  проверен рабочим — готовый опт-ин лежит в комментарии рядом с `fallbacks:`. Вернуть при
  появлении реального OpenAI-ключа ИЛИ продуктового решения разрешить degradation на РФ.
- **GigaChat model names:** Sber's API expects `GigaChat`, `GigaChat-Pro`, `GigaChat-Max`
  (no `-2` suffix). LiteLLM docs mentioning `GigaChat-2-Pro` are outdated as of 2026-05.
- **GigaChat spend tracking:** LiteLLM has no built-in cost table for GigaChat. Add
  `input_cost_per_token`/`output_cost_per_token` to `model_info` in litellm-config.yaml
  if you want budget enforcement to apply to GigaChat. Not needed for free-tier dev.
- **OAuth RqUID:** Sber OAuth endpoint requires a non-empty `RqUID` UUID header. On
  Windows Git Bash `uuidgen` is not available — use a hardcoded UUID or
  `powershell -Command "[guid]::NewGuid()"` (with explicit `tr -d '\r'`).

## Lessons from agent-built features (ТЗ-01/02/03 review, 2026-05-30)

Three large tasks were built by a sub-agent and reviewed live. Two failure modes
recurred — bake these into any future TZ / agent prompt:

- **DB migrations must be APPLIED, not just written.** The agent created
  `billing/drizzle/manual/2026-05-26-cloudpayments.sql` correctly but never ran it
  against the live DB. Result: `pending_plan_code does not exist` → `/me`, `/limits`,
  `/payments/history` all 500'd. Apply manual migrations with:
  `docker exec -i billing_postgres psql -U billing -d billing < drizzle/manual/<file>.sql`
  then verify the touched endpoints return 200, not 500. **Checklist item for any
  schema change.**
- **Ban `as any` / `as never` casts.** The agent wrote `tx.execute({sql, args} as never)`
  in THREE places (`credits.ts` chargeCredits, `webhooks.ts` handlePay/handleFail) —
  wrong drizzle API. The cast silenced the type error, so `typecheck` passed, but it
  threw at runtime (`query.getSQL is not a function`). The advisory-lock crash would
  have killed credit-charging and subscription-renewal webhooks in production. Correct
  form: `tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtext(${id})::bigint)\`)` with
  `sql` imported from `drizzle-orm`. Only `bun run test:payments` (mock integration)
  caught it — code-review alone did not.
- **Scenario `resultAction` must match intent.** Generative scenarios (договор,
  претензия, ответ ФНС, пояснительная записка) → `generate_docx` (output IS a document,
  show download/preview). Analytical ones (проверка рисков, сравнение редакций,
  проверка первички, краткое содержание, объяснение НК, сверка реквизитов) →
  `show_in_chat` (output is a report, no docx artifact). The agent set `generate_docx`
  on everything; fixed in `scenarios/library/{lawyer,accountant}.ts`. The docx-button
  visibility is driven by this via `scenarios/docx-result-tracker.ts` (marks a session
  as docx-producing) OR the `looksLikeDocument` heuristic in `message-timeline.tsx`.

## Lessons from agent-built features (ТЗ-04/05/06 review, 2026-05-30, part 2)

- **drizzle array filters: use `inArray()`, not raw `= ANY()` or `sql.raw`.** In
  `routes/usage.ts` the agent wrote `sql\`${col} = ANY(${subIds}::uuid[])\`` — postgres-js
  mis-serialises a single-element JS array → runtime `malformed array literal`. Also
  `sql.raw(\`(${ids.map...})\`)` for IN-lists is an injection risk. Both → `inArray(col, ids)`.
  Returns 500 only at runtime (typecheck passes). Verified by hitting `/usage/*` live.
- **Dates in raw `db.execute(sql\`...\`)` must be ISO strings.** `created_at >= ${dateObj}`
  throws `must be of type string ... Received an instance of Date`. drizzle query-builder
  (`gte(col, date)`) accepts Date, but raw `sql` template does not — use
  `${date.toISOString()}`. Bit us in `usage.ts` summary aggregations.
- **ETL ↔ LiteLLM spend-logs — three gotchas (worker/etl.ts):**
  1. `/spend/logs?start_date=X&end_date=Y` returns a **daily AGGREGATE** (`{date, spend,
     users, models}`), NOT per-request rows. For per-request logs call `/spend/logs`
     **without** date params and filter client-side by `startTime`. The agent's date
     params silently broke ingestion (processed:0 → usage_events empty, no credit charges).
  2. `api_key` in spend-logs is **sha256(litellmKey) hex**, not the plain key. Match via
     a `Map<sha256(key), subId>` (see `buildKeyHashMap`), not by `litellmKey === apiKey`.
  3. Use `model_group` (the litellm-config `model_name` alias, e.g. `gigachat-lite`) for
     rate lookup + usage_events.model — NOT `model` (LiteLLM internal `gigachat/GigaChat`),
     which won't match `model_rates.modelCode`. Wrong field → fallback 1-credit charge.
  Run ETL manually in dev: `cd billing && NODE_ENV=production bun run src/worker/etl.ts`
  (one-shot) — it's NOT auto-running, so credits don't decrement until you run it.
- **PII masking is integrated both ways** (ТЗ-04). Masking in `submit.ts` (both send
  paths delegate to `sendFollowupDraft`), demasking in `ui/.../message-part.tsx` via
  `window.ourappUnmask`. Placeholders are `__PII_FIO_1__` (tokenizer-stable). Auto-off
  for GigaChat/YandexGPT (RU models — data stays in RU). 33/33 tests in `pii/pii.test.ts`.
  NB: live network round-trip NOT yet verified (needs a working Claude/GPT key through
  the gateway) — only unit round-trip (mask→unmask) is covered.
- **Session export (ТЗ-05) needed two fixes:** (a) history sessions are lazy-loaded —
  `globalSync.child(dir,{bootstrap:false}).message` is EMPTY for non-open sessions; load
  on demand via `globalSDK.client.session.messages({directory, sessionID, limit})` which
  returns `{data:[{info:Message, parts:Part[]}]}`. (b) PDF export needs a real Electron
  path: added `ipcMain.handle("ourapp-print-pdf")` (offscreen BrowserWindow →
  `webContents.printToPDF`, correct Cyrillic) + `api.printToPDF` in preload. The agent's
  `downloadAsPdf` silently fell back to DOCX because `api.printToPDF` didn't exist.
  Also rewrote `markdownToHtml` in `session-export.ts` to render tables/headings/lists
  (was H1/H2/para only). **Editing Electron main/preload requires a FULL desktop restart**
  (HMR doesn't reload the main process).

- **E2E golden-scenario test (`test/e2e-golden.test.ts`, `bun run test:e2e`)** covers
  the §13 path: OTP login → JWT → 30-credit start → ETL-style charge → balance drops →
  /usage analytics → idempotency → CSV export. **It found a real bug:** ETL never called
  `invalidateLimitsCache` after charging, so the sidebar balance lagged up to 60s after
  every model call. Fixed: `etl.ts` now invalidates per userId (added userId to the
  key-hash map). Integration tests share one process under `bun test`, so config-singleton
  env must match across files — `e2e-golden.test.ts` sets the same `CLOUDPAYMENTS_*` env
  as `payments-flow.test.ts`, else 5 payments tests fail on combined runs. Full suite: 13/13.
- **CI billing job applies schema+seed before tests.** Fresh CI Postgres is empty —
  added `bun run db:push` (schema from schema.ts, covers otp_hash/pending_plan_code/etc)
  + `bun run db:seed` (plans + model_rates) before `bun test`. Removed the `|| true`
  crutches now that typecheck is green and tests pass. The seed step needs JWT_SECRET +
  LITELLM_* env because seed.ts imports config (fail-fast on missing secrets).

## OCR-маскирование сканов (ТЗ-04 Этап 1, 2026-06-07)

Сканы-картинки (PNG/JPG фото документов) распознаются **локально** через
Tesseract.js (`ourapp/pii/ocr.ts`, рус+eng) ДО отправки — чтобы в облачную модель
уходил текст, а не картинка с ПДн (152-ФЗ). Поток: `attachments.ts add()` —
**синхронный** OCR при загрузке image (не фоновый — иначе race: юзер шлёт картинку
до распознавания), если `looksLikeDocumentScan` (≥30 букв, conf≥25%) → mime
`ourapp/scanned-doc` + extractedText. `submit.ts` всегда инлайнит скан текстом
(`inlineScans=true`): не-Vision модели (GigaChat Lite) картинку не принимают вовсе,
зарубежным Vision-моделям картинку с ПДн слать нельзя. Маскирование текста — только
при piiMode≠off. Проверено: GigaChat отвечает по содержимому скана-договора.
**Грабли:** (1) Tesseract движок работает и в Node (conf 94 на чистом тексте), и в
Electron renderer — НЕ требует доп. настройки worker/wasm в dev (langData с CDN).
(2) Реальные фото-сканы дают conf ~35-45% (наклон/качество) → порог снижен до 25,
иначе отсекались. (3) На грязном OCR маскирование может пропустить искажённые ПДн —
известный предел, лечится препроцессингом (контраст/выпрямление) — Этап 2.
(4) PDF идёт НЕ через OCR, а через unpdf (текстовый слой); OCR — только для image/*.
(5) OCR работает в ДВУХ путях загрузки (2026-06-14): композер (`attachments.ts`) И
мастер сценариев (`scenarios/run-scenario.ts` — image-файлы → `ocrImageToText`, mime
`ourapp/scanned-doc`; раньше мастер гнал всё через office-парсер и молча выбрасывал
картинки). Сканы-типы (.jpg/.jpeg/.png/.webp) добавлены в `accept` сценариев с
загрузкой документа (проверка договора/первички, сравнение редакций, краткое
содержание, приложение к претензии). Найдено QA-проходом п.4.

**OFFLINE OCR (prod):** языковые данные (rus/eng `.traineddata.gz`), `worker.min.js`
и core wasm скопированы в `desktop/packages/app/public/{tessdata,tesseract}`;
`ocr.ts` указывает `langPath:/tessdata`, `workerPath`/`corePath:/tesseract` — без CDN.
Vite отдаёт их с корня. Regen при обновлении tesseract.js:
пересоздать public/tesseract из node_modules (`tesseract.js-core@<ver>`) + перекачать traineddata.
- **КРИТИЧНО — MIME для `*.wasm.js` (2026-06-14, нашёл QA-проходом п.4).** Vite dev-сервер
  отдаёт core-файлы `tesseract-core-*.wasm.js` с `Content-Type: text/html` (из-за `.wasm`
  в имени они идут не в статику, а в SPA-fallback). `importScripts()` в web-worker'е строго
  требует JS-MIME → `NetworkError: failed to load` → OCR падает ПОЛНОСТЬЮ (и композер, и
  мастер сценариев). 200 в curl НЕ достаточно — проверять именно `Content-Type`. Фикс:
  middleware-плагин `opencode-desktop:tesseract-wasm-js-mime` в `packages/app/vite.js`
  отдаёт `/tesseract/*.wasm.js` с `text/javascript`. Применяется и к electron-vite-рендереру
  (он импортит этот же `appPlugin`). **Правка vite.js требует ПОЛНОГО рестарта dev:desktop**
  (конфиг/плагины не подхватываются HMR). В prod не воспроизводится (статику отдаёт electron,
  MIME по расширению корректен).
- **tesseract.js 7.x выбирает core-вариант `relaxedsimd` первым** — в public/tesseract должны
  лежать ВСЕ варианты (`relaxedsimd`/`simd`/обычный, `-lstm` и без), иначе worker падает на
  отсутствующем файле. `cp tesseract-core*.{js,wasm}` из tesseract.js-core целиком.

## Лендинг и waitlist (2026-06-07)

Маркетинговый лендинг — **отдельный Astro-проект** `D:\TEMKA\landing\` (две двери
юрист/бухгалтер, как-работает, вертикали, 152-ФЗ, скачивание, waitlist менеджеров,
footer). Запуск: `cd landing; bun run dev` → :4321. **NB: Astro по умолчанию биндится
только на ::1 (IPv6)** — браузер на localhost (→127.0.0.1) не коннектится; в
`astro.config.mjs` стоит `server.host:true`. Страницы `/offer` + `/privacy` —
LegalLayout с заглушками (помечены `LEGAL: review` — согласовать с юристом).
Waitlist-форма шлёт на billing `POST /waitlist {email,interest,source}` (публичный
роут, идемпотентно по email, таблица `waitlist_signups`, миграция
`2026-06-07-waitlist.sql`). CORS billing уже разрешает localhost-порты, 4321 проходит.
**Заглушки (ждут блокеров):** кнопки «Скачать» → нет установщика (prod-сборка),
деплой → нет домена.

## Сценарии — ДВА источника (техдолг!)

Сценарии заданы в **двух местах**, и `import ... from "./scenarios"` резолвится в
ФАЙЛ `ourapp/scenarios.ts` (приоритет над папкой `ourapp/scenarios/`):
- **`ourapp/scenarios.ts`** — старый/простой формат (`{id, vertical, title, lede,
  steps:число, recommendedModel, prompt}`). Питает **СПИСОК**: welcome-sidebar,
  scenario-library (главная «С чего начать»), home-welcome. Бейджи моделей берут
  `recommendedModel` (lite/mid/top).
- **`ourapp/scenarios/`** (index.ts + library/{lawyer,accountant}.ts) — новый формат
  ТЗ-01 (`{verticals[], steps[], promptTemplate, resultAction, preferredModel}`).
  Питает **WIZARD** (openScenarioWizard → scenarioById).
Связь — по `id`: клик в списке → `openScenarioWizard(scenario.id)` ищет в новой
системе. **При добавлении сценария надо править ОБА файла с одинаковым id**, иначе
он либо не появится в списке (только scenarios.ts питает список), либо не откроет
wizard (нужен в scenarios/). 14 сценариев (7 юрист + 7 бухгалтер) есть в обоих.
TODO: унифицировать на scenarios/ (удалить scenarios.ts, перенести recommendedModel→
preferredModel-маппинг в scenario-library) — но это рефакторинг 4 файлов.

## Авто-выбор модели («Авто», 2026-06-08)

Режим «Авто»: модель под каждый запрос выбирается эвристикой (без LLM-вызова —
бесплатно и мгновенно). **«Авто» — это пункт ВНУТРИ списка моделей** (первая строка
с иконкой `brain`), а НЕ отдельная кнопка. Код в `app/src/ourapp/auto-model/`:
- **`classify.ts`** — чистая `classifyRequest({text, hasDocument})` → тир
  `lite|pro|mid|top` + код модели + `reason`. Порядок правил:
  1. генеративные глаголы (состав/подготов/напиш/исков/претензи/жалоб/пояснительн…)
     ИЛИ длина ≥4000 → **top**;
  2. аналитические (провер/риск/анализ/сравн/сверк/толкован/первичк…) ИЛИ есть документ
     ИЛИ длина ≥1500 → **mid**;
  3. объяснение (объясн/поясни/разъясн/на пальцах/своими словами) ИЛИ длина ≥400 → **pro**;
  4. иначе короткий вопрос → **lite**.
  Карта `TIER_MODEL`: lite=`gigachat-lite`, pro=`gigachat-pro` (оба РФ), mid=`claude-sonnet`,
  top=`claude-opus`. Меняется одной строкой (напр. pro→`gigachat-max`/`yandexgpt`).
- **`resolve.ts`** — `pickAutoModel(input, list)` матчит код по `model.list()` (все
  алиасы под провайдером `anthropic` через шлюз), деградирует top→mid→pro→lite;
  `undefined` если ни одной кандидатной модели нет (тогда остаётся ручная).
- **`store.ts`** — вкл/выкл в localStorage (`ourapp.autoModel.enabled`), по умолчанию ВЫКЛ.
- **`auto-model-row.tsx`** — строка «Авто» в начале списка. Вставлена в ОБА селектора:
  `ModelList` (dialog-select-model.tsx, платный popup) и `DialogSelectModelUnpaid`.
  Клик → `setAutoModelEnabled(true)`. Выбор любой реальной модели → авто ВЫКЛ
  (`setAutoModelEnabled(false)` в их onSelect). `current` списка = undefined при авто.
- **`model-trigger-label.tsx`** — содержимое кнопки-триггера: при авто показывает
  «Авто» (иконка brain), иначе иконку провайдера + имя модели. Заменяет повторявшийся
  inline-блок в 4 местах prompt-input (платный/бесплатный × старый/новый дизайн).
- **Перехват** в `prompt-input/submit.ts` `handleSubmit`: если `getAutoModelEnabled()`,
  до сборки драфта подменяем `model` на `pickAutoModel(...)`; при подмене сбрасываем
  `variant`. PII-маскирование завязано на `modelID` → для авто-Claude маскирование
  включится само, для GigaChat — выкл.
- Реально выбранная модель пишется в user-message → юзер видит, что использовалось.
Тесты: `app/src/ourapp/auto-model/auto-model.test.ts` (13/13). Решения: эвристика
(не LLM-роутер), пул GigaChat(lite/pro)/Claude(sonnet/opus); gigachat-max/yandexgpt —
конфигурируемые свопы в `TIER_MODEL` (в ладдере по умолчанию не используются).

## Скрытие opencode Zen из списка моделей (2026-06-08)

opencode по умолчанию подключает свои **бесплатные** облачные модели (OpenCode Zen:
DeepSeek/MiMo/Nemotron). Для нашего продукта они вредны: обходят биллинг (кредиты не
списываются), обходят 152-ФЗ (данные не в РФ, без маскирования), не входят в пул.
Скрыты целиком через `HIDDEN_MODEL_PROVIDERS = new Set(["opencode","opencode-go"])`
(`context/models.tsx`, экспортируется):
- `available()` в models.tsx фильтрует их из списка → не видны нигде (селектор, настройки).
- `validModel()` в `local.tsx` считает их невалидными → выбор/фоллбэк на них не садится
  (если был выбран opencode-модель, current() сбрасывается на модель шлюза).
Также убрана пометка «Бесплатно» (`isFree`→false в dialog-select-model.tsx; безусловный
тег удалён в dialog-select-model-unpaid.tsx) — в нашем сервисе бесплатных моделей нет.
**YandexGPT в шлюзе — 2 модели:** `yandexgpt-pro` и `yandexgpt-lite` (litellm-config.yaml).
Алиас именно `yandexgpt-pro` (не голый `yandexgpt`). URI у Яндекса остаётся
`yandexgpt/latest` (это и есть Pro). Нужен `YANDEX_API_KEY`/`YANDEX_FOLDER_ID` (в dev нет).
**ВАЖНО — откуда имена РФ-моделей в пикере:** GigaChat/YandexGPT объявлены ЯВНО как
провайдер `ourapp-ru` (name «Российские модели») в **глобальном**
`~/.config/opencode/opencode.jsonc` (НЕ project `desktop/.opencode/...`, и НЕ из шлюза/
models.dev/`displayNameRu`). Имя «YandexGPT Pro» и `limit` берутся оттуда. Поэтому при
ДОБАВЛЕНИИ/ПЕРЕИМЕНОВАНИИ модели надо синхронно править ЧЕТЫРЕ места: (1) `model_name`
в `gateway/litellm-config.yaml`, (2) ставку в `billing/seed.ts` + re-seed, (3) `allowedModels`
тарифов + allowed-models существующих LiteLLM-ключей (`POST /key/update`), (4) блок
`ourapp-ru.models` в глобальном opencode.jsonc. Иначе: имя не сменится (п.4), вызов 400/403
(п.1/3), или ETL спишет дефолт (п.2). После правки конфига — ПОЛНЫЙ перезапуск десктопа
(opencode читает config на старте). Ключ провайдера `ourapp-ru` — sk-nk7 (test@example.com).
**Рассинхрон имён выровнен (2026-06-08):** раньше в `seed.ts` НЕ было ставок для Yandex
вовсе → ETL списывал бы дефолт 1 кредит. Добавлены `yandexgpt-pro` (mid 1.5×) и
`yandexgpt-lite` (lite 1.0×) под именами шлюза + Yandex в `allowedModels` всех 4 тарифов.
**Грабли:** имя в пикере и доступность модели фильтруются по **allowed-models самого
LiteLLM-ключа**, а не только по конфигу. После переименования алиаса существующие ключи
держат старый список → нужен `POST /key/update {key, models:[...]}` (или пересоздание
ключа/смена тарифа), иначе `/v1/models` и пикер показывают старое + вызов даёт 403.
Master-key — в `gateway/.env`. Кэш ключа в памяти LiteLLM — сбрасывается рестартом
контейнера.

## Claude API + «Углублённое размышление» + Opus 4.8 (2026-06-13)

- **Claude API — через OpenRouter (2026-07-01, разворот с прямого Anthropic).**
  Прод-сервер — Yandex Cloud (РФ); прямой вызов `api.anthropic.com` с РФ-IP ненадёжен
  (часть запросов резалась). OpenRouter из РФ работает стабильно (проверено вживую
  юзером + live-тестом всех трёх моделей). В `litellm-config.yaml` все `claude-*`
  алиасы теперь `model: openrouter/anthropic/claude-<version>` (ключ
  `OPENROUTER_API_KEY`, НЕ `ANTHROPIC_API_KEY`) — id модели берётся из каталога
  OpenRouter (openrouter.ai/models), версия через **точку**, не дефис:
  `anthropic/claude-sonnet-4.6`, `anthropic/claude-opus-4.8`, `anthropic/claude-haiku-4.5`
  (сверено по факту на сайте OpenRouter). `claude-sonnet-4-5`/`claude-opus-4-7`
  (старые пинованные версии) — по аналогии той же конвенции, вживую НЕ сверялись
  (сеть на момент правки была недоступна) — если понадобятся, проверить точный id.
  Работают: `claude-sonnet`→Sonnet 4.6, `claude-opus`→**Opus 4.8**, `claude-haiku`→
  Haiku 4.5. **extended thinking (`reasoning_effort`) через OpenRouter работает
  без регрессии** — проверено (`reasoning_content` в ответе). **`OPENROUTER_API_KEY`
  нужно прописать в `paragraf-gateway/.env`** (и в docker-compose.yml пробросить в
  контейнер litellm — грабли: env-переменная в `.env` НЕ означает, что она попадёт
  в контейнер, у compose явный whitelist `environment:`, забытая строка = 401
  «No cookie auth credentials found» от OpenRouter при пустом ключе).
  `ANTHROPIC_API_KEY` оставлен в конфиге про запас (не обязателен, `:-` дефолт
  пустой) — на случай не-РФ деплоя с прямым доступом к Anthropic. Подписи ставок в
  `seed.ts` не менялись (Sonnet 4.6 / Opus 4.8 / Haiku 4.5) — биллинг видит те же
  имена моделей, провайдер под капотом сменился прозрачно. См. tpm/rpm-грабли выше
  (Operational notes) — актуальны независимо от провайдера (тот же LiteLLM-баг).
- **«Углублённое размышление» (extended thinking)** — `app/src/ourapp/deep-thinking/`.
  Бинарный тумблер «Углублённо» (иконка glasses) в композере: ВКЛ → для Claude
  (sonnet/opus) submit выставляет `variant="high"` → opencode переводит его в нативный
  thinking-бюджет Anthropic (~16000 ток.). Дефолт (ВЫКЛ) = БЕЗ thinking (проверено:
  ответ без `/v1/messages` thinking-блока). Шкала: `off(дефолт)→low→medium→high→max`.
  Для РФ-моделей no-op (`isReasoningModel` гейтит по `/^claude-(sonnet|opus)/`). Уровень
  `high` (политика) — меняется в `DEEP_THINKING_VARIANT` (store.ts) на `max`. **Грабли:**
  opencode шлёт thinking на нативный `/v1/messages` (НЕ `/chat/completions`, там нужен
  `reasoning_effort`). Селектор вариантов opencode прячется при ≤2 тирах (Opus 4.8 даёт
  high/max=2), поэтому свой тумблер выставляет variant программно.
- **Фантомные модели скрыты** — `HIDDEN_MODEL_ID_PATTERN = /fable/i` (`context/models.tsx`
  + `validModel` в local.tsx). opencode показывает Anthropic-модели из каталога models.dev
  (шире, чем наш шлюз). Claude Fable 5 там есть, но у Anthropic недоступна (прямой вызов:
  `404 "Claude Fable 5 is not available. Please use Opus 4.8"`) → выбор давал ошибку.
  Когда Fable выйдет и будет заведена в litellm-config.yaml — убрать из паттерна.

## Заголовки сессий + «Продолжить работу» (2026-06-09)

- **Убрали «TARGETWORK» из панели «Продолжить работу»** (`pages/home.tsx`): не передаём
  `subtitle: record.projectName` — для юриста/бухгалтера концепции «папки проекта» нет,
  это пережиток opencode (имя cwd сайдкара). Осталось только заголовок + время.
- **Заголовки сессий генерит ядро opencode** (агент `title`, `session/prompt.ts` →
  модель = `agent.title.model` ИЛИ `small_model` ИЛИ модель сессии; системный промпт —
  `agent/prompt/title.txt`, английский; юзер-инструкция «Generate a title…» захардкожена).
  Слабая модель (GigaChat Lite) давала мусор: «NDC ставка 2026 title», англ. заголовки.
  **Фикс БЕЗ пересборки ядра** — через конфиг (`agent.title` переопределяется,
  `ConfigAgent.Info` поддерживает `model`/`prompt`): в **глобальном**
  `~/.config/opencode/opencode.jsonc` задан `small_model: ourapp-ru/gigachat-pro` +
  `agent.title = { model: ourapp-ru/gigachat-pro, prompt: <жёсткий русский промпт> }`.
  Проверено: «Ставка НДС в 2026» → «НДС в 2026 году: актуальные ставки и изменения».
  small_model на РФ-модели полезен и для 152-ФЗ (summary/compaction тоже шлют контент).
  **Грабли:** cwd сайдкара = «TARGETWORK», поэтому активен ГЛОБАЛЬНЫЙ конфig, не
  `desktop/.opencode/`. Старые заголовки в БД не перегенерируются — только новые сессии.
  Конфиг читается на старте → нужен полный перезапуск десктопа.

## Кабинет менеджера — роли employee/manager (2026-09-11)

Разделение профилей: `users.role` (`employee` дефолт / `manager`) + `users.manager_id`
(кто завёл аккаунт). Миграция — `billing/drizzle/manual/2026-09-11-manager-role.sql`
(там же `ALTER TYPE credit_reason ADD VALUE 'manager_transfer'` — отдельно от
транзакции, иначе значение нельзя использовать).

- **Кто что может:** любой аккаунт стартует `employee` и НИЧЕМ не ограничен (сам
  платит, сам тратит). Кнопка «Стать менеджером» (Настройки → Роль) доступна только
  при `manager_id IS NULL` — созданный менеджером сотрудник менеджером стать не может
  (`canBecomeManager` в `/me`). Это единственное отличие «своего» сотрудника от
  самостоятельного, плюс его расход виден создателю.
- **Кредиты:** менеджер НЕ покупает напрямую на сотрудника. Он пополняет свой баланс
  обычным `/payments/topup`, а потом переводит (`POST /manager/team/:id/credits`).
  Перевод — `lib/manager.ts transferCredits()`: advisory-локи на обе подписки в
  порядке id (иначе deadlock на встречных переводах), FIFO-списание грантов источника,
  всё-или-ничего, грант получателю `reason='manager_transfer'` БЕЗ срока. Перевод
  НЕ пишет usage_event (иначе аналитика расхода завышалась бы на сумму переводов).
  Hardcap LiteLLM поднимаем только получателю; менеджеру не опускаем — это страховка,
  источник правды по балансу `credit_grants`.
- **Аналитика — только цифры/метаданные** (модель, сценарий, токены, кредиты, время)
  из `usage_events`. Тексты переписки живут в движке и менеджеру сознательно НЕ
  отдаются — движок в этой фиче не участвует вообще.
- **Грабли:** в сыром `db.execute(sql\`...\`)` нельзя алиасить таблицу, если фильтр
  строится drizzle-хелпером (`inArray` рендерит `"subscriptions"."id"` → при
  `FROM subscriptions s` Postgres даёт «invalid reference to FROM-clause entry»).
  И только `inArray`, не `= ANY(${ids}::uuid[])` — см. урок ТЗ-04/05/06 выше.
- UI: `/team` (`pages/team.tsx`), пункт «Команда» в шапке только для роли manager.

## Prod-харденинг (блокеры к проду)

- **LiteLLM пишет IP пользователя в spend-логи (152-ФЗ).** Проверено 2026-06-08:
  `LiteLLM_SpendLogs.messages/response/proxy_server_request` — пусто `{}` (текст
  промптов/ответов НЕ хранится ✅), `metadata` чисто-техническая, `user_api_key` —
  sha256-хэш. НО колонка `requester_ip_address` заполняется: в dev там `172.26.0.1`
  (внутренний IP Docker-bridge, безопасно), а в проде gateway на не-РФ VPS + десктоп
  ходит на него напрямую (`opencode.jsonc baseURL→:4000`) → запишется реальный
  публичный IP РФ-пользователя за рубежом. IP по 152-ФЗ = потенциальные ПДн.
  Варианты до прода: (а) отключить запись IP в LiteLLM; (б) прокси на РФ-стороне
  перед шлюзом; (в) маршрут к шлюзу через billing (РФ). Решить при настройке прод-инфры.
  **ИССЛЕДОВАНО 2026-06-14:** вариант (а) НЕ решается конфигом — в LiteLLM 1.85.1 нет
  гранулярного флага «не писать только `requester_ip_address`» (трекинг IP — enterprise-
  фича; `general_settings.disable_spend_logs:true` рубит spend-логи ЦЕЛИКОМ, а они нужны
  ETL для списания кредитов). Значит это **ИНФРА-задача, не код:** прод-шлюз за Cloudflare
  Tunnel / reverse-proxy — настроить так, чтобы прокси НЕ пробрасывал реальный клиентский
  IP в LiteLLM (не форвардить `X-Forwarded-For`/`CF-Connecting-IP`, или поставить РФ-прокси
  перед шлюзом, тогда LiteLLM видит IP прокси, а не РФ-юзера). Решается при поднятии
  прод-gateway, в коде репо менять нечего. Источник: docs.litellm.ai/docs/proxy/db_info.

- **PII-маскирование НЕ применяется к OpenRouter-моделям (152-ФЗ).** Добавлено 2026-06-27:
  в веб-пикер заведены иностранные модели через провайдер `openrouter` (GLM 5.2, DeepSeek —
  `engine/src/providers.ts`), но маскирование ПДн в рендерере завязано на modelID `/^claude-/`
  (PII-слой `web/packages/app/src/ourapp/pii/`). Значит на GLM/DeepSeek/прочие openrouter-модели
  текст с ПДн уходит за рубеж **без обезличивания** — для юр/бух-домена это нарушение. До прода:
  либо распространить маскирование на провайдер `openrouter`/все не-РФ модели (не только Claude),
  либо разрешать openrouter-модели только для нечувствительных задач, а чувствительные гнать
  через РФ-модели (GigaChat/YandexGPT — данные остаются в стране). Решить до прод-релиза.

## Typecheck status

**Все три наших пакета зелёные** (`bunx tsc --noEmit` = 0 ошибок): `billing`,
`doc-tools`, `app`. Держим зелёным — новая ошибка = её внёс твой change.

- `billing` — 0 (4 "possibly undefined" исправлены 2026-05-30: seed.ts, lib/auth.ts,
  lib/credits.ts, routes/credits.ts).
- `doc-tools` — 0 (2026-06-08: типизирован `mammoth.convertToMarkdown` через точный
  интерфейс в `parsers/docx.ts`; аннотированы `_ctx`/`execute(args)` в `plugin.ts`,
  т.к. типы `@opencode-ai/plugin` не резолвятся standalone из-за `@ts-expect-error`).
- `app` — 0 (2026-06-08). **Важно:** `src/custom-elements.d.ts` — это upstream-симлинк
  на `../../ui/src/custom-elements.d.ts`, который на Windows вырождается в текст-файл с
  путём → tsc падал TS1128 и **маскировал семантические ошибки во всём пакете**. Заменили
  на инлайн реального содержимого (держать в синхроне с ui-версией). Это вскрыло 3
  латентных бага, тоже починены:
  1. `prompt-input/submit.ts` `handleSubmit(event)` → `event?: Event` + `event?.preventDefault()`
     — авто-сабмит сценария звал `handleSubmit()` без event → **крашнулся бы** на preventDefault.
  2. `ourapp/billing-api.ts` — цепочка `&&/||` давала тип `{}`; переписана на тернарник (string).
  3. `ourapp/pii/ocr.ts` — ArrayBuffer оборачивался в `Uint8Array` (не входит в Tesseract
     `ImageLike`); теперь в `Blob`.
  NB: `tsc` при фатальной синтаксической ошибке в `.d.ts` пропускает семантику — если
  правишь .d.ts, перепроверь полный `tsc`, могут «всплыть» скрытые ошибки.

## gstack on Windows — known nuances

- **`gstack-learnings-log` writes silently and may not persist on Git Bash.** The
  shebang is `#!/usr/bin/env bash` but invocation via the bare path returns exit
  127 in some contexts; explicit `bash <path>` runs cleanly but the resulting file
  at `~/.gstack/projects/<slug>/learnings.jsonl` stays empty. Workaround for now:
  capture insights in `CLAUDE.md` (this file) under "Operational notes" — the
  next Claude Code session reads CLAUDE.md on startup so the knowledge survives.
- **Skill invocation via Skill tool** only works when the gstack skills show up
  in the current session's system-reminder list. On a freshly-restarted Claude
  Code in `D:\TEMKA`, skills like `/office-hours`, `/learn`, `/careful` etc.
  become available and can be invoked. Mid-session installs are NOT picked up
  until restart.
- **LiteLLM spend tracking for GigaChat:** LiteLLM's native gigachat provider
  ignores `model_info.input_cost_per_token` from config — pricing dict is hardcoded
  and empty for GigaChat. Workaround: compute spend on the Billing-сервис side
  using token counts from `usage_events`. The user-facing limit is "tasks/month"
  anyway, so USD spend on Gateway is internal accounting only.
- **Production NSIS installer build from RU network is flaky.** electron-builder
  invokes `app-builder.exe` which downloads `winCodeSign-2.6.0.7z`,
  `nsis-3.0.4.1.7z`, etc. from github.com (used by `rcedit` for editing exe
  metadata even without signing). On RU networks without stable VPN to github.com,
  these downloads can time out → installer fails.
  Workarounds:
    (a) Retry — often a transient network issue, succeeds on second attempt.
    (b) Pre-download archives while VPN is active and place into
        `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/` etc.
    (c) Ship installer build from CI (GitHub Actions has direct access — opencode's
        `signtoolOptions.sign` is gated on `GITHUB_ACTIONS=true` so it works there).
  **Confirmed working:** `bunx electron-builder --win` produces
  `dist/opencode-desktop-win-x64.exe` (~117 MB single-click installer).

- **Production splash hang fixed by patch in `loading.tsx`.** Upstream race
  condition: `init-step` listener removed before main process emits final
  `phase: 'done'` event → renderer never calls `loadingWindowComplete()`.
  Only triggers on fresh DBs (needsMigration=true, overlay shown). Patch:
  treat invoke-promise resolution as implicit 'done'. See commit `90cca7f` and
  PATCHES.md #3.
- **DEV-mode artifacts auto-hidden in production.** `import.meta.env.DEV &&`
  gate at `packages/app/src/pages/layout.tsx:2381,2535` hides `DebugBar` (FPS/JANK
  overlay) and the DEV badge in production builds. No fork patch needed.

## Прод-грабли деплоя (2026-09-12)

- **Новый роут billing надо добавить в Caddyfile.** У billing в `Caddyfile` не
  wildcard, а **явный список путей** (`@billing path /auth/* /me /limits /manager/* …`).
  Роут, которого там нет, уходит в SPA-fallback и отвечает 200 html / 405 вместо
  JSON — выглядит как «фича не задеплоилась». Так вышло с `/manager/*` у кабинета
  менеджера. Wildcard `/admin/*` ставить нельзя — он ломает SPA-страницы админки
  (см. историю с `/admin/click-analytics`). Проверка после деплоя:
  `curl -X POST https://isaac-ai.ru/<новый-роут>` → должен быть **401**, не 405/200.
- **git-зависимости пиньте на коммит, а не на ветку.** `ghostty-web` стоял как
  `github:anomalyco/ghostty-web#main` → любой коммит в upstream менял resolved-хэш,
  и CI падал на `bun install --frozen-lockfile` («lockfile had changes»). Дважды
  блокировало деплой. Теперь `#83c0a07`. Обновлять — осознанно: сменить ref +
  `bun install`, закоммитить `web/bun.lock` вместе с `package.json`.

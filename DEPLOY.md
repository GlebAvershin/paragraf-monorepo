# Isaak — деплой веб-версии (передача коллеге)

> Бренд: **Isaak** (домен https://isaac-ai.ru). Раньше было «Параграф».

> Статус кода: веб-миграция завершена и проверена e2e. typecheck зелёный во всех пакетах,
> тесты: app 388/388, doc-tools 10/10, PII 33/33; lint 0 errors; прод-сборка web собирается.
> Этот файл — что поднять и как связать на проде. Подробный контекст — в `CLAUDE.md`.

## 1. Из чего состоит система

| Компонент | Что это | Порт (dev) | Деплой |
|---|---|---|---|
| **web** (статика) | SolidJS-рендерер (`web/packages/app`) — сам сайт | 5173 (vite dev) | `vite build` → `dist/` на статик-хостинг/CDN |
| **engine** | Наш бэкенд чата (Hono), контракт opencode (`engine/`) | 4096 | Node/Bun-процесс |
| **billing** | Пользователи, OTP-вход, подписки, кредиты, платежи (`billing/`) | 3000 | Node/Bun-процесс |
| **gateway** | LiteLLM Proxy — абстракция Claude/GPT/GigaChat/Yandex | 4000 | Docker — **отдельный репо `paragraf-gateway`** (зарубеж) |
| **postgres × 3** | БД engine, billing, gateway(litellm) | 5434/5433/5432 | Managed Postgres ×3 (или 1 инстанс, 3 БД) |
| **SMTP** | Отправка OTP-кодов и платёжных писем | — | Транзакционный сервис (см. §6) |

Поток: **web** → (API чата) **engine** → **gateway** → провайдеры моделей; **web** →
(вход/кредиты/платежи) **billing**; **billing** ↔ **gateway** (sync ключей, ETL-списание).

**Репозитории (2 + ML-коллеги):**
- `paragraf-monorepo` (этот) — **РФ**: `web` (фронт, форк opencode → статика), `engine`, `billing`, `doc-tools`, `landing`, docs.
- `paragraf-gateway` — **зарубеж**: LiteLLM (вынесен из монорепо).
- (ML-коллега заводит свой репо отдельно — верификация ответов/аналитика, РФ.)
Локальный дев: `gateway` клонировать соседней папкой `../paragraf-gateway`; `up.ps1` это учитывает.

## 2. Сборка web (статика)

```bash
cd web/packages/app
PATH="…/.bun/bin:$PATH" bun run build      # → dist/
```
`dist/` — готовая статика (index.html + assets/ + `tessdata/` + `tesseract/` для OCR).
Залить на любой статик-хостинг (Cloudflare Pages / Netlify / nginx / S3+CDN).

**SPA-fallback:** все неизвестные пути отдавать на `index.html` (клиентский роутинг).

**MIME-типы (важно для OCR!):** хост ДОЛЖЕН отдавать:
- `/tesseract/*.wasm.js` → `text/javascript` (грузятся через `importScripts` в web-worker;
  при неверном MIME OCR падает целиком). `dist/_headers` покрывает `*.js`, но вложенные
  `*.wasm.js` нужно проверить — при необходимости добавить правило `/tesseract/*`.
- `*.wasm` → `application/wasm`.
- `/tessdata/*.traineddata.gz` — отдавать **как есть** (НЕ распаковывать на лету;
  Content-Encoding не навешивать поверх уже-gz).

## 3. Связка web → engine / billing (URL-и, CORS)

В проде рендерер берёт адреса так:
- **engine:** `location.origin` по умолчанию (ожидается reverse-proxy: статика + API движка
  на одном домене → без CORS). Иначе задать на этапе сборки **`VITE_OURAPP_ENGINE_URL`**
  (напр. `https://api.isaac-ai.ru`).
- **billing:** **`VITE_OURAPP_BILLING_URL`** — задать ОБЯЗАТЕЛЬНО (дефолт `127.0.0.1:3000`
  только для dev). Напр. `https://api.isaac-ai.ru` (если billing на том же домене — путём)
  или отдельный домен.

**Рекомендуемая топология (проще всего):** один домен `app.isaac-ai.ru` + reverse-proxy
(nginx/Caddy): `/` → статика `dist/`; `/session*`, `/global/*`, `/provider*`, `/config*`,
`/project*`, `/path`, `/agent`, `/app/*`, `/command`, `/mcp`, `/lsp`, `/vcs`, `/question`,
`/permission`, `/health/*` → **engine:4096**; пути billing (`/auth/*`, `/me`, `/limits`,
`/credits/*`, `/usage/*`, `/payments/*`, `/webhooks/*`, `/waitlist`) → **billing:3000**.
Тогда `VITE_OURAPP_ENGINE_URL`/`VITE_OURAPP_BILLING_URL` можно не задавать (same-origin).

Если домены разные — выставить оба env при сборке и разрешить CORS на engine/billing.

## 4. engine (env)

`engine/.env` (см. `engine/src/config.ts`):
| Переменная | Назначение |
|---|---|
| `JWT_SECRET` | **ДОЛЖЕН совпадать с billing** (движок верифицирует billing-JWT) |
| `JWT_ISSUER` / `JWT_AUDIENCE` | по умолчанию `billing.local` / `ourapp-desktop` — совпасть с billing |
| `DATABASE_URL` | Postgres движка |
| `GATEWAY_URL` | URL LiteLLM (gateway) |
| `BILLING_URL` | URL billing (движок дёргает `/me` за litellm-ключом) |
| `PORT` | 4096 |

Запуск: `cd engine && bun run start`. Схема таблиц создаётся при старте (`initSchema`).

## 5. billing (env)

`billing/.env` (см. `billing/.env.example`):
- `JWT_SECRET` (тот же, что у engine), `JWT_ISSUER`, `JWT_AUDIENCE`
- `DATABASE_URL` (Postgres billing)
- `LITELLM_BASE_URL` (gateway), `LITELLM_MASTER_KEY` (мастер-ключ LiteLLM)
- `SMTP_HOST/PORT/USER/PASSWORD/SMTP_FROM` — транзакционный SMTP (см. §6)
- `CLOUDPAYMENTS_PUBLIC_ID/API_SECRET/WEBHOOK_SECRET` — платежи (без них `/payments/*`
  отдают 503 — это корректная деградация, не баг)
- `APP_PUBLIC_URL` — публичный URL сайта (для писем), `MAGIC_LINK_TTL_MINUTES`, `PORT=3000`

Перед первым стартом применить миграции:
```bash
cd billing
bun run db:push       # схема из schema.ts
bun run db:seed       # тарифы + ставки моделей (model_rates)
# + ручные миграции: drizzle/manual/*.sql прогнать psql-ом по порядку
```
ETL-воркер (списание кредитов из spend-логов): `NODE_ENV=production bun run src/worker/etl.ts`
запускать периодически (cron) ИЛИ как постоянный цикл — иначе кредиты не списываются.

### Создание кабинетов (allowlist — вход только заранее заведённым)
Самозапись закрыта: вход по OTP работает ТОЛЬКО для существующих active-юзеров
(см. CLAUDE.md «Вход — ТОЛЬКО по allowlist»). Первым клиентам кабинеты заводим
вручную (нужен поднятый LiteLLM-шлюз — скрипт создаёт виртуальный ключ):
```bash
cd billing
NODE_ENV=production bun run create-user client@zavod.ru "Имя Фамилия"
```
Дальше клиент заходит на сайт, вводит этот email → приходит OTP-код → внутри.
Скрипт идемпотентен (повторный запуск не дублирует, дозаводит подписку если её нет).

## 6. gateway (LiteLLM) + ключи провайдеров

**Отдельный репозиторий:** `github.com/GlebAvershin/paragraf-gateway`. Прод — **Yandex Cloud**
(один сервер, РФ; см. CLAUDE.md — весь стек, включая gateway, теперь на РФ-хостинге).
Docker Compose в корне. Нужны (в `.env` / `litellm-config.yaml`):
- **`OPENROUTER_API_KEY`** — Claude (Opus 4.8 / Sonnet 4.6 / Haiku 4.5) идут через
  **OpenRouter**, не напрямую в Anthropic — прямой вызов `api.anthropic.com` с РФ-IP
  ненадёжен, OpenRouter стабилен (проверено). **Уже работает.** `ANTHROPIC_API_KEY`
  не обязателен (оставлен про запас в конфиге). **Грабли:** ключ в `.env` не значит,
  что он попадёт в контейнер — в `docker-compose.yml` явный whitelist `environment:`
  для сервиса litellm, забытая строка = 401 от OpenRouter при пустом ключе. После
  правки `.env` — `docker compose up -d --force-recreate litellm`.
- **GigaChat** (Sber) — `GIGACHAT_*` креды. **Нужно завести** (в dev не было → короткий запрос
  в авто-режиме падал). Модели РФ-хостинга — важно для 152-ФЗ.
- **YandexGPT** — `YANDEX_API_KEY` / `YANDEX_FOLDER_ID`. Опционально.
- Мастер-ключ LiteLLM (тот же в billing `LITELLM_MASTER_KEY`).
- Версия LiteLLM запиннена дайджестом (см. CLAUDE.md — НЕ ставить tpm/rpm на ключи без
  перепроверки бага 1.85.1).

При добавлении/переименовании модели править 4 места (см. CLAUDE.md: litellm-config.yaml,
billing/seed.ts, allowed-models тарифов/ключей, провайдер `ourapp-ru` в конфиге).

**gateway-app (app-слой :4100) — общий секрет.** Ручка `/answer` наружу НЕ выставляется
(только движок ходит на неё изнутри). Дополнительно — секрет `GATEWAY_API_SECRET`: движок
шлёт его заголовком `X-Internal-Key`, шлюз middleware принимает только запросы с ним
(health-ручки открыты для liveness). Секрет ДОЛЖЕН побайтово совпадать в двух местах:
`paragraf-gateway/app/.env` и `engine/.env` (одно имя `GATEWAY_API_SECRET`). Сгенерировать:
`bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"))'`.
Пусто с обеих сторон → проверка отключена (только dev; в проде задать обязательно).

## 7. 152-ФЗ (юр./бух. данные)

- **ПДн маскируются на клиенте** (в браузере) ДО отправки: на сервер/в зарубежные модели
  уходит обезличенный текст. Сканы распознаются локально (Tesseract) — картинка не уходит.
  Это уже реализовано и проверено. Демаск-словарь хранится в localStorage браузера юзера.
- РФ-данные направлять в РФ-модели (GigaChat) — для них маскирование авто-выключается.
- **Gateway за рубежом + IP пользователя:** LiteLLM пишет `requester_ip_address` в spend-логи.
  Настроить прод-прокси так, чтобы реальный IP РФ-юзера НЕ доходил до LiteLLM (не форвардить
  `X-Forwarded-For`/`CF-Connecting-IP`, либо РФ-прокси перед шлюзом). Детали — CLAUDE.md
  «Prod-харденинг».

## 8. SMTP (OTP-вход)

Вход — только по OTP-коду на email. Без SMTP код печатается в консоль billing (только dev).
Прод — транзакционный сервис. Рекомендация (РФ-инфра, 152-ФЗ): **Yandex Cloud Postbox**
(2000 писем/мес бесплатно). Альтернативы: Mailopost / SMTP.bz / Unisender Go. Заполнить
`SMTP_*` в billing/.env. NB: код отправки проверен живьём (Mailpit).

## 9. Смоук-тест после деплоя

1. Открыть сайт → онбординг (выбор профессии) → ввести email → прийти OTP → войти.
2. «Начать новую задачу» → отправить вопрос → ответ стримится.
3. Запустить сценарий (напр. «Составить договор») → документ генерится → кнопки DOCX/PDF/MD.
4. Прикрепить картинку-скан → проверить, что текст распознался (OCR) и ушёл текстом.
5. Открыть `/credits`, `/analytics`, `/history`, `/settings`, `/help` — рендерятся.
6. Health: `engine /health/readiness`, `billing /health/readiness`, `gateway /health/liveliness` → 200.

## 10. Что ещё (опционально, не блокеры веба)

- Удаление Electron-оболочки (`web/packages/desktop`) — веб не зависит от неё; чистка на потом.
- Лендинг — отдельный Astro-проект `landing/` (своя сборка/деплой).
- Прод NSIS-инсталлер десктопа — не нужен для веба.

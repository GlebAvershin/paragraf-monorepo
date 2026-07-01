# Isaac — деплой прод-стека (YC-сервер)

> Бренд: **Isaac** (домен https://isaac-ai.ru). Раньше было «Параграф», затем
> опечатка «Isaak» — исправлено 2026-07-02. Внутренние инфра-идентификаторы
> (директория `/opt/isaak`, docker-сеть `isaak_shared`, имена контейнеров
> `isaak_*`) НАМЕРЕННО оставлены как есть — это невидимая пользователю
> внутренняя маркировка, переименование потребовало бы миграции с простоем
> (новая директория на сервере, пересоздание сети, обновление всех compose-
> файлов и workflow) ради чисто косметического выигрыша. При случае можно
> сделать отдельной задачей.

> **Статус (2026-07-01): прод ЖИВОЙ.** https://isaac-ai.ru отвечает, полный e2e проверен
> вживую (OTP-логин → сессия → сообщение → реальный ответ Claude через OpenRouter). CI/CD
> настроен и активен (push в `main` → тесты → автодеплой на сервер по SSH). typecheck зелёный
> во всех 5 пакетов, известные CVE пропатчены, auth/CORS/gateway-секрет — security-аудит
> пройден (см. CLAUDE.md). Подробный контекст решений — в `CLAUDE.md`.

## 1. Из чего состоит система

**АРХИТЕКТУРА (2026-07-01): весь стек — на ОДНОМ YC-сервере** (РФ). Два независимых
git-репозитория деплоятся туда СВОИМИ пайплайнами, в соседние каталоги:

| Компонент | Что это | Порт | Публично? |
|---|---|---|---|
| **web** (статика) | SolidJS-рендерер (`web/packages/app`) | — (файлы) | да, через Caddy |
| **engine** | Бэкенд чата (Hono), контракт opencode (`engine/`) | 4096 | да, через Caddy (path-based) |
| **billing** | Юзеры, OTP-вход, подписки, кредиты, платежи (`billing/`) | 3000 | да, через Caddy (path-based) |
| **gateway-app** | Маскирование/auto-model/OCR/ML-гейт перед LiteLLM (`paragraf-gateway/app`) | 4100 | **нет** — loopback-only |
| **litellm** | Proxy-абстракция Claude(via OpenRouter)/GigaChat/YandexGPT | 4000 | **нет** — loopback-only |
| **postgres × 3** | Отдельные БД: billing, engine, litellm | 5432/5433/5434 | нет, внутри docker-сети |
| **SMTP** | OTP-коды и платёжные письма | — | внешний транзакционный сервис |

Поток: браузер → **Caddy** (один домен) → статика | **engine** (`/session*` и т.п.) |
**billing** (`/auth/*`, `/me`, `/payments/*` и т.п.) → **engine**/**billing** ходят к
**gateway-app**/**litellm** через общую внешнюю docker-сеть `isaak_shared` (по имени
контейнера, `http://gateway-app:4100`/`http://litellm:4000`) — **не через
host.docker.internal**: на Linux порт, опубликованный как `127.0.0.1:PORT` на хосте,
недоступен из контейнера через host-gateway route (соединение идёт с IP docker-бриджа,
не с 127.0.0.1) — поймано на первом реальном деплое, см. §6.

**Почему 3 отдельных Postgres, а не 1 инстанс с 3 БД:** репозитории (monorepo и gateway)
деплоятся независимо разными пайплайнами — общее владение одной БД между ними усложнило бы
миграции/рестарты без явной выгоды (сервер свой, не managed-DB-as-a-service — лишний
контейнер Postgres ничего не стоит).

**Репозитории:**
- `paragraf-monorepo` (этот) — `web`, `engine`, `billing`, `doc-tools`, `landing`, docs.
  Деплой → `/opt/isaak` на сервере.
- `paragraf-gateway` — LiteLLM + gateway-app (маскирование/auto-model/OCR/ML).
  Деплой → `/opt/gateway` на ТОМ ЖЕ сервере. Здесь же работает ML-коллега.
- Локальный дев: `paragraf-gateway` клонировать соседней папкой `../paragraf-gateway`;
  `up.ps1`/`Makefile` это учитывают.

## 2. CI/CD

**CI** (`.github/workflows/ci.yml` в каждом репо) — typecheck + тесты на каждый push/PR
в `main`: billing, engine (только typecheck — юнит-тестов пока нет), doc-tools, web/app
(monorepo); app (gateway). Ветки `prod` нет — деплоим прямо с `main`.

**CD** (`.github/workflows/deploy.yml` в каждом репо) — триггерится `workflow_run` после
зелёного CI (гейт: деплой не стартует, если тесты не прошли). SSH на сервер → свой
`scripts/deploy.sh` (git pull → docker build → up -d --force-recreate → миграции/health-check).
**Секреты настроены и активны** (GitHub → Settings → Secrets and variables → Actions, оба
репо): `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KEY` (+ `APP_DOMAIN` только в monorepo — для
smoke-check). `DEPLOY_KEY` — отдельный ключ, сгенерированный специально для CI (не тот, что
используется для ручного SSH-администрирования) — можно ротировать/отозвать независимо.

**Локальная проверка синтаксиса** (без доступа к серверу):
```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod config   # синтаксис
docker compose -f docker-compose.prod.yml --env-file .env.prod build    # реальная сборка образов
```

## 3. Первый деплой на сервер (уже сделан, для справки/повторного разворота)

```bash
# на сервере:
mkdir -p /opt/isaak /opt/gateway
docker network create isaak_shared   # общая сеть между двумя стеками, см. §1/§6
git clone https://github.com/GlebAvershin/paragraf-monorepo /opt/isaak
git clone https://github.com/GlebAvershin/paragraf-gateway /opt/gateway

# gateway — сначала (движок его использует)
cd /opt/gateway
cp .env.prod.example .env.prod   # заполнить (см. §6)
./scripts/deploy.sh

# monorepo
cd /opt/isaak
cp .env.prod.example .env.prod   # заполнить (см. §4-5); LITELLM_MASTER_KEY и
                                  # GATEWAY_API_SECRET ДОЛЖНЫ совпадать со значениями
                                  # из paragraf-gateway/.env.prod
./scripts/deploy.sh

# billing — первичная инициализация схемы (ТОЛЬКО при первом разворачивании,
# на пустой БД; scripts/migrate-prod.sh рассчитан на УЖЕ существующую схему,
# db:push/db:seed нужно прогнать руками один раз):
docker compose -f docker-compose.prod.yml --env-file .env.prod exec billing bunx drizzle-kit push --force
docker compose -f docker-compose.prod.yml --env-file .env.prod exec billing bun run db:seed
```
Дальше — обычный push в `main` → CI → CD (см. §2, уже настроено и активно). Ручной прогон:
`workflow_dispatch` в GitHub Actions или `./scripts/deploy.sh` по SSH.

## 4. Сборка web (статика)

`scripts/build-static.sh` делает это автоматически (часть `deploy.sh`), вручную:
```bash
bun install --cwd web --frozen-lockfile
bun run --cwd web/packages/app build      # → web/packages/app/dist
```
Caddy отдаёт `dist/` напрямую (volume-mount в `docker-compose.prod.yml`), SPA-fallback
на `index.html` настроен в `Caddyfile`. **OCR/Tesseract больше НЕ в клиентском бандле**
(распознавание сканов ушло на сервер, в gateway-app, см. CLAUDE.md «РАЗВОРОТ АРХИТЕКТУРЫ») —
никаких особых MIME-правил для `*.wasm`/`tessdata` теперь не нужно.

## 5. engine + billing (env)

Единый `.env.prod` в корне монорепо (шаблон — `.env.prod.example`), читается
`docker-compose.prod.yml`. Ключевое:
- `JWT_SECRET`/`JWT_ISSUER`/`JWT_AUDIENCE` — одно значение и для engine, и для billing
  (billing выпускает JWT, engine только verify'ит).
- `LITELLM_BASE_URL`/`ANSWER_URL` — по умолчанию `http://litellm:4000`/`http://gateway-app:4100`
  (имена контейнеров через общую сеть `isaak_shared`, см. §1/§6 — НЕ `host.docker.internal`).
- `LITELLM_MASTER_KEY` и `GATEWAY_API_SECRET` — ДОЛЖНЫ побайтово совпадать со значениями
  в `paragraf-gateway/.env.prod` (см. §6). Несовпадение = 401 от gateway-app/litellm.
- `APP_DOMAIN`/`APP_PUBLIC_URL`, SMTP (§7), CloudPayments (без них `/payments/*` корректно
  отдают 503 — не баг), `BACKUP_S3_*` (§8).

Миграции billing применяются `scripts/migrate-prod.sh` (часть `deploy.sh`) — drizzle +
manual SQL + health-check. Engine схему создаёт сам при старте (`initSchema`,
`CREATE TABLE IF NOT EXISTS`) — отдельного шага не требует.

### Создание кабинетов (allowlist — вход только заранее заведённым)
Самозапись закрыта: вход по OTP работает ТОЛЬКО для существующих active-юзеров
(см. CLAUDE.md «Вход — ТОЛЬКО по allowlist»). Кабинеты первым клиентам заводим вручную:
```bash
docker compose -f docker-compose.prod.yml exec billing bun run create-user client@zavod.ru "Имя Фамилия"
```
Дальше клиент заходит на сайт, вводит этот email → приходит OTP-код → внутри. Идемпотентно.

## 6. gateway (LiteLLM + gateway-app) + ключи провайдеров

Отдельный репозиторий `paragraf-gateway`, деплоится на **ТОТ ЖЕ YC-сервер** (`/opt/gateway`),
свой `.env.prod` (шаблон — `paragraf-gateway/.env.prod.example`). **Публично не выставляется**
— litellm/gateway-app подключены к общей внешней docker-сети `isaak_shared`
(`docker network create isaak_shared`, создаётся идемпотентно в обоих `deploy.sh`),
engine/billing из монорепо-стека достают их по имени контейнера. Порты `127.0.0.1:4000`/
`127.0.0.1:4100` тоже открыты — удобно для health-check/отладки прямо с хоста, но НЕ основной
путь связи (host.docker.internal + loopback-порт между независимыми compose-стеками на Linux
не работает — соединение из контейнера идёт с IP docker-бриджа, хост его отклоняет).

- **`OPENROUTER_API_KEY`** — Claude (Opus 4.8 / Sonnet 4.6 / Haiku 4.5) идут через
  **OpenRouter**, не напрямую в Anthropic (прямой `api.anthropic.com` с РФ-IP ненадёжен,
  проверено). `ANTHROPIC_API_KEY` не обязателен (про запас). **Грабли:** ключ в `.env.prod`
  не значит, что попадёт в контейнер — `docker-compose.prod.yml` явно перечисляет
  `environment:` для litellm, забытая строка = 401 «No cookie auth credentials found».
- **`GATEWAY_API_SECRET`** — ДОЛЖЕН совпадать с тем же именем в `paragraf-monorepo/.env.prod`
  (движок шлёт заголовком `X-Internal-Key`, gateway-app проверяет). Сгенерировать:
  `bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"))'`.
- **`LITELLM_MASTER_KEY`** — ДОЛЖЕН совпадать с тем же именем в `paragraf-monorepo/.env.prod`.
- **GigaChat** (Sber) — `GIGACHAT_*` креды. Модели РФ-хостинга — важно для 152-ФЗ.
- **YandexGPT** — `YANDEX_API_KEY`/`YANDEX_FOLDER_ID`. Опционально.
- LiteLLM запиннен digest'ом (не floating-тегом) — см. CLAUDE.md, tpm/rpm-баг v3
  rate-лимитера. НЕ ставить tpm/rpm на виртуальные ключи без перепроверки на новом digest.

При добавлении/переименовании модели править 4 места (см. CLAUDE.md: litellm-config.yaml,
billing/seed.ts, allowed-models тарифов/ключей, провайдер `ourapp-ru` в конфиге).

## 7. 152-ФЗ (юр./бух. данные, ПДн)

**Маскирование и OCR — server-side, в gateway-app (РФ)**, не в браузере (было наоборот
до разворота архитектуры 2026-06-27 — если видите старые заметки про клиентский
Tesseract/localStorage-vault, это устарело). Поток: браузер шлёт СЫРОЙ текст +
картинки-сканы → engine (хранит сырым, РФ) → gateway-app маскирует ДО вызова модели →
модель → демаск → обратно. За границу (к OpenRouter) уходит только уже обезличенный текст.
РФ-модели (GigaChat/YandexGPT) — маскирование авто-выключается (данные и так не покидают РФ).

**ПДн в БД (РФ):** и billing (email/платежи), и engine (сырая история чатов) хранят ПДн.
Требование к проду: **шифрование БД at-rest** — не настроено на уровне docker-compose,
делается на уровне диска/managed-снапшотов YC при первом деплое.

## 8. SMTP + бэкапы

**SMTP** — вход только по OTP-коду на email. Без SMTP код печатается в консоль billing
(только dev). Прод — **Yandex Cloud Postbox** (РФ-инфра, 2000 писем/мес бесплатно; НЕ личная
Яндекс.Почта — её бесплатный SMTP отключают 29.06.2026). Настройка — см. `.env.prod.example`.

**Бэкапы** — `scripts/backup.sh` (monorepo: billing+engine БД) и `paragraf-gateway/scripts/backup.sh`
(litellm БД), из cron ежедневно. billing/engine — ТОЛЬКО РФ-S3 (Selectel/Yandex Object
Storage, 152-ФЗ). Ретеншн 30 дней локально + S3 по политике.

## 9. Смоук-тест после деплоя

**Пройден вживую 2026-07-01** на https://isaac-ai.ru (пп. 1-3, 6 — полностью; SMTP не
настроен, OTP-код доставался из логов billing).

1. `https://<домен>/health/liveliness` → `alive` (проверяет engine через Caddy).
2. Открыть сайт → онбординг → ввести email заранее заведённого юзера → прийти OTP → войти.
3. «Начать новую задачу» → отправить вопрос → ответ стримится (проверяет весь путь
   web→engine→gateway-app→litellm→OpenRouter→обратно).
4. Прикрепить картинку-скан → текст распознаётся (server-side OCR в gateway) и уходит текстом.
5. Открыть `/credits`, `/analytics`, `/history`, `/settings`, `/help` — рендерятся.
6. `docker compose -f docker-compose.prod.yml ps` (monorepo) и (gateway) — все `healthy`.

## 10. Что ещё (опционально, не блокеры)

- YC Lockbox для секретов вместо файла `.env.prod` — заготовка `scripts/env-from-yc-lockbox.sh`
  написана, но **не проверена живьём** (нет доступа к YC на момент написания). Прогнать
  вручную и свериться построчно перед первым реальным использованием.
- Удаление Electron-оболочки (`web/packages/desktop`) — веб не зависит от неё, продукт —
  сайт, не приложение (см. CLAUDE.md).
- `landing/` — отдельный Astro-проект, не входит в прод-пайплайн (см. CLAUDE.md — оставлен
  по просьбе, публично не деплоится, онбординг самого сайта играет его роль).
- Rate-limit на `/auth/magic-link` и `/waitlist` — сейчас отсутствует (найдено при
  security-аудите). Невысокий риск при ручном allowlist-провижининге узкого круга юзеров,
  но стоит решить перед публичным открытием регистрации.

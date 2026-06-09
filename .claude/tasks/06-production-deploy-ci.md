# ТЗ-06: Production-инфраструктура и CI/CD

**Размер:** L (3-4 недели)
**Приоритет:** 🟠 Без этого нельзя выпустить продукт в прод даже для пилота

---

## 1. Контекст и зачем

Сейчас весь стек работает **только локально** на dev-машине:
- Gateway (LiteLLM) — Docker на localhost:4000
- Billing — bun-процесс на localhost:3000, Postgres в Docker
- Desktop — electron-vite dev

Для пилота с дизайн-партнёрами и публичного релиза нужно:
- **Gateway задеплоить за рубежом** (план §9.1 — Claude/GPT недоступны из РФ напрямую)
- **Billing задеплоить в РФ** (152-ФЗ — ПДн хранятся в РФ)
- **CI/CD** для сборки и подписи desktop-инсталляторов
- **Мониторинг, бэкапы, секреты, TLS**

Это **devops-задача**, критична для запуска. Архитектура двух юрисдикций (план §5).

## 2. Объём

**В скоупе:**
- **Gateway prod**: Docker Compose для зарубежного VPS (Hetzner/etc), LiteLLM + Postgres
  + Caddy (TLS), резервные домены, секреты
- **Billing prod**: Docker Compose для РФ-VPS (Selectel/Yandex Cloud), Hono + Postgres
  + Redis + Caddy, бэкапы БД
- **CI/CD (GitHub Actions)**:
  - Lint + typecheck + test на каждый PR (billing, doc-tools, desktop)
  - Сборка desktop-инсталляторов (Win/Mac/Linux) на тег
  - Code signing (Windows) + notarization (macOS) — gated, как в opencode
  - Авто-деплой billing/gateway на push в `prod` (через SSH/registry)
- **Секреты**: вынести все ключи в secret management (GH Secrets + .env на серверах,
  не в репо)
- **Мониторинг**: healthcheck-эндпоинты + uptime-мониторинг (UptimeRobot/healthchecks.io),
  логи (structured pino → файл/Loki), алерты
- **Бэкапы**: автоматический pg_dump billing БД (ПДн!) по расписанию, ретеншн
- **Auto-update desktop**: настроить electron-updater на наш release-сервер

**Не в скоупе:**
- Kubernetes / автоскейлинг — на старте VPS достаточно (план: Hetzner CX22)
- Multi-region — один зарубежный + один РФ
- Гео-балансировка доменов — резервные домены вручную, CDN опционально

## 3. Архитектура деплоя

```
┌─── ЗА РУБЕЖОМ (Hetzner/Казахстан/Армения) ──────────┐
│  gateway-vps                                          │
│   ├── Caddy (TLS, gateway.paragraf-llm.com)          │
│   ├── LiteLLM Proxy (:4000 internal)                 │
│   └── Postgres (virtual keys, spend)                 │
│   Backups: pg_dump → S3-совместимое хранилище        │
└──────────────────┬───────────────────────────────────┘
                   │ HTTPS (master key auth)
                   │ billing синхронизирует virtual keys
┌─── В РФ (Selectel/Yandex Cloud) ─────────────────────┐
│  billing-vps                                          │
│   ├── Caddy (TLS, api.paragraf.ru)                   │
│   ├── Billing (Hono, :3000 internal)                 │
│   ├── Postgres (users, subs, payments — ПДн в РФ!)   │
│   ├── Redis (idempotency, rate-limit counters)       │
│   └── recurrent-retry worker (cron)                  │
│   Backups: pg_dump → РФ S3 (ПДн не покидают РФ)      │
└───────────────────────────────────────────────────────┘

Desktop приложение (у пользователя):
   - ходит в api.paragraf.ru (billing) для /me, /limits, оплаты
   - ходит в gateway.paragraf-llm.com (LLM) с virtual key
   - auto-update с releases.paragraf.ru
```

## 4. Gateway prod (зарубежный VPS)

**Создать:**
- `gateway/docker-compose.prod.yml` — LiteLLM + Postgres + Caddy
- `gateway/Caddyfile` — TLS-терминация, reverse-proxy на LiteLLM, резервный домен
- `gateway/.env.prod.example` — шаблон секретов (ANTHROPIC_API_KEY, OPENAI_API_KEY,
  GIGACHAT_CREDENTIALS, LITELLM_MASTER_KEY, DATABASE_URL)
- `gateway/scripts/backup.sh` — pg_dump → S3, cron
- `gateway/scripts/deploy.sh` — pull + up -d --force-recreate

**Учесть:**
- LiteLLM master key — только на сервере, никогда в desktop
- Резервные домены: Caddy с несколькими доменами, на случай блокировки основного
- GigaChat: ssl_verify false (self-signed Сбера) — уже в config

## 5. Billing prod (РФ VPS)

**Создать:**
- `billing/docker-compose.prod.yml` — billing (собранный bun) + Postgres + Redis + Caddy
- `billing/Dockerfile` — multi-stage bun build (если нет)
- `billing/Caddyfile`
- `billing/.env.prod.example` — JWT_SECRET, DATABASE_URL, LITELLM_BASE_URL (gateway prod),
  LITELLM_MASTER_KEY, SMTP_*, CLOUDPAYMENTS_*, REDIS_URL
- `billing/scripts/backup.sh` — pg_dump ПДн → РФ S3, ежедневно, ретеншн 30 дней
- `billing/scripts/migrate-prod.sh` — применение миграций при деплое (УЧЕСТЬ урок
  из CLAUDE.md: миграции должны применяться явно!)
- Запуск recurrent-retry worker как отдельный контейнер/cron

**Учесть:**
- ПДн (users, payments) — только РФ-хостинг
- Бэкапы ПДн — тоже РФ
- Миграции — автоприменение в deploy-скрипте + verify health после

## 6. CI/CD (GitHub Actions)

**Создать `.github/workflows/`:**

### `ci.yml` (на каждый PR)
```yaml
- billing: bun install, bunx tsc --noEmit, bun test
- doc-tools: bun test
- desktop: typecheck, lint (если есть)
```

### `desktop-release.yml` (на тег `v*`)
```yaml
- matrix: windows / macos / linux
- bun install, build
- electron-builder --win/--mac/--linux
- Windows: code signing (если GITHUB_ACTIONS + cert secret)
- macOS: notarization (если creds)
- upload artifacts → GitHub Releases / releases.paragraf.ru
```
NB: opencode gates signing на `GITHUB_ACTIONS=true` — переиспользовать паттерн.
Production NSIS build с RU-сети флаки (см. CLAUDE.md) — поэтому сборка инсталляторов
ТОЛЬКО на CI, не локально.

### `deploy-billing.yml` / `deploy-gateway.yml` (на push в `prod`)
```yaml
- SSH на соответствующий VPS
- git pull / docker pull
- применить миграции (billing)
- docker compose up -d --force-recreate
- health-check, откат если 500
```

## 7. Секреты и конфиг

- Все ключи → **GitHub Secrets** (для CI) + `.env.prod` на серверах (gitignored)
- `.env.prod.example` в репо документирует схему (как текущий `.env.example`)
- Никогда не коммитить реальные ключи (CLAUDE.md правило)
- Ротация: LITELLM_MASTER_KEY, JWT_SECRET — документировать процедуру

## 8. Мониторинг и алерты

- Healthcheck-эндпоинты уже есть (`/health/liveliness`, `/health/readiness`)
- Внешний uptime-мониторинг (healthchecks.io / UptimeRobot) на оба домена
- Алерт в Telegram/email при падении
- Логи: pino structured → файл с ротацией, опц. → Loki/Grafana
- LiteLLM spend-алерты (Slack/email при превышении бюджета — уже в config)

## 9. Auto-update desktop

- electron-updater настроить на `releases.paragraf.ru` (или GitHub Releases)
- `desktop/packages/desktop/electron-builder.*` — publish config
- Проверить что splash/update-flow работает (см. CLAUDE.md — был баг с loading.tsx)

## 10. Файлы для создания

```
.github/workflows/ci.yml
.github/workflows/desktop-release.yml
.github/workflows/deploy-billing.yml
.github/workflows/deploy-gateway.yml
gateway/docker-compose.prod.yml
gateway/Caddyfile
gateway/.env.prod.example
gateway/scripts/{backup,deploy}.sh
billing/docker-compose.prod.yml
billing/Dockerfile
billing/Caddyfile
billing/.env.prod.example
billing/scripts/{backup,deploy,migrate-prod}.sh
docs/DEPLOY.md  ← runbook: как развернуть с нуля, как откатить, как ротировать секреты
```

## 11. Принимочные критерии

- [ ] `docker compose -f gateway/docker-compose.prod.yml up` поднимает gateway с TLS
- [ ] `docker compose -f billing/docker-compose.prod.yml up` поднимает billing с TLS + Redis
- [ ] CI прогоняет typecheck+test на PR, красит статус
- [ ] Тег `v0.1.0` собирает инсталляторы Win/Mac/Linux на CI
- [ ] Windows-инсталлятор подписан (если cert настроен), иначе собирается без подписи
- [ ] Деплой-воркфлоу применяет миграции billing и проверяет health
- [ ] Бэкап-скрипт делает pg_dump и кладёт в S3, восстановление проверено
- [ ] Uptime-мониторинг шлёт алерт при падении
- [ ] Desktop auto-update скачивает и ставит новую версию
- [ ] `docs/DEPLOY.md` — полный runbook, по нему можно развернуть с нуля

## 12. Подводные камни

- **Два юрлица / две юрисдикции** — gateway за рубежом, billing в РФ. Не перепутать
  где что хостить: ПДн (users/payments) строго РФ, LLM-ключи строго не-РФ.
- **Миграции в deploy** — главный урок из CLAUDE.md: миграция, не применённая к
  prod-БД, роняет эндпоинты в 500. Deploy-скрипт ОБЯЗАН применять миграции + verify.
- **RU-сеть и сборка инсталляторов** — `app-builder.exe` качает winCodeSign/nsis
  с github.com, на RU-сети флаки (CLAUDE.md). Поэтому сборка ТОЛЬКО на CI (GH Actions
  имеет прямой доступ).
- **Кириллица в подписи/метаданных exe** — проверить что productName «Параграф»
  корректно прописывается rcedit.
- **CloudPayments webhook** должен быть доступен из интернета (CloudPayments → billing).
  Caddy + публичный домain `api.paragraf.ru/webhooks/cloudpayments`. HMAC уже проверяется.
- **Блокировка домена Gateway** — план §9.2. Держать резервные домены, переключение
  в desktop-конфиге (baseURL configurable). Заложить механизм смены домена без
  пересборки приложения (remote config / fallback-список).
- **Бэкап ПДн не должен покидать РФ** — S3 только РФ-провайдер (Selectel/Yandex).
- **Секреты в CI** — desktop-сборка НЕ должна содержать master key или billing-секреты.
  Только публичные эндпоинты-URL. Проверить что в бандл не попадают серверные .env.
- **Postgres версии** — синхронизировать версию между dev (docker) и prod, иначе
  dump/restore несовместимы.

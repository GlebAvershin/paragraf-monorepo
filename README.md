# Параграф — РФ-бэкенд (paragraf-monorepo)

ИИ-агент для юристов и бухгалтеров (РФ/СНГ): веб-приложение + наш бэкенд. Этот репозиторий —
**РФ-часть**: чат-движок, биллинг, парсеры документов, лендинг. Зарубежная часть (LLM-шлюз) и
веб-рендерер — в отдельных репозиториях (см. карту ниже).

## Что внутри

| Папка | Что | Порт | Стек |
|---|---|---|---|
| `web/` | Веб-рендерер (форк opencode, SolidJS) — сам интерфейс; собирается в статику | 5173 | Bun + SolidJS + Vite |
| `engine/` | Чат-движок: auth, сессии/сообщения, проксирование к шлюзу, SSE | 4096 | Bun + Hono + Postgres |
| `billing/` | Пользователи, OTP-вход, подписки, кредиты, платежи, ETL-списание | 3000 | Bun + Hono + Drizzle + Postgres |
| `doc-tools/` | Парсеры PDF/DOCX/XLSX + генератор DOCX (pure-TS) | — | библиотека |
| `landing/` | Маркетинговый лендинг | 4321 | Astro |

## Карта репозиториев

| Репо | Роль | Сервер |
|---|---|---|
| **paragraf-monorepo** (этот) | web (фронт) + engine + billing + doc-tools + landing | РФ |
| **paragraf-gateway** | LiteLLM-шлюз (Claude/GPT/GigaChat/Yandex) | зарубеж |

> Раньше веб-рендерер жил в отдельном репо `glar` (форк opencode) — теперь он внутри
> монорепо в `web/` и от репозитория opencode больше не зависит (используем их код,
> но не тянем upstream). ML-коллега ведёт свой репо отдельно.

> 152-ФЗ: ПДн маскируются в браузере до отправки; РФ-данные → РФ-модели; зарубежные модели —
> через шлюз с обезличенным текстом. Детали и деплой — в [`DEPLOY.md`](DEPLOY.md).

## Запуск локально

Нужны: **docker**, **bun**, **make**, (curl, lsof).

```bash
# 1. Соседним клоном — зарубежный шлюз
git clone https://github.com/GlebAvershin/paragraf-gateway.git ../paragraf-gateway

# 2. .env (JWT_SECRET в billing и engine ДОЛЖНЫ совпадать; в шлюз — ANTHROPIC_API_KEY)
cp billing/.env.example billing/.env
cp engine/.env.example  engine/.env
cp ../paragraf-gateway/.env.example ../paragraf-gateway/.env

# 3. Поднять весь бэкенд одной командой
make up          # docker + миграции + billing/engine/ETL в фоне + health-check

# 4. Веб-рендерер (отдельный терминал)
make web
```

`make help` — все команды (`up`, `down`, `restart`, `logs`, `health`, `migrate`, `seed`,
`billing`/`engine`/`etl`/`web`, `typecheck`, `test`). OTP-коды входа в dev печатаются в логах
billing (`make logs`) или приходят в Mailpit (http://localhost:8025), если поднят.

> Windows: можно использовать `make` через git-bash/WSL, либо PowerShell-скрипты `up.ps1`/`down.ps1`.

## Документация
- [`DEPLOY.md`](DEPLOY.md) — гайд деплоя (компоненты, env, 152-ФЗ-топология, ключи, смоук-тест).
- `CLAUDE.md` — подробный контекст и операционные заметки для разработки.

# Billing Service

Управление пользователями, подписками и тарифами. Связывается с Gateway (LiteLLM) через Management API. Хранит ПДн (email, ФИО, история платежей) в РФ-юрисдикции для 152-ФЗ.

Архитектура и роль — см. раздел 14 общего плана (`hidden-purring-nest.md`).

## Стек

- **Bun** + **TypeScript** + **Hono** (тот же стек, что у opencode)
- **PostgreSQL 16** + **Drizzle ORM**
- **JWT** (`jose`) — сессии
- **nodemailer** — email magic-links
- **Zod** — runtime валидация

## Quick start (локально)

```bash
# 1. Скопировать env, сгенерировать JWT_SECRET и заполнить LITELLM_MASTER_KEY
cp .env.example .env
# Generate JWT_SECRET:
echo "JWT_SECRET=$(openssl rand -hex 64)" >> .env
# LITELLM_MASTER_KEY — взять из ../gateway/.env

# 2. Запустить локальный Postgres
docker compose up -d

# 3. Установить зависимости
bun install

# 4. Применить схему БД
bun run db:push

# 5. Засеять тарифы (free / start / pro / team)
bun run src/db/seed.ts

# 6. Запустить сервис
bun run dev
```

## Endpoints (Фаза 1)

| Метод | Путь | Зачем | Auth |
|---|---|---|---|
| POST | `/auth/magic-link` | Запросить ссылку на email | — |
| GET | `/auth/verify?token=...` | Обмен токена на session JWT (плюс автосоздание Free-подписки на первом входе) | — |
| GET | `/me` | Профиль + virtual_key для десктопа | Bearer JWT |
| GET | `/limits` | Расход и остаток (для сайдбара) | Bearer JWT |
| GET | `/subscriptions/current` | Текущая подписка | Bearer JWT |
| GET | `/health/liveliness` | Liveness probe | — |
| GET | `/health/readiness` | Readiness probe (включая БД) | — |

## Что НЕ делает (отложено)

- **CloudPayments** — Фаза 2 (рекуррент, webhooks, веб-кабинет).
- **Команды и seat'ы** — Фаза 3.
- **Дневной soft-cap** — Фаза 3 (по фидбэку пилота).
- **Шифрование `litellmKey` в БД** — Фаза 2 (на старте — фолбэк на RDS encryption-at-rest).

## Связь с другими репозиториями

- **Gateway** (`../gateway`) — Billing вызывает его Management API (`/key/generate`, `/update`, `/block`, `/info`).
- **Desktop fork (opencode)** — клиент Billing'a. После magic-link `/auth/verify` сохраняет JWT и `litellmKey` в `electron-store`, далее весь чат идёт мимо Billing'а напрямую в Gateway.

## Структура

```
src/
├── index.ts              # Hono entry, middleware, routes
├── config.ts             # Zod-валидированный env
├── db/
│   ├── schema.ts         # Drizzle: users, subscriptions, plans, payments, ...
│   ├── client.ts         # drizzle(postgres-js)
│   └── seed.ts           # начальные тарифы
├── litellm/
│   └── client.ts         # LiteLLM Management API client
├── lib/
│   ├── auth.ts           # JWT + magic-token хеш
│   ├── email.ts          # nodemailer (или console в dev)
│   ├── logger.ts         # pino + redact для секретов
│   └── middleware.ts     # requireSession
└── routes/
    ├── auth.ts           # magic-link, verify
    ├── me.ts             # GET /me
    ├── limits.ts         # GET /limits
    ├── subscriptions.ts  # GET /subscriptions/current + initSubscription helper
    └── health.ts         # /health/liveliness, /health/readiness
```

## Типовой поток первого входа (Фаза 1)

```
1. Desktop:  POST /auth/magic-link { email: "user@example.com" }
             ← 204
   Billing:  inserts magic_link_tokens, отправляет email со ссылкой
             /auth/verify?token=<raw>

2. Юзер кликает по ссылке.
   Browser:  GET /auth/verify?token=<raw>
             → Billing проверяет, помечает consumed, upsert user
                                  → initSubscription(user.id)
                                       → INSERT subscription (Free)
                                       → litellm.createKey({ max_budget: $2, models: [...] })
                                       → UPDATE subscription SET litellm_key = sk-...
                                  ← возвращает { token: <JWT>, user: {...} }

3. Desktop:  GET /me
             Authorization: Bearer <JWT>
             ← { user, subscription, plan, gateway.baseUrl }
   Сохраняет litellmKey + gateway.baseUrl в electron-store.

4. opencode internals:
   В провайдере anthropic.ts:
     configure({ baseURL: gateway.baseUrl, apiKey: subscription.litellmKey })
   Чат работает.

5. Sidebar обновляется каждые 60 сек:
   Desktop:  GET /limits → { tasks: { used: 12, total: 15 } }
```

## Производственные TODO (перед Фазой 2)

- [ ] Шифрование `litellmKey` и `cloudpaymentsToken` (pgcrypto + KMS).
- [ ] Rate-limit на `/auth/magic-link` (по email, по IP).
- [ ] Очередь повторов для `initSubscription` если LiteLLM упал.
- [ ] HTML-шаблон magic-link email (сейчас plain text).
- [ ] Health-check для LiteLLM в `/readiness`.
- [ ] Метрики (prometheus exporter).

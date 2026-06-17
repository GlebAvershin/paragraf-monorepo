# OurApp — рабочее пространство проекта

Это контейнерная папка с тремя независимыми репозиториями. Цель проекта, бизнес-контекст и архитектурные решения — в `~/.claude/plans/hidden-purring-nest.md`.

## Репозитории

| Папка | Назначение | Где деплоится |
|---|---|---|
| `opencode/` | Клон апстрима `anomalyco/opencode`. **Не модифицируем напрямую** — будем форкать на GitHub. Сейчас используется только для разведки кода. | — |
| `gateway/` | LiteLLM Proxy с конфигом наших провайдеров (Claude, GPT, GigaChat) + Postgres. Один Docker Compose. | Фаза 1: локально. Фаза 2: VPS вне РФ |
| `billing/` | Bun + Hono + Drizzle + Postgres. Управление пользователями, подписками, тарифами, синхронизация с Gateway через Management API. | Фаза 1: локально. Фаза 2: VPS в РФ (152-ФЗ) |
| `doc-tools/` | Парсеры PDF/DOCX/XLSX + генератор DOCX. Pure JS, юнит-тесты. Переедет в форк opencode как плагин агента. | n/a — workspace package |

Десктоп-приложение (форк opencode) — четвёртый репозиторий, появится после git-fork на GitHub.

> **Текущее решение: local-first.** Всю Фазу 1 запускаем на ноутбуке разработчика + личный VPN. Платный хостинг — только когда дойдём до закрытого пилота с реальными юристами/бухгалтерами.

## Порядок запуска для smoke-теста Фазы 1

```
1. Поднять Gateway (см. gateway/README.md):
   cd gateway
   cp .env.example .env  # заполнить ANTHROPIC_API_KEY + сгенерировать секреты
   docker compose up -d
   ./scripts/create-test-key.sh   # для прямого ручного теста

2. Поднять Billing (см. billing/README.md):
   cd ../billing
   docker compose up -d           # local Postgres
   cp .env.example .env           # заполнить JWT_SECRET, LITELLM_MASTER_KEY
   bun install
   bun run db:push
   bun run src/db/seed.ts         # засеять тарифы
   bun run dev

3. End-to-end проверка (curl или Postman). Вход — passwordless OTP (6-значный код):
   # запросить код (всегда отвечает 204, чтобы не палить, какие email существуют)
   curl -X POST http://localhost:3000/auth/magic-link \
        -H 'Content-Type: application/json' \
        -d '{"email": "test@example.com"}'

   # SMTP в dev не настроен → код печатается в КОНСОЛЬ billing'а строкой
   #   "Код для входа: NNN NNN" (см. лог процесса billing).
   # Обменять email + код (без пробела) на JWT:
   curl -X POST http://localhost:3000/auth/verify-otp \
        -H 'Content-Type: application/json' \
        -d '{"email": "test@example.com", "code": "123456"}'
   # → { token: <JWT>, user: {...} }

   # /me — профиль; litellm-ключ лежит в subscription.litellmKey
   curl http://localhost:3000/me -H "Authorization: Bearer <JWT>"

   # /limits — баланс кредитов (credits.remaining / credits.monthlyTotal),
   #           тариф, статус подписки. Это НЕ «задачи» — биллинг кредитный.
   curl http://localhost:3000/limits -H "Authorization: Bearer <JWT>"

   # реальный запрос к Claude через Gateway с этим ключом
   #   (claude-sonnet → Sonnet 4.6, claude-opus → Opus 4.8).
   #   ВАЖНО: на Windows Git Bash инлайновый -d '{...}' с КИРИЛЛИЦЕЙ бьёт UTF-8
   #   → LiteLLM видит model=None / 400. Шлите тело из файла:
   printf '%s' '{"model":"claude-sonnet","max_tokens":50,"messages":[{"role":"user","content":"Привет"}]}' > payload.json
   curl -X POST http://localhost:4000/v1/chat/completions \
        -H "Authorization: Bearer <litellmKey>" \
        -H "Content-Type: application/json" \
        --data-binary @payload.json
   # (для нативного Anthropic-пути замените URL на /v1/messages и добавьте
   #  -H "anthropic-version: 2023-06-01" + x-api-key вместо Bearer)

   # запустить ETL-воркер (списывает кредиты из spend-логов LiteLLM) —
   #   без него баланс не уменьшится:
   #   cd billing && NODE_ENV=production bun run src/worker/etl.ts
   # снова /limits — credits.remaining уменьшился
```

> **Совет:** вместо ручного подъёма всех четырёх компонентов используйте
> `D:\TEMKA\up.ps1` — он поднимает оба Postgres, применяет миграции, стартует
> billing (коды OTP видны в его окне) и ETL-воркер. См. `CLAUDE.md`.
> Тестовый юзер уже есть в БД: `test@example.com` (Free, $2 budget).

Это и есть приёмочный сценарий Фазы 1 — нет десктопа, но вся серверная цепочка проверена.

## Smoke-test для doc-tools (независимо от Gateway/Billing)

```bash
cd doc-tools
bun install
bun test           # round-trip тесты (без внешних фикстур)
# Опционально: положите реальный договор в test/fixtures/sample-contract.pdf,
# тесты подхватят его и проверят PDF-парсер на нём.
```

## Dev-tooling: gstack (Garry Tan)

В `/d/TEMKA/.claude/skills/` установлен gstack в project-local режиме (51 скил для управления разработкой: `/careful`, `/investigate`, `/review`, `/plan-ceo-review`, `/context-save` и др.). Это **для нас, разработчиков** — не для конечных пользователей продукта.

Re-install после `git pull` upstream:
```bash
cd /d/TEMKA/.claude/skills/gstack && bash ./setup --local
```

Список всех скилов с описаниями — см. `CLAUDE.md` в корне проекта.

## Следующие шаги

- Сделать git-fork `anomalyco/opencode` на GitHub.
- В форке: правка конфига провайдеров на наш Gateway, ребрендинг, `ru.ts`, переезд `doc-tools` в `packages/doc-tools/`.
- Юридический трек (юрлица, аккаунты) — фоном.

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

3. End-to-end проверка (curl или Postman):
   # запросить magic-link (увидеть в логах billing'а)
   curl -X POST http://localhost:3000/auth/magic-link \
        -H 'Content-Type: application/json' \
        -d '{"email": "test@example.com"}'

   # из лога взять token, обменять на JWT
   curl 'http://localhost:3000/auth/verify?token=<TOKEN>'
   # → { token: <JWT>, user: {...} }

   # /me — получить litellm_key
   curl http://localhost:3000/me -H "Authorization: Bearer <JWT>"

   # /limits — увидеть расход 0 / 15 задач
   curl http://localhost:3000/limits -H "Authorization: Bearer <JWT>"

   # реальный запрос к Claude через Gateway с этим ключом
   curl -X POST http://localhost:4000/v1/messages \
        -H "x-api-key: <litellm_key>" \
        -H "anthropic-version: 2023-06-01" \
        -H "Content-Type: application/json" \
        -d '{"model": "claude-sonnet", "max_tokens": 50, "messages": [{"role":"user","content":"Привет"}]}'

   # снова /limits — увидеть, что расход обновился
```

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

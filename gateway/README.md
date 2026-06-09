# Gateway

LiteLLM Proxy с провайдерами Claude / OpenAI / GigaChat, virtual-keys per-пользователь, бюджеты и spend-tracking. Деплоится одной командой `docker compose up -d`.

Подробная архитектура и роль в общей системе — см. раздел 5 и 14 общего плана (`hidden-purring-nest.md`).

## Архитектура одной картинкой

```
[Desktop app в РФ]  ──HTTPS──▶  [Cloudflare/Edge]  ──▶  [VPS Hetzner: docker compose]
                                                          ├── litellm  :4000
                                                          └── postgres :5432 (internal)
```

LiteLLM — единственная точка контакта с провайдерами. Master key — только у Billing-сервиса.
Каждый клиент получает свой `virtual_key` с месячным $-бюджетом, который Billing создаёт через Management API.

## Quick start (локально, для разработки)

```bash
# 1. Скопировать env и заполнить ключи (минимум ANTHROPIC_API_KEY).
cp .env.example .env
# отредактировать .env

# 2. Сгенерировать секреты (POSTGRES_PASSWORD, LITELLM_MASTER_KEY, LITELLM_SALT_KEY).
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32)"
echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 32)"
echo "LITELLM_SALT_KEY=$(openssl rand -hex 32)"
# скопировать значения в .env

# 3. Поднять.
docker compose up -d

# 4. Подождать ~30 сек, проверить здоровье.
curl -sS http://localhost:4000/health/liveliness

# 5. Создать тестовый virtual key.
./scripts/create-test-key.sh 5
# Сохранить возвращённый sk-... как VIRTUAL_KEY.

# 6. Smoke-test через Anthropic native /v1/messages.
VIRTUAL_KEY=sk-... ./scripts/smoke-test.sh
```

## Production deploy (Hetzner CX22)

```bash
# На свежей Ubuntu 24.04 LTS:

# 1. Базовая настройка системы.
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-v2 ufw jq

# 2. Firewall: только SSH и HTTPS (через Cloudflare Tunnel).
sudo ufw allow 22/tcp
sudo ufw allow from <CLOUDFLARE_IPS> to any port 443
sudo ufw enable

# 3. Клонировать репо.
git clone <YOUR_GATEWAY_REPO_URL> /opt/gateway
cd /opt/gateway

# 4. Заполнить .env (см. Quick start выше).

# 5. Поднять.
sudo docker compose up -d
sudo docker compose ps  # all should be "healthy"

# 6. Cloudflare Tunnel (рекомендуется вместо открытия порта):
#    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
#    Маршрутизирует gateway.ourapp.com → localhost:4000.
```

## Endpoints

LiteLLM выставляет несколько совместимых протоколов:

| Endpoint | Протокол | Кому |
|---|---|---|
| `POST /v1/messages` | Anthropic Messages native | opencode при выборе Claude-моделей |
| `POST /v1/chat/completions` | OpenAI Chat Completions | opencode при выборе GPT / GigaChat |
| `POST /key/generate` | LiteLLM Management | Billing-сервис создаёт ключ при оплате |
| `POST /key/update`   | LiteLLM Management | Billing продлевает / меняет тариф |
| `POST /key/block`    | LiteLLM Management | Billing блокирует на просрочку |
| `GET  /key/info`     | LiteLLM Management | Billing отдаёт юзеру остаток лимита |
| `GET  /health/liveliness` | health check | мониторинг |

## Конфигурирование моделей

Все модели — в `litellm-config.yaml` под `model_list`. Чтобы добавить новую:

```yaml
- model_name: my-model        # имя для клиента
  litellm_params:
    model: provider/model-id  # формат LiteLLM
    api_key: os.environ/MY_PROVIDER_KEY
```

После правки конфига: `docker compose restart litellm`.

## Безопасность

- `LITELLM_MASTER_KEY` — даёт ПОЛНЫЙ доступ к API. Хранится только в env Billing-сервиса. Никогда не отдавайте клиенту.
- `VIRTUAL_KEY` (sk-...) — пользовательский ключ. Имеет бюджет и список разрешённых моделей. Безопасно хранить у клиента в `electron-store`.
- Postgres не доступен снаружи (только из docker network).
- Cloudflare WAF + rate-limit на edge.

## Мониторинг

- `GET /health/liveliness` — alive
- `GET /health/readiness` — ready (Postgres connected)
- Логи: `docker compose logs -f litellm`
- LiteLLM Admin UI (опционально): `--ui` флаг, доступ по master_key

## Что НЕ делает Gateway

- Регистрация пользователей, тарифы, оплаты, веб-кабинет — это **Billing-сервис** (отдельный проект).
- Документные тулзы — это **форк opencode** (legal-tools пакет).

## Troubleshooting

**LiteLLM не стартует** — проверить `docker compose logs litellm`. Чаще всего: неверный DATABASE_URL или отсутствует один из обязательных env.

**Запрос возвращает 401** — VIRTUAL_KEY невалиден или истёк. Создать новый через `create-test-key.sh`.

**Запрос возвращает 429** — превышен бюджет или RPM-лимит. Проверить через `GET /key/info?key=...`.

**GigaChat не работает** — проверить, что `GIGACHAT_CREDENTIALS` это base64(client_id:client_secret), а не сырые значения. И `ssl_verify: false` в конфиге.

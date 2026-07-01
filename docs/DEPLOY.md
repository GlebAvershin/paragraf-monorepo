# DEPLOY.md — runbook прод-деплоя Isaac (УСТАРЕЛ, 2026-05-30)

> ⚠️ **УСТАРЕЛО (2026-07-01).** Описывает старую топологию — 2 отдельных VPS
> (зарубежный gateway + РФ billing). После разворота архитектуры gateway тоже на
> РФ, весь стек (web+engine+billing+gateway) — на ОДНОМ YC-сервере, появились
> `docker-compose.prod.yml`/CI/CD-workflow'ы. **Актуальный раннбук — корневой
> [`/DEPLOY.md`](../DEPLOY.md).** Этот файл оставлен как исторический контекст
> (детали про S3-бэкапы/мониторинг/секьюрити-харденинг ниже местами всё ещё
> релевантны, но топология и команды — нет). Свериться с CLAUDE.md при сомнениях.

Полная инструкция от голого VPS до работающего пилота. Последняя ревизия: 2026-05-30.

## 1. Архитектура (одной картинкой)

```
┌─── Зарубежный VPS (Hetzner CX22 / Казахстан / Армения) ──┐
│  /opt/gateway                                              │
│   ├── Caddy (TLS, gateway.paragraf-llm.com)               │
│   ├── LiteLLM Proxy (Anthropic, OpenAI, GigaChat)         │
│   └── Postgres (virtual keys, spend logs)                  │
│  Бэкап: pg_dump → S3 (eu-central) ежедневно в 03:00       │
└────────────────────────┬───────────────────────────────────┘
                         │ HTTPS, Bearer master-key
┌─── РФ VPS (Selectel / Yandex Cloud, Москва) ──────────────┐
│  /opt/billing                                              │
│   ├── Caddy (TLS, api.paragraf.ru)                        │
│   ├── billing (Hono + Drizzle)                             │
│   ├── postgres (ПДн пользователей — РФ только!)           │
│   ├── redis (idempotency, rate-limit)                      │
│   ├── retry-worker, etl-worker                             │
│  Бэкап: pg_dump → РФ S3 (Selectel) ежедневно в 02:00      │
│  Webhook CloudPayments: api.paragraf.ru/webhooks/...      │
└────────────────────────────────────────────────────────────┘
```

Desktop-приложение у пользователя ходит на оба домена.

## 2. Первый деплой (с нуля)

### 2.1 Gateway (зарубежный VPS)

Нужен Ubuntu 24.04 LTS, 2 CPU / 4 GB / 40 GB.

```bash
# На свежем сервере
ssh root@<gateway-host>
adduser --disabled-password --gecos "" deploy
usermod -aG sudo,docker deploy
mkdir -p /opt/gateway && chown deploy:deploy /opt/gateway

# Базовый firewall
apt update && apt install -y ufw fail2ban
ufw default deny incoming
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Docker
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

```bash
# От пользователя deploy
sudo su - deploy
cd /opt/gateway
git clone <repo-url> .
git checkout prod   # деплой-ветка

# Заполнить .env.prod (см. .env.prod.example)
cp gateway/.env.prod.example .env.prod
$EDITOR .env.prod
# Сгенерировать секреты:
#   POSTGRES_PASSWORD=$(openssl rand -base64 32)
#   LITELLM_MASTER_KEY=sk-$(openssl rand -hex 32)
#   LITELLM_SALT_KEY=$(openssl rand -hex 32)

# Поднять
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# Health
curl https://gateway.paragraf-llm.com/health/liveliness
# → "I'm alive!"
```

DNS: A-запись `gateway.paragraf-llm.com` → IP gateway-VPS. Caddy сам выпустит Let's Encrypt сертификат при первом запросе.

### 2.2 Billing (РФ VPS)

Идентично gateway, но с РФ-провайдером. Хост: Selectel (Москва, `ru-7`) либо Yandex Cloud.

```bash
# На РФ-VPS
ssh root@<billing-host>
# ... те же шаги (deploy user, ufw, docker)

sudo su - deploy
cd /opt/billing
git clone <repo-url> .
git checkout prod
cd billing

cp .env.prod.example .env.prod
$EDITOR .env.prod
# LITELLM_BASE_URL=https://gateway.paragraf-llm.com
# LITELLM_MASTER_KEY=<тот же что на gateway-VPS!>

docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# Применить миграции (КРИТИЧНО — иначе 500 на /me, /limits)
./scripts/migrate-prod.sh
```

### 2.3 DNS и CloudPayments webhook

- `api.paragraf.ru` → IP billing-VPS
- В личном кабинете CloudPayments указать webhook: `https://api.paragraf.ru/webhooks/cloudpayments`
- Проверить HMAC-секрет совпадает с `CLOUDPAYMENTS_WEBHOOK_SECRET` в `.env.prod`

### 2.4 Бэкапы — cron

```bash
# На gateway-VPS
crontab -u deploy -e
# Добавить:
0 3 * * * cd /opt/gateway && ./scripts/backup.sh >> /var/log/gateway-backup.log 2>&1

# На billing-VPS
0 2 * * * cd /opt/billing && ./scripts/backup.sh >> /var/log/billing-backup.log 2>&1
```

### 2.5 Uptime-мониторинг

UptimeRobot (бесплатно) на:
- `https://gateway.paragraf-llm.com/health/liveliness` — каждые 5 минут
- `https://api.paragraf.ru/health/readiness` — каждые 5 минут

Алерт: Telegram/email при двух подряд failure (10 минут downtime).

## 3. Регулярный деплой (CI)

Push в ветку `prod` запускает GitHub Actions:
- Изменения в `billing/**` → `.github/workflows/deploy-billing.yml`
- Изменения в `gateway/**` → `.github/workflows/deploy-gateway.yml`

Workflow:
1. SSH на соответствующий VPS
2. `git pull && docker compose build && up -d --force-recreate`
3. Применение миграций (для billing)
4. Health-check

Откат: см. §5.

## 4. Desktop-релиз

Тег `vX.Y.Z` на любой ветке → `desktop-release.yml`:
- Сборка инсталляторов Win / Mac / Linux на CI (НЕ локально — RU-сеть флакает на winCodeSign download).
- Опциональная подпись (если настроены секреты `WINDOWS_CERT`, `APPLE_ID`).
- Артефакты в GitHub Release (draft).

```bash
git tag v0.1.0
git push origin v0.1.0
# Дождаться workflow → отредактировать draft release → publish
```

## 5. Откат (rollback)

### Billing
```bash
# На billing-VPS
cd /opt/billing
git log --oneline -10  # выбрать предыдущий рабочий commit
git checkout <prev-commit>
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate
# ВАЖНО: миграции откатываются ОТДЕЛЬНО (Drizzle не делает auto-down).
# Если новая миграция испортила схему — восстанавливаем из последнего бэкапа:
#   gunzip -c ./backups/billing_<stamp>.sql.gz | docker compose ... exec -T postgres psql -U billing -d billing
```

### Gateway
```bash
cd /opt/gateway && git checkout <prev-commit>
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate
```

## 6. Ротация секретов

### LITELLM_MASTER_KEY
Раз в 6 месяцев или при компрометации:
1. На gateway-VPS сгенерировать новый: `LITELLM_MASTER_KEY=sk-$(openssl rand -hex 32)`
2. Обновить `gateway/.env.prod` и `billing/.env.prod` (одинаковое значение!)
3. Перезапустить оба:
   ```bash
   cd /opt/gateway && docker compose -f docker-compose.prod.yml up -d --force-recreate litellm
   cd /opt/billing && docker compose -f docker-compose.prod.yml up -d --force-recreate billing retry-worker etl-worker
   ```

### JWT_SECRET
Ротация инвалидирует все active sessions — пользователи будут переавторизовываться:
1. Обновить `billing/.env.prod`
2. `docker compose ... up -d --force-recreate billing`
3. Уведомить пользователей (in-app banner или email).

### POSTGRES_PASSWORD
Не трогаем без необходимости — требует ALTER USER + рестарт. Документировать отдельной процедурой при компрометации.

## 7. Восстановление из бэкапа

```bash
cd /opt/billing
# Скачать нужный бэкап из S3 (если потерян локально)
aws --endpoint-url $BACKUP_S3_ENDPOINT s3 cp \
  s3://$BACKUP_S3_BUCKET/billing/billing_2026-05-29_02-00-00.sql.gz ./backups/

# Восстановление в чистую БД (предварительно остановить billing!)
docker compose -f docker-compose.prod.yml stop billing retry-worker etl-worker
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U billing -d billing -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
gunzip -c ./backups/billing_2026-05-29_02-00-00.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres psql -U billing -d billing
docker compose -f docker-compose.prod.yml start billing retry-worker etl-worker
```

## 8. Мониторинг

- Логи: `docker compose -f docker-compose.prod.yml logs --tail=200 -f billing`
- Healthcheck: `https://api.paragraf.ru/health/readiness` (db + redis status)
- Алерты:
  - UptimeRobot → Telegram (downtime > 10 мин)
  - Spend на LiteLLM → Slack webhook (`SLACK_WEBHOOK_URL`)
  - CloudPayments dashboard → email при failed payments

## 9. Безопасность — чек-лист

- [ ] `.env.prod` файлы — chmod 600, владелец deploy
- [ ] Postgres — без публичных портов (только internal docker network)
- [ ] Redis — пароль обязателен, без публичных портов
- [ ] LITELLM_MASTER_KEY — никогда в desktop-сборке (проверить через `grep -r LITELLM_MASTER_KEY desktop/dist`)
- [ ] CloudPayments webhook — HMAC-валидация активна
- [ ] Бэкапы ПДн — только РФ S3 (Selectel/Yandex), 152-ФЗ
- [ ] SSH — только по ключам (PasswordAuthentication no)
- [ ] fail2ban на SSH

## 10. Известные подводные камни

См. CLAUDE.md «Operational notes». Главные:

- **Миграции** — `migrate-prod.sh` ОБЯЗАТЕЛЕН после каждого деплоя billing. Без него /me, /limits возвращают 500.
- **Production NSIS сборка из RU** — флакает (`winCodeSign-2.6.0.7z` download timeout). Поэтому инсталляторы только через CI.
- **GigaChat OAuth RqUID** — на bash в RqUID нужен явный UUID.
- **GigaChat spend tracking** — LiteLLM не имеет встроенных цен GigaChat, считаем на стороне billing через usage_events.

# Paragraf — локальный дев-стек (РФ-ядро: engine + billing + миграции + ETL).
# Зарубежный gateway — отдельный репо (../paragraf-gateway), поднимается отсюда же если склонирован.
# Кросс-платформенно (Linux/macOS/WSL/git-bash). Нужны: docker, bun, curl, lsof.
# Подробности — DEPLOY.md / CLAUDE.md.

SHELL := bash
.DEFAULT_GOAL := help

BUN ?= bun
# GATEWAY_DIR — клон github.com/GlebAvershin/paragraf-gateway (соседней папкой)
GATEWAY_DIR ?= ../paragraf-gateway
# WEB_DIR — каталог веб-рендерера (форк opencode, теперь внутри монорепо: ./web)
WEB_DIR ?= web
# GOST_RAG_DIR — ML-проект (база знаний ГОСТ) вынесен в репо paragraf-gateway (соседней папкой)
GOST_RAG_DIR ?= ../paragraf-gateway/gost-rag
# RUN — каталог логов фоновых сервисов
RUN := .run

.PHONY: help dev env-init docker-check up down restart infra gateway db wait migrate seed \
        billing engine etl web gost-rag health logs typecheck test env-check

## ─────────────────────────── основное ───────────────────────────

help: ## показать список команд
	@echo "Paragraf — локальный стек. Команды:"
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n",$$1,$$2}'
	@echo ""
	@echo "Быстрый старт:  make dev   —  ВЕСЬ продукт одной командой (бэкенд + веб)"

dev: ## ⭐ поднять ВЕСЬ продукт ОДНОЙ командой: .env + шлюз + бэкенд (фон) + веб (этот терминал)
	@$(MAKE) -s docker-check
	@$(MAKE) -s env-init
	@$(MAKE) -s up
	@echo ""
	@echo "[dev] бэкенд поднят → запускаю веб: http://localhost:5173"
	@echo "[dev] OTP-код для входа: в другом терминале  make logs   (или Mailpit :8025)"
	@echo "[dev] Ctrl-C останавливает только веб; бэкенд живёт (полный стоп — make down)"
	@$(MAKE) -s web

env-init: ## создать billing/.env + engine/.env из примеров с общим JWT_SECRET (существующий секрет не трогаем)
	@created=" "; \
	for d in billing engine; do \
	  if [ ! -f $$d/.env ]; then cp $$d/.env.example $$d/.env && created="$$created$$d " && echo "[env-init] создан $$d/.env"; fi; \
	done; \
	shared=""; \
	for d in billing engine; do \
	  case "$$created" in *" $$d "*) continue;; esac; \
	  v=$$(sed -n -E 's|^JWT_SECRET=(.+)$$|\1|p' $$d/.env 2>/dev/null | head -1); [ -n "$$v" ] && shared="$$v"; \
	done; \
	if [ -z "$$shared" ]; then shared=$$(openssl rand -hex 32); gen=1; else gen=0; fi; \
	changed=0; \
	for d in billing engine; do \
	  [ -f $$d/.env ] || continue; \
	  cur=$$(sed -n -E 's|^JWT_SECRET=(.+)$$|\1|p' $$d/.env | head -1); \
	  case "$$created" in *" $$d "*) is_new=1;; *) is_new=0;; esac; \
	  if [ "$$is_new" = 1 ] || [ -z "$$cur" ]; then \
	    if grep -qE '^JWT_SECRET=' $$d/.env; then sed -i.bak -E "s|^JWT_SECRET=.*|JWT_SECRET=$$shared|" $$d/.env && rm -f $$d/.env.bak; \
	    else printf 'JWT_SECRET=%s\n' "$$shared" >> $$d/.env; fi; \
	    changed=1; \
	  fi; \
	done; \
	if [ "$$changed" = 1 ]; then \
	  [ "$$gen" = 1 ] && echo "[env-init] сгенерирован новый общий JWT_SECRET" || echo "[env-init] JWT_SECRET взят из существующего .env (не перезаписан)"; \
	  echo "[env-init] JWT_SECRET синхронизирован (billing == engine)"; \
	  echo "[env-init] ВАЖНО: впиши ключи моделей в $(GATEWAY_DIR)/.env (ANTHROPIC_API_KEY / OPENROUTER_API_KEY / GIGACHAT_CREDENTIALS)"; \
	fi

up: env-check infra migrate ## поднять весь бэкенд одной командой (docker + миграции + сервисы в фоне)
	@mkdir -p $(RUN)
	@echo "[up] запуск сервисов в фоне (логи в $(RUN)/)..."
	@cd billing && NODE_ENV=production nohup $(BUN) run src/index.ts            > "$(CURDIR)/$(RUN)/billing.log" 2>&1 & echo "  billing  → :3000"
	@cd engine  &&                     nohup $(BUN) run start                   > "$(CURDIR)/$(RUN)/engine.log"  2>&1 & echo "  engine   → :4096"
	@cd billing && NODE_ENV=production nohup $(BUN) run src/worker/etl.ts --loop --interval=30 > "$(CURDIR)/$(RUN)/etl.log" 2>&1 & echo "  etl      → loop 30s"
	@sleep 4
	@$(MAKE) -s health
	@echo ""
	@echo "Готово. Логи: make logs | Стоп: make down | Рендерер: make web"

down: ## остановить сервисы (engine/billing/etl). DOCKER=1 — ещё и контейнеры
	@echo "[down] остановка сервисов..."
	@-lsof -ti tcp:3000 2>/dev/null | xargs -r kill 2>/dev/null && echo "  billing остановлен" || true
	@-lsof -ti tcp:4096 2>/dev/null | xargs -r kill 2>/dev/null && echo "  engine остановлен"  || true
	@-pkill -f 'worker/etl.ts' 2>/dev/null && echo "  etl остановлен" || true
ifdef DOCKER
	@echo "[down] остановка контейнеров (данные в volume сохраняются)..."
	@-docker compose -f engine/docker-compose.yml down 2>/dev/null || true
	@-docker compose -f billing/docker-compose.yml down 2>/dev/null || true
	@-[ -f "$(GATEWAY_DIR)/docker-compose.yml" ] && docker compose -f "$(GATEWAY_DIR)/docker-compose.yml" down 2>/dev/null || true
endif

restart: down up ## перезапустить стек

## ─────────────────────────── инфраструктура ───────────────────────────

docker-check: ## убедиться, что Docker запущен
	@docker info >/dev/null 2>&1 || { echo "Docker не запущен. Открой Docker Desktop (macOS: open -a Docker), дождись готовности и повтори make dev."; exit 1; }

infra: docker-check gateway db wait ## поднять контейнеры (gateway + postgres engine/billing)

gateway: ## поднять gateway-контейнеры (из соседнего репо, если есть)
	@if [ -f "$(GATEWAY_DIR)/docker-compose.yml" ]; then \
	  echo "[gateway] up ($(GATEWAY_DIR))..."; \
	  docker compose -f "$(GATEWAY_DIR)/docker-compose.yml" up -d >/dev/null \
	    || { echo "[gateway] не поднялся. Если 'name is already in use' — застрявший контейнер от прошлого запуска:"; \
	         echo "          docker rm -f gateway_postgres gateway_litellm   (данные в volume сохранятся), затем make dev"; exit 1; }; \
	  printf "[gateway] жду :4000"; for i in $$(seq 1 40); do \
	    curl -fsS http://localhost:4000/health/liveliness >/dev/null 2>&1 && { echo " — готов"; break; }; printf "."; sleep 1; done; \
	else \
	  echo "[gateway] ВНИМАНИЕ: не найден $(GATEWAY_DIR) — клонируйте github.com/GlebAvershin/paragraf-gateway соседней папкой (см. DEPLOY.md), модели работать не будут"; \
	fi

db: ## поднять postgres-контейнеры (engine :5434, billing :5433)
	@echo "[db] postgres up..."
	@docker compose -f engine/docker-compose.yml up -d >/dev/null
	@docker compose -f billing/docker-compose.yml up -d >/dev/null

wait: ## дождаться готовности postgres
	@echo -n "[db] жду postgres"; \
	for i in $$(seq 1 30); do \
	  if docker exec billing_postgres pg_isready -U billing >/dev/null 2>&1 \
	     && docker exec engine_postgres pg_isready -U engine >/dev/null 2>&1; then echo " — готов"; exit 0; fi; \
	  echo -n "."; sleep 1; \
	done; echo " — не дождался за 30с (продолжаю)"

migrate: ## применить схему + сиды + ручные миграции billing
	@echo "[migrate] схема + сиды..."
	@cd billing && NODE_ENV=production $(BUN) run db:push >/dev/null && NODE_ENV=production $(BUN) run db:seed >/dev/null
	@echo "[migrate] ручные миграции..."
	@for f in billing/drizzle/manual/*.sql; do \
	  [ -e "$$f" ] || continue; \
	  docker exec -i billing_postgres psql -U billing -d billing -v ON_ERROR_STOP=1 < "$$f" >/dev/null 2>&1 \
	    && echo "  OK $$(basename $$f)" || echo "  ! $$(basename $$f) — проверьте вручную"; \
	done

seed: ## пересеять тарифы + ставки моделей
	@cd billing && NODE_ENV=production $(BUN) run db:seed

## ─────────────────────────── отдельные сервисы (foreground) ───────────────────────────

billing: ## запустить billing в текущем терминале (OTP-коды печатаются тут)
	@cd billing && NODE_ENV=production $(BUN) run src/index.ts

engine: ## запустить engine в текущем терминале
	@cd engine && $(BUN) run start

etl: ## запустить ETL-воркер (списание кредитов) в текущем терминале
	@cd billing && NODE_ENV=production $(BUN) run src/worker/etl.ts --loop --interval=30

web: ## запустить веб-рендерер (vite :5173) из ./web (первый раз поставит зависимости)
	@if [ -d "$(WEB_DIR)/packages/app" ]; then \
	  [ -d "$(WEB_DIR)/node_modules" ] || { echo "[web] ставлю зависимости (bun install, первый раз — небыстро)..."; (cd "$(WEB_DIR)" && $(BUN) install); }; \
	  cd "$(WEB_DIR)" && $(BUN) run dev:web; \
	else echo "рендерер не найден в $(WEB_DIR) — он должен лежать в ./web (или задайте WEB_DIR=путь)"; fi

gost-rag: ## поднять gost-rag grounding-сервис (:8000) — заземление ответов инженера в ГОСТ
	@if [ -d "$(GOST_RAG_DIR)" ]; then \
	  echo "[gost-rag] serve :8000 — нужен поднятый Qdrant+индекс (см. $(GOST_RAG_DIR)/README.md: make up)"; \
	  cd "$(GOST_RAG_DIR)" && $(MAKE) -s serve; \
	else echo "[gost-rag] не найден $(GOST_RAG_DIR)"; fi

## ─────────────────────────── утилиты ───────────────────────────

health: ## проверить здоровье сервисов
	@printf "  gateway :4000  "; curl -fsS http://localhost:4000/health/liveliness >/dev/null 2>&1 && echo "OK" || echo "DOWN"
	@printf "  billing :3000  "; curl -fsS http://localhost:3000/health/readiness  >/dev/null 2>&1 && echo "OK" || echo "DOWN"
	@printf "  engine  :4096  "; curl -fsS http://localhost:4096/health/readiness  >/dev/null 2>&1 && echo "OK" || echo "DOWN"
	@printf "  gost-rag:8000  "; curl -fsS http://localhost:8000/health >/dev/null 2>&1 && echo "OK" || echo "DOWN (опц. — make gost-rag)"

logs: ## показать логи фоновых сервисов (Ctrl-C для выхода)
	@tail -n 40 -f $(RUN)/*.log 2>/dev/null || echo "нет логов — сначала make up"

typecheck: ## typecheck всех наших пакетов
	@cd engine && $(BUN) run typecheck && cd ../billing && $(BUN) run typecheck && cd ../doc-tools && $(BUN) run typecheck

test: ## тесты billing + doc-tools
	@cd doc-tools && $(BUN) test; cd ../billing && $(BUN) test

env-check: ## проверить наличие .env (подсказать, если нет)
	@for d in billing engine; do \
	  if [ ! -f "$$d/.env" ]; then \
	    echo "ВНИМАНИЕ: нет $$d/.env — скопируйте: cp $$d/.env.example $$d/.env и заполните (JWT_SECRET в billing и engine ДОЛЖНЫ совпадать)"; \
	  fi; \
	done

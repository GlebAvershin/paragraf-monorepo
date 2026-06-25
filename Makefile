# Paragraf — локальный дев-стек (РФ-ядро: engine + billing + миграции + ETL).
# Зарубежный gateway — отдельный репо (../paragraf-gateway), поднимается отсюда же если склонирован.
# Кросс-платформенно (Linux/macOS/WSL/git-bash). Нужны: docker, bun, curl, lsof.
# Подробности — DEPLOY.md / CLAUDE.md.

SHELL := bash
.DEFAULT_GOAL := help

BUN ?= bun
# GATEWAY_DIR — клон github.com/GlebAvershin/paragraf-gateway (соседней папкой)
GATEWAY_DIR ?= ../paragraf-gateway
# WEB_DIR — форк-рендерер (glar); переопредите если клонирован иначе: make web WEB_DIR=../glar
WEB_DIR ?= desktop
# RUN — каталог логов фоновых сервисов
RUN := .run

.PHONY: help up down restart infra gateway db wait migrate seed \
        billing engine etl web health logs typecheck test env-check

## ─────────────────────────── основное ───────────────────────────

help: ## показать список команд
	@echo "Paragraf — локальный стек. Команды:"
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n",$$1,$$2}'
	@echo ""
	@echo "Быстрый старт:  make up   (поднять всё)   →   make web   (рендерер в отдельном терминале)"

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

infra: gateway db wait ## поднять контейнеры (gateway + postgres engine/billing)

gateway: ## поднять gateway-контейнеры (из соседнего репо, если есть)
	@if [ -f "$(GATEWAY_DIR)/docker-compose.yml" ]; then \
	  echo "[gateway] up ($(GATEWAY_DIR))..."; \
	  docker compose -f "$(GATEWAY_DIR)/docker-compose.yml" up -d >/dev/null; \
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

web: ## запустить веб-рендерер (vite :5173) — нужен клон glar в $(WEB_DIR)
	@if [ -d "$(WEB_DIR)/packages/app" ]; then cd "$(WEB_DIR)" && $(BUN) run dev:web; \
	else echo "рендерер не найден в $(WEB_DIR) — клонируйте github.com/GlebAvershin/glar (ветка ourapp/main) и/или задайте WEB_DIR=путь"; fi

## ─────────────────────────── утилиты ───────────────────────────

health: ## проверить здоровье сервисов
	@printf "  gateway :4000  "; curl -fsS http://localhost:4000/health/liveliness >/dev/null 2>&1 && echo "OK" || echo "DOWN"
	@printf "  billing :3000  "; curl -fsS http://localhost:3000/health/readiness  >/dev/null 2>&1 && echo "OK" || echo "DOWN"
	@printf "  engine  :4096  "; curl -fsS http://localhost:4096/health/readiness  >/dev/null 2>&1 && echo "OK" || echo "DOWN"

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

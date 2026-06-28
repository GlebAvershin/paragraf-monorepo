# gost-rag — локальный запуск в одну команду (как `make up` в монорепе).
# Эмбеддинги + генерация — через OpenRouter (ОДИН ключ). Qdrant — в docker.
# Нужны: docker, uv, curl. Подробности — README.md.

SHELL := bash
.DEFAULT_GOAL := help
UV ?= uv
SRC ?= data/pdfs              # реальный корпус (домен «арматура»); фикстуры — только для `make test`
GATEWAY_DIR ?= ../../paragraf-gateway   # сосед-репо со шлюзом (для `make gateway`)
PORT ?= 8000                 # HTTP-сервис grounding (engine ходит сюда на /retrieve)

.PHONY: help up down index hybrid ask eval test dash logs gateway env-check fetch diagnose serve

help: ## показать команды
	@echo "gost-rag — команды:"
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-8s\033[0m %s\n",$$1,$$2}'
	@echo ""
	@echo "Старт:  cp env.sample .env  →  make gateway up  →  make eval   (всё через LiteLLM-шлюз)"

fetch: ## скачать реальный ГОСТ/СП корпус по ссылкам разметки → data/pdfs
	@bash scripts/fetch_corpus.sh "$(SRC)"

diagnose: ## диагностика ингеста корпуса (маркировка/пункты/скан-риск) — до фриза
	@$(UV) run python scripts/diagnose_corpus.py "$(SRC)"

env-check: ## проверить .env
	@[ -f .env ] || { echo "нет .env — выполни: cp env.sample .env  и заполни ключ шлюза (LITELLM_API_KEY)"; exit 1; }
	@grep -qE '^(LITELLM_API_KEY|OPENROUTER_API_KEY)=\S' .env || echo "ВНИМАНИЕ: в .env нет ни LITELLM_API_KEY (шлюз), ни OPENROUTER_API_KEY (прямой режим)"

gateway: ## поднять LiteLLM-шлюз (сосед $(GATEWAY_DIR)), если он есть
	@if [ -f "$(GATEWAY_DIR)/docker-compose.yml" ]; then \
	  echo "[gateway] up ($(GATEWAY_DIR))..."; docker compose -f "$(GATEWAY_DIR)/docker-compose.yml" up -d; \
	  printf "[gateway] жду :4000"; for i in $$(seq 1 30); do \
	    curl -fsS http://localhost:4000/health/liveliness >/dev/null 2>&1 && { echo " — готов"; break; }; printf "."; sleep 1; done; \
	else echo "[gateway] не найден $(GATEWAY_DIR) — клонируй paragraf-gateway и заполни его .env (OPENROUTER_API_KEY)"; fi

up: env-check ## поднять всё: Qdrant + зависимости + индексация (dense + hybrid)
	@docker compose up -d
	@$(UV) sync >/dev/null
	@printf "[up] жду Qdrant"; for i in $$(seq 1 30); do \
	  curl -fsS http://localhost:6333/readyz >/dev/null 2>&1 && { echo " — готов"; break; }; printf "."; sleep 1; done
	@$(MAKE) -s index
	@$(MAKE) -s hybrid
	@echo "[up] готово →  make ask q='вопрос по ГОСТу'   |   make eval"

index: ## (пере)индексировать dense-коллекцию (SRC=data/fixtures по умолчанию)
	@echo "[index] dense ($(SRC))..."
	@$(UV) run python scripts/index_corpus.py --src "$(SRC)"

hybrid: ## (пере)индексировать hybrid-коллекцию (dense+BM25) — нужна для абляции rag+hybrid
	@echo "[index] hybrid ($(SRC))..."
	@$(UV) run python scripts/index_corpus.py --src "$(SRC)" --hybrid

ask: ## спросить (дефолт = конфиг-победитель):  make ask q="..."  |  make ask gold=rebar-monolith  [model=z-ai/glm-5.2]
	@$(UV) run python scripts/ask.py $(if $(gold),--gold $(gold),) $(if $(strategy),--strategy $(strategy),) $(if $(model),--model "$(model)",) $(if $(q),"$(q)",)

eval: ## бенчмарк → eval/results.md  [model=..] [strategy=rag] [limit=8] (дешёвый срез)
	@$(UV) run python eval/run_eval.py --corpus "$(SRC)" \
	  $(if $(model),--model "$(model)",) $(if $(strategy),--strategy "$(strategy)",) $(if $(limit),--limit "$(limit)",)

serve: ## поднять grounding HTTP-сервис (engine→/retrieve,/ask) на :$(PORT); нужен поднятый `make up`
	@$(UV) run --extra serve uvicorn gost_rag.server:app --host 0.0.0.0 --port $(PORT)

test: ## юнит-тесты
	@$(UV) run --extra dev pytest -q

dash: ## открыть дашборд Qdrant
	@open http://localhost:6333/dashboard 2>/dev/null || echo "http://localhost:6333/dashboard"

logs: ## логи Qdrant
	@docker compose logs -f qdrant

down: ## остановить Qdrant (данные сохраняются в volume)
	@docker compose down

-- Тир "embedding" для model_rates: gost-rag-ретрив на ключе юзера, метрится без пола.
-- Применение: docker exec -i billing_postgres psql -U billing -d billing < этот файл
ALTER TYPE model_tier ADD VALUE IF NOT EXISTS 'embedding';

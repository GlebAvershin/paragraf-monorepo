-- Migration: переход с «задачи в месяц» на кредитную модель с множителем модели.
-- Date: 2026-05-25
-- Reversible: см. блок DOWN внизу файла.
--
-- ВАЖНО: это ручная миграция, потому что:
--   1. drizzle-kit generate требует bun (не всегда доступен в этой среде)
--   2. Изменения backward-compatible (новые поля + новые таблицы + новые enum values)
--   3. Существующие записи в БД (Free-план test@example.com) остаются рабочими
--
-- После применения этой миграции — запустить `bun run src/db/seed.ts` чтобы
-- заполнить новые поля (monthlyCredits) и новую таблицу (model_rates).

BEGIN;

-- ===== 1. Расширить credit_reason enum =====
ALTER TYPE credit_reason ADD VALUE IF NOT EXISTS 'subscription_monthly';
ALTER TYPE credit_reason ADD VALUE IF NOT EXISTS 'topup';

-- ===== 2. Новый enum для уровней модели =====
DO $$ BEGIN
  CREATE TYPE model_tier AS ENUM ('lite', 'mid', 'top');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== 3. plans.monthlyCredits =====
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS monthly_credits integer NOT NULL DEFAULT 0;

-- ===== 4. credit_grants.amount_credits, remainingCredits, paymentId =====
ALTER TABLE credit_grants
  ADD COLUMN IF NOT EXISTS amount_credits integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_credits integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_id uuid;

-- credit_grants.amount_usd_centi теперь имеет default — позволяет вставлять без него
ALTER TABLE credit_grants
  ALTER COLUMN amount_usd_centi SET DEFAULT 0;

CREATE INDEX IF NOT EXISTS credit_grants_sub_idx
  ON credit_grants (subscription_id);

CREATE INDEX IF NOT EXISTS credit_grants_consume_order_idx
  ON credit_grants (subscription_id, expires_at NULLS LAST, created_at);

-- ===== 5. usage_events.credits_charged =====
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS credits_charged integer NOT NULL DEFAULT 0;

-- Идемпотентность ETL-воркера: один request_id обрабатывается ровно раз.
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_request_unique
  ON usage_events (request_id)
  WHERE request_id IS NOT NULL;

-- ===== 6. model_rates — новая таблица =====
CREATE TABLE IF NOT EXISTS model_rates (
  model_code text PRIMARY KEY,
  provider text NOT NULL,
  tier model_tier NOT NULL,
  multiplier numeric(4, 2) NOT NULL,
  calibration_tokens_in integer NOT NULL DEFAULT 1500,
  calibration_tokens_out integer NOT NULL DEFAULT 500,
  provider_price_per_1k_input_usd_micro_centi bigint NOT NULL DEFAULT 0,
  provider_price_per_1k_output_usd_micro_centi bigint NOT NULL DEFAULT 0,
  display_name_ru text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ===== 7. settings_kv — для last_processed_at ETL и калибровочных параметров =====
CREATE TABLE IF NOT EXISTS settings_kv (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

COMMIT;

-- ============================================================
-- DOWN (для отката — выполнять вручную, не автоматически)
-- ============================================================
-- BEGIN;
-- DROP TABLE IF EXISTS settings_kv;
-- DROP TABLE IF EXISTS model_rates;
-- DROP INDEX IF EXISTS usage_events_request_unique;
-- ALTER TABLE usage_events DROP COLUMN IF EXISTS credits_charged;
-- DROP INDEX IF EXISTS credit_grants_consume_order_idx;
-- DROP INDEX IF EXISTS credit_grants_sub_idx;
-- ALTER TABLE credit_grants
--   DROP COLUMN IF EXISTS payment_id,
--   DROP COLUMN IF EXISTS remaining_credits,
--   DROP COLUMN IF EXISTS amount_credits;
-- ALTER TABLE plans DROP COLUMN IF EXISTS monthly_credits;
-- -- enum values удалить нельзя в Postgres — оставляем как есть (no-op).
-- COMMIT;

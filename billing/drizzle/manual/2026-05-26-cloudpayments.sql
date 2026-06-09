-- Migration: CloudPayments integration (ТЗ-02).
-- Date: 2026-05-26
-- Reversible: см. блок DOWN внизу файла.
--
-- ВАЖНО: ручная миграция (см. пояснение в 2026-05-25-credits-model.sql).
-- Все изменения backward-compatible: новые nullable-поля / поля с DEFAULT,
-- новый enum, новые индексы. Существующие записи остаются рабочими.
--
-- Что добавляется:
--   1. enum payment_kind ('subscription' | 'topup' | 'refund')
--   2. payments.kind, payments.metadata
--   3. payments — уникальный индекс по cloudpayments_invoice_id (идемпотентность)
--   4. subscriptions.pending_plan_code (отложенный downgrade)
--   5. subscriptions.past_due_since (окно ретраев рекуррентов)

BEGIN;

-- ===== 1. payment_kind enum =====
DO $$ BEGIN
  CREATE TYPE payment_kind AS ENUM ('subscription', 'topup', 'refund');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== 2. payments.kind, payments.metadata =====
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS kind payment_kind NOT NULL DEFAULT 'subscription',
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- ===== 3. payments — идемпотентность по InvoiceId =====
CREATE UNIQUE INDEX IF NOT EXISTS payments_invoice_unique
  ON payments (cloudpayments_invoice_id)
  WHERE cloudpayments_invoice_id IS NOT NULL;

-- ===== 4. subscriptions.pending_plan_code =====
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS pending_plan_code text;

-- FK на plans.code (ON DELETE SET NULL). Добавляем отдельно, чтобы не падать
-- если констрейнт уже создан повторным прогоном.
DO $$ BEGIN
  ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_pending_plan_code_fk
    FOREIGN KEY (pending_plan_code) REFERENCES plans (code) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== 5. subscriptions.past_due_since =====
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS past_due_since timestamp with time zone;

COMMIT;

-- ============================================================
-- DOWN (для отката — выполнять вручную, не автоматически)
-- ============================================================
-- BEGIN;
-- ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_pending_plan_code_fk;
-- ALTER TABLE subscriptions DROP COLUMN IF EXISTS past_due_since;
-- ALTER TABLE subscriptions DROP COLUMN IF EXISTS pending_plan_code;
-- DROP INDEX IF EXISTS payments_invoice_unique;
-- ALTER TABLE payments DROP COLUMN IF EXISTS metadata;
-- ALTER TABLE payments DROP COLUMN IF EXISTS kind;
-- -- enum payment_kind удалить нельзя если на него ссылаются — оставляем (no-op).
-- -- DROP TYPE IF EXISTS payment_kind;
-- COMMIT;

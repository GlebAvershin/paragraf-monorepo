-- Migration: waitlist_signups (лендинг — сбор email менеджеров, Фаза 4).
-- Idempotent (CREATE TABLE IF NOT EXISTS).
BEGIN;

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  interest   text NOT NULL DEFAULT 'manager',
  source     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_unique ON waitlist_signups (email);

COMMIT;

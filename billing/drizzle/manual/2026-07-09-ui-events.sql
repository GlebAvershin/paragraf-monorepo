-- Migration: ui_events (клик-аналитика для внутреннего дашборда аналитика).
-- Idempotent (CREATE TABLE IF NOT EXISTS).
BEGIN;

CREATE TABLE IF NOT EXISTS ui_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ui_events_user_idx ON ui_events (user_id);
CREATE INDEX IF NOT EXISTS ui_events_type_created_idx ON ui_events (event_type, created_at);

COMMIT;

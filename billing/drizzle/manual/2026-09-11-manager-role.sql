-- Роли кабинета: employee (дефолт) / manager + связь «кого завёл менеджер».
--
--   users.role       — employee у всех существующих (дефолт), manager выдаётся
--                      самим пользователем через кнопку «Стать менеджером».
--   users.manager_id — NULL у самостоятельно заведённых (могут стать менеджером),
--                      заполнен у созданных менеджером (не могут, расход виден ему).
--
-- Идемпотентно. Применение:
--   docker compose -f docker-compose.prod.yml exec -T postgres_billing \
--     psql -U billing -d billing < billing/drizzle/manual/2026-09-11-manager-role.sql
BEGIN;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('employee', 'manager');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS role user_role NOT NULL DEFAULT 'employee';
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_manager_idx ON users (manager_id);

COMMIT;

-- ALTER TYPE ... ADD VALUE — отдельно от транзакции выше: новое значение enum
-- нельзя использовать в той же транзакции, где оно добавлено (та же причина,
-- по которой 2026-07-10-model-tier-embedding.sql идёт без BEGIN/COMMIT).
ALTER TYPE credit_reason ADD VALUE IF NOT EXISTS 'manager_transfer';

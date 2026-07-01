-- Опциональный пароль как параллельный способ входа (демо/тест-период).
-- NULL у обычных пользователей — они по-прежнему входят по OTP.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

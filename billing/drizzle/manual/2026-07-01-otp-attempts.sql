-- OTP brute-force guard: счётчик неудачных попыток на строку кода.
-- После N неудач (см. auth.ts MAX_OTP_ATTEMPTS) код считается исчерпанным.
-- Идемпотентно (IF NOT EXISTS) — можно прогонять повторно (см. up.ps1).
ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

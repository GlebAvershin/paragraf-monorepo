import { defineConfig } from "astro/config"

// Маркетинговый лендинг Isaak. Статический сайт-витрина:
// дверь Технолог (ГОСТы — MVP 2026-07), waitlist менеджеров, скачивание приложения.
// Юрист/Бухгалтер пока скрыты (вернутся одной строкой в ourapp/verticals.ts).
export default defineConfig({
  site: "https://isaac-ai.ru",
  // host: true → слушать на всех интерфейсах (IPv4 + IPv6). Без этого Astro
  // биндится только на ::1, и браузер на localhost (→127.0.0.1) не коннектится.
  server: { port: 4321, host: true },
})

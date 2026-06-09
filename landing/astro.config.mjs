import { defineConfig } from "astro/config"

// Маркетинговый лендинг «Параграфа». Статический сайт-витрина:
// две двери (юрист/бухгалтер), waitlist менеджеров, скачивание приложения.
export default defineConfig({
  site: "https://paragraf.app",
  // host: true → слушать на всех интерфейсах (IPv4 + IPv6). Без этого Astro
  // биндится только на ::1, и браузер на localhost (→127.0.0.1) не коннектится.
  server: { port: 4321, host: true },
})

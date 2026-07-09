/**
 * Route wrapper для AdminEventsPage — внутренний инструмент разработчиков/аналитика.
 * Не в навигации, доступен только по прямому URL /admin/click-analytics.
 * (НЕ /admin/events — этот путь занят billing-API GET/POST /admin/events,
 * см. Caddyfile: совпадение пути с API у SPA-роута ловит браузер на
 * ERR_INVALID_RESPONSE, т.к. прокси отдаёт JSON вместо index.html.)
 */
import { AdminEventsPage } from "@/pages/admin-events"

export default function AdminEventsRoute() {
  return <AdminEventsPage />
}

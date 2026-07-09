/**
 * Route wrapper для AdminEventsPage — внутренний инструмент разработчиков/аналитика.
 * Не в навигации, доступен только по прямому URL /admin/events.
 */
import { AdminEventsPage } from "@/pages/admin-events"

export default function AdminEventsRoute() {
  return <AdminEventsPage />
}

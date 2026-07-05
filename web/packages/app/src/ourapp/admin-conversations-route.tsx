/**
 * Route wrapper для AdminConversationsPage — внутренний инструмент разработчиков.
 * Не в навигации, доступен только по прямому URL /admin/conversations.
 */
import { AdminConversationsPage } from "@/pages/admin-conversations"

export default function AdminConversationsRoute() {
  return <AdminConversationsPage />
}

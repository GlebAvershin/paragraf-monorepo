/**
 * Route wrapper для TeamPage — кабинет менеджера (/team).
 * В шапке пункт «Команда» показывается только роли manager, но сама страница
 * доступна по прямой ссылке всем: сотруднику она объяснит, почему раздел пуст.
 */
import { TeamPage } from "@/pages/team"

export default function TeamRoute() {
  return <TeamPage />
}

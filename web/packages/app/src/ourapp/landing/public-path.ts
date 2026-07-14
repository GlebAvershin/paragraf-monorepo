/**
 * Публичный (без авторизации) маркетинговый лендинг Isaac — предикат маршрута.
 *
 * Шов роутинга живёт в `entry.tsx` (а НЕ в Router/OnboardingGate): при
 * совпадении пути короткое замыкание рендерит `LandingPage` вместо
 * `AppInterface`, минуя server/session-провайдеры. Держим предикат отдельным
 * модулем без зависимостей, чтобы его можно было юнит-тестировать и импортить
 * из entry без подтягивания всего дерева приложения.
 */

/** Единственный путь публичного лендинга. */
export const LANDING_PATH = "/landing"

/**
 * Относится ли `pathname` к публичному лендингу.
 *
 * Матчит и `/landing`, и `/landing/` (браузеры/прокси могут добавить слэш),
 * без учёта регистра; query/hash сюда не приходят (это `location.pathname`).
 */
export function isLandingPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase().replace(/\/+$/, "")
  return normalized === LANDING_PATH
}

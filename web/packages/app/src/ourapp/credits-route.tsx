/**
 * Route wrapper для CreditsPage — default export, чтобы lazy() в app.tsx работал.
 */
import { CreditsPage } from "./credits-page"

export default function CreditsRoute() {
  return <CreditsPage />
}

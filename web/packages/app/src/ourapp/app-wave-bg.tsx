/**
 * Публичная точка входа для фона страниц приложения (замена `DotWaveBackground`
 * в help/home/settings/onboarding/credits) — тот же WebGL-«цифровой мир», что и
 * на лендинге, перекрашенный под тему. Ленивая граница чанка: пока
 * `app-wave-scene.tsx` (тянет three.js) грузится, показываем прежний 2D
 * `DotWaveBackground` — тот же fallback, что и внутри самой сцены при
 * отсутствии WebGL, так что смена кадра при догрузке чанка не заметна.
 */
import { lazy, Suspense } from "solid-js"
import { DotWaveBackground } from "./dot-wave-bg"

const AppWaveScene = lazy(() => import("./app-wave-scene"))

export function AppWaveBackground() {
  return (
    <Suspense fallback={<DotWaveBackground />}>
      <AppWaveScene />
    </Suspense>
  )
}

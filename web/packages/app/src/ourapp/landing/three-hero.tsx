/**
 * WebGL-«цифровой мир» лендинга: закреплённая плоскость точек-террейна, всегда в
 * кадре за контентом. Волна считается в вершинном шейдере (GPU); при прокрутке
 * рисунок волны «утекает» к горизонту (uFlow) — как титры «Звёздных войн», при
 * этом сама плоскость не уходит с экрана. Поверх — диагональная решётка (линии) и
 * дрейфующие «дата-мошки». Курсор мягко поднимает поверхность под собой (луч→
 * плоскость + демпфирование). На сломе гребня точки коротко вспыхивают (vGlow).
 * Сам движок сцены (геометрии/шейдеры/rAF-цикл) — в общем `../wave-scene.ts`,
 * переиспользуемом также фоном страниц приложения (`../app-wave-scene.tsx`).
 *
 * DEFAULT-экспорт: граница lazy-чанка (`landing-page.tsx` грузит его
 * `lazy(() => import("./three-hero"))`) — three.js не попадает в основной бандл.
 *
 * Деградация (синхронный префлайт `initialMode()`, до создания сцены):
 *  - prefers-reduced-motion → статичный CSS-кадр (без canvas и rAF);
 *  - нет WebGL → 2D `DotWaveBackground`.
 * Рантайм-страховка: `webglcontextlost` → полный dispose + падение на 2D-фон.
 *
 * Прокрутка берётся у скролл-контейнера `.isaac-lp` (лендинг скроллится внутри
 * него, не окном) с фолбэком на window. Производительность: powerPreference
 * "low-power", DPR≤2, пауза на visibilitychange, полный dispose в onCleanup и при
 * потере контекста (points + lines + motes геометрии/материалы + renderer).
 */
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { DotWaveBackground } from "@/ourapp/dot-wave-bg"
import { initialWaveMode, mountWaveScene, type WaveSceneColors } from "@/ourapp/wave-scene"

const LANDING_COLORS: WaveSceneColors = {
  low: [0.043, 0.325, 0.271], // emerald-deep
  high: [0.404, 0.941, 0.847], // aqua
  fog: [0.031, 0.066, 0.055],
  mote: [0.404, 0.941, 0.847],
}

export default function ThreeHero() {
  const [mode, setMode] = createSignal(initialWaveMode())
  let container: HTMLDivElement | undefined

  onMount(() => {
    if (mode() !== "webgl") return
    const host = container
    if (!host) return
    const scroller = host.closest(".isaac-lp") as HTMLElement | null

    const dispose = mountWaveScene({
      mount: host,
      measure: host,
      scroller,
      getColors: () => LANDING_COLORS,
      onContextLost: () => setMode("canvas2d"),
    })

    onCleanup(dispose)
  })

  return (
    <div class="isaac-lp-world" aria-hidden="true">
      <Show when={mode() === "webgl"}>
        <div ref={container} class="isaac-lp-world__gl" />
      </Show>
      <Show when={mode() === "canvas2d"}>
        <DotWaveBackground />
      </Show>
      <Show when={mode() === "static"}>
        <div class="isaac-lp-world__static" />
      </Show>
    </div>
  )
}

/**
 * Фон приложения: тот же WebGL-«цифровой мир», что и на лендинге (движок в
 * `wave-scene.ts`), но перекрашенный под текущую свето-тёмную тему приложения
 * (акцентные emerald-тона из index.css, а не изумруд/аква лендинга на чёрном) и
 * с обычным (не аддитивным) блендингом — на светлом кремовом фоне аддитив
 * выбеливает точки, на тёмном фоне лендинга работает только потому что фон
 * почти чёрный.
 *
 * Монтируется как `.ourapp-dotwave` (та же sticky-обёртка, что раньше держала
 * 2D `DotWaveBackground`) — размер/пиннинг те же, меняется только рендер внутри.
 * DEFAULT-экспорт лениво грузится из `app-wave-bg.tsx`, чтобы three.js не попал
 * в основной бандл приложения (см. ту же мотивацию в `landing/three-hero.tsx`).
 *
 * Деградация — как в лендинге: reduced-motion → статичный кадр, нет WebGL →
 * прежний 2D `DotWaveBackground`, потеря контекста в рантайме → тоже 2D.
 */
import * as THREE from "three"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { DotWaveBackground } from "./dot-wave-bg"
import { initialWaveMode, mountWaveScene, type WaveSceneColors } from "./wave-scene"

const LIGHT_COLORS: WaveSceneColors = {
  low: [0.043, 0.325, 0.271], // #0B5345 — accent (light)
  high: [0.184, 0.82, 0.588], // #2FD196 — brand emerald
  fog: [0.984, 0.976, 0.957], // #FBF9F4 — page bg (light)
  mote: [0.184, 0.82, 0.588],
}

const DARK_COLORS: WaveSceneColors = {
  low: [0.043, 0.325, 0.271], // #0B5345
  high: [0.102, 0.541, 0.42], // #1A8A6B — accent (dark)
  fog: [0.082, 0.071, 0.059], // #15120F — page bg (dark)
  mote: [0.102, 0.541, 0.42],
}

function isDarkScheme(darkPref: MediaQueryList): boolean {
  const scheme = document.documentElement.dataset.colorScheme
  if (scheme === "dark") return true
  if (scheme === "light") return false
  return darkPref.matches
}

export default function AppWaveScene() {
  const [mode, setMode] = createSignal(initialWaveMode())
  let mount: HTMLDivElement | undefined

  onMount(() => {
    if (mode() !== "webgl") return
    const el = mount
    if (!el) return
    const host = el.parentElement?.parentElement // .ourapp-dotwave__gl → .ourapp-dotwave → страничный корень
    if (!host) return

    const darkPref = window.matchMedia("(prefers-color-scheme: dark)")

    const dispose = mountWaveScene({
      mount: el,
      measure: host,
      sizeMount: true,
      scroller: host,
      blending: THREE.NormalBlending,
      getColors: () => (isDarkScheme(darkPref) ? DARK_COLORS : LIGHT_COLORS),
      onContextLost: () => setMode("canvas2d"),
    })

    onCleanup(dispose)
  })

  return (
    <Show when={mode() === "webgl"} fallback={<DotWaveBackground />}>
      <div class="ourapp-dotwave" aria-hidden="true">
        <div ref={mount} class="ourapp-dotwave__gl" />
      </div>
    </Show>
  )
}

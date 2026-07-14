/**
 * WebGL-hero лендинга: сетка точек-«террейна», волнующаяся синус-полем (то же
 * поле, что у 2D `dot-wave-bg.tsx`), с туманом глубины и мягким параллаксом
 * камеры от курсора и скролла. Изумрудная палитра токенов Isaac.
 *
 * DEFAULT-экспорт: это граница lazy-чанка (`landing-page.tsx` подгружает его
 * `lazy(() => import("./three-hero"))`), чтобы three.js не попал в основной бандл.
 *
 * Деградация (префлайт, до создания сцены):
 *  - prefers-reduced-motion → статичный CSS-кадр, без canvas и rAF (полностью
 *    читаемо, ничего не движется);
 *  - нет WebGL-контекста → 2D `DotWaveBackground` (анимированный canvas 2D).
 * Плюс рантайм-страховка: `webglcontextlost` → останавливаем цикл и падаем на
 * тот же 2D-фон.
 *
 * Производительность: только позиции вершин пересчитываются на кадр (transform
 * геометрии), `powerPreference:"low-power"`, DPR≤2, пауза на blur/`visibilitychange`,
 * полный dispose (renderer/geometry/material) в `onCleanup`.
 */
import * as THREE from "three"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { DotWaveBackground } from "@/ourapp/dot-wave-bg"

const COLS = 96
const ROWS = 52

function hasWebGL(): boolean {
  if (typeof window === "undefined") return false
  try {
    const canvas = document.createElement("canvas")
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    )
  } catch {
    return false
  }
}

/** Тёмная тема: тот же приоритет, что в `dot-wave-bg.tsx` (dataset → prefers). */
function isDark(): boolean {
  const scheme = document.documentElement.dataset.colorScheme
  if (scheme === "dark") return true
  if (scheme === "light") return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

type Mode = "webgl" | "canvas2d" | "static"

function initialMode(): Mode {
  if (typeof window === "undefined") return "static"
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "static"
  return hasWebGL() ? "webgl" : "canvas2d"
}

export default function ThreeHero() {
  // Начальный режим фиксируем синхронно (клиентский рендер SPA, не SSR).
  const [mode, setMode] = createSignal<Mode>(initialMode())
  let container: HTMLDivElement | undefined

  onMount(() => {
    if (mode() !== "webgl") return
    const host = container
    if (!host) return

    const scene = new THREE.Scene()
    const dark = isDark()
    // Палитра токенов Isaac: emerald #0B5345 (свет) / #26C496 (тёмная).
    const pointColor = new THREE.Color(dark ? 0x26c496 : 0x0b5345)
    // Туман глубины красим в фон страницы, чтобы дальние точки растворялись в нём.
    const fogColor = new THREE.Color(dark ? 0x15120f : 0xfbf9f4)
    scene.fog = new THREE.Fog(fogColor.getHex(), 6, 20)

    const camera = new THREE.PerspectiveCamera(52, host.clientWidth / host.clientHeight, 0.1, 100)
    const baseCam = new THREE.Vector3(0, 2.4, 8.5)
    camera.position.copy(baseCam)

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "low-power", alpha: true })
    renderer.setClearColor(0x000000, 0) // прозрачный фон — под canvas лежит страница
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(host.clientWidth, host.clientHeight)
    host.appendChild(renderer.domElement)
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"
    renderer.domElement.style.display = "block"

    // Геометрия сетки в плоскости XZ, волна по Y. Точки строятся один раз,
    // на кадр пересчитывается только Y-компонента позиций.
    const cols = COLS + 1
    const rows = ROWS + 1
    const count = cols * rows
    const positions = new Float32Array(count * 3)
    const worldW = 22
    const worldD = 26
    let i = 0
    for (let zi = 0; zi < rows; zi++) {
      for (let xi = 0; xi < cols; xi++) {
        const nx = xi / COLS - 0.5
        positions[i * 3] = nx * worldW
        positions[i * 3 + 1] = 0
        positions[i * 3 + 2] = -(zi / ROWS) * worldD + 2
        i++
      }
    }
    const geometry = new THREE.BufferGeometry()
    const posAttr = new THREE.BufferAttribute(positions, 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute("position", posAttr)

    const material = new THREE.PointsMaterial({
      color: pointColor,
      size: dark ? 0.055 : 0.05,
      sizeAttenuation: true,
      transparent: true,
      opacity: dark ? 0.9 : 0.8,
      depthWrite: false,
      fog: true,
    })
    const points = new THREE.Points(geometry, material)
    scene.add(points)

    const amp = 0.9
    const updateWave = (t: number) => {
      // Пишем прямо в backing-массив `positions` (тот же буфер, что у posAttr) —
      // без чтения/каста geometry.attributes.position.array.
      let idx = 0
      for (let zi = 0; zi < rows; zi++) {
        for (let xi = 0; xi < cols; xi++) {
          const nx = xi / COLS - 0.5
          // То же синус-поле, что в dot-wave-bg.tsx (единый «почерк» движения).
          const wave =
            Math.sin(nx * 7.5 + t * 0.9 + zi * 0.55) * Math.cos(zi * 0.38 - t * 0.6) * amp +
            Math.sin(zi * 0.9 - t * 1.1) * amp * 0.4
          positions[idx * 3 + 1] = wave
          idx++
        }
      }
      posAttr.needsUpdate = true
    }

    // Параллакс: цель от курсора (нормированные -1..1) + прогресс скролла по hero.
    let targetX = 0
    let targetY = 0
    let curX = 0
    let curY = 0
    let scrollProg = 0
    const onMove = (e: MouseEvent) => {
      targetX = (e.clientX / window.innerWidth - 0.5) * 2
      targetY = (e.clientY / window.innerHeight - 0.5) * 2
    }
    const onScroll = () => {
      const h = host.clientHeight || window.innerHeight
      scrollProg = Math.min(Math.max(window.scrollY / h, 0), 1)
    }

    const resize = () => {
      const w = host.clientWidth
      const hgt = host.clientHeight
      if (w === 0 || hgt === 0) return
      camera.aspect = w / hgt
      camera.updateProjectionMatrix()
      renderer.setSize(w, hgt)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    let raf = 0
    let running = true
    const render = (ms: number) => {
      const t = ms / 1000
      updateWave(t)
      // Плавное догоняние цели камеры (демпфирование).
      curX += (targetX - curX) * 0.04
      curY += (targetY - curY) * 0.04
      camera.position.x = baseCam.x + curX * 1.6
      camera.position.y = baseCam.y - curY * 0.8 + scrollProg * 1.8
      camera.position.z = baseCam.z - scrollProg * 2.2
      camera.lookAt(0, -0.2, -4)
      renderer.render(scene, camera)
      if (running) raf = requestAnimationFrame(render)
    }

    // Полная очистка: слушатели + rAF + dispose ресурсов three. Зовётся и при
    // размонтировании компонента (onCleanup), и при реальной потере контекста
    // (onContextLost) — иначе после contextlost сцена/слушатели утекали бы до
    // ухода со страницы (Show переключает режим, но не рвёт owner компонента).
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      running = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("scroll", onScroll)
      document.removeEventListener("visibilitychange", onVisibility)
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement)
    }

    function onContextLost(e: Event) {
      e.preventDefault()
      dispose()
      setMode("canvas2d") // страховка: падаем на 2D-фон
    }
    const onVisibility = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!running && !disposed && mode() === "webgl") {
        running = true
        raf = requestAnimationFrame(render)
      }
    }

    window.addEventListener("mousemove", onMove, { passive: true })
    window.addEventListener("scroll", onScroll, { passive: true })
    document.addEventListener("visibilitychange", onVisibility)
    renderer.domElement.addEventListener("webglcontextlost", onContextLost, false)
    onScroll()
    raf = requestAnimationFrame(render)

    onCleanup(dispose)
  })

  return (
    <div class="isaac-lp-hero__bg" aria-hidden="true">
      <Show when={mode() === "webgl"}>
        <div ref={container} class="isaac-lp-hero__gl" />
      </Show>
      <Show when={mode() === "canvas2d"}>
        <DotWaveBackground />
      </Show>
      <Show when={mode() === "static"}>
        <div class="isaac-lp-hero__static" />
      </Show>
    </div>
  )
}

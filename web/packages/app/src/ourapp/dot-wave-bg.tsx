/**
 * OurApp — фоновые «3D-волны» из бирюзовых точек (фидбек 2026-07-07, замена
 * статичной зернистости). Canvas с перспективной сеткой точек: плоскость
 * волнуется синусами, точки рядом с курсором мягко приподнимаются и подсвечиваются.
 *
 * Монтируется первым ребёнком страничного корня (корню нужен isolation:isolate,
 * см. index.css). Обёртка position:sticky + z-index:-1 держит канву за контентом
 * и в кадре при прокрутке. prefers-reduced-motion → один статичный кадр без rAF.
 */
import { For, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { addCreditBonus } from "./credit-bonus"

const COLS = 72
const ROWS = 26

export function DotWaveBackground() {
  let canvas: HTMLCanvasElement | undefined

  onMount(() => {
    const el = canvas!
    const ctx = el.getContext("2d")
    if (!ctx) return
    const host = el.parentElement?.parentElement // .ourapp-dotwave → страничный корень
    if (!host) return

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    const darkPref = window.matchMedia("(prefers-color-scheme: dark)")
    const isDark = () => {
      const scheme = document.documentElement.dataset.colorScheme
      if (scheme === "dark") return true
      if (scheme === "light") return false
      return darkPref.matches
    }

    let width = 0
    let height = 0
    let dpr = 1
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = host.clientWidth
      height = host.clientHeight
      el.style.width = width + "px"
      el.style.height = height + "px"
      el.width = Math.max(1, Math.round(width * dpr))
      el.height = Math.max(1, Math.round(height * dpr))
      if (reduced.matches) draw(lastT)
    }

    // Курсор в координатах канвы; вне окна — «далеко», чтобы не влиял.
    let mx = -1e4
    let my = -1e4
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      mx = e.clientX - r.left
      my = e.clientY - r.top
    }
    const onLeave = () => {
      mx = -1e4
      my = -1e4
    }

    // Периодическая «рябь» из 0/1 — намёк на идущие вычисления. Глифы всплывают
    // в случайных точках, плавно проявляются и гаснут, слегка дрейфуя вверх.
    type Glyph = { x: number; y: number; ch: string; born: number; ttl: number }
    const glyphs: Glyph[] = []
    let nextSpawn = 0

    let lastT = 0
    const draw = (t: number) => {
      lastT = t
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const [cr, cg, cb] = isDark() ? [38, 196, 150] : [11, 83, 69]
      const cx = width / 2
      const horizon = height * 0.34 // выше — плоскость «уходит» дальше
      const persp = height * 0.85
      const camH = height * 0.36 // высота камеры над плоскостью
      const worldW = width * 2.6
      const amp = height * 0.045

      // Дальние ряды рисуем первыми, ближние поверх.
      for (let zi = ROWS; zi >= 1; zi--) {
        const zWorld = 0.55 + (zi / ROWS) * 3.2
        const scale = 1 / zWorld
        const depth = 1 - (zi - 1) / ROWS // 1 = ближний ряд
        for (let xi = 0; xi <= COLS; xi++) {
          const nx = xi / COLS - 0.5
          const wave =
            Math.sin(nx * 7.5 + t * 0.9 + zi * 0.55) * Math.cos(zi * 0.38 - t * 0.6) * amp +
            Math.sin(zi * 0.9 - t * 1.1) * amp * 0.4
          const sx = cx + nx * worldW * scale
          if (sx < -8 || sx > width + 8) continue
          let sy = horizon + (camH - wave) * scale
          // Реакция на курсор: мягкий «подъём» и подсветка рядом с мышью.
          const dx = sx - mx
          const dy = sy - my
          const lift = Math.exp(-(dx * dx + dy * dy) / (2 * 120 * 120))
          sy -= lift * 16 * depth
          const radius = (0.6 + depth * 1.5) * (1 + lift * 0.9)
          const alpha = (0.05 + depth * 0.3) * (1 + lift * 1.6)
          ctx.beginPath()
          ctx.arc(sx, sy, radius, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${Math.min(alpha, 0.85)})`
          ctx.fill()
        }
      }

      // Бинарная рябь поверх точек.
      ctx.font = '600 12px "JetBrains Mono", ui-monospace, monospace'
      ctx.textBaseline = "middle"
      ctx.textAlign = "center"
      for (const g of glyphs) {
        const age = t - g.born
        if (age < 0 || age > g.ttl) continue
        const p = age / g.ttl
        const a = Math.sin(p * Math.PI) * 0.42
        if (a <= 0.01) continue
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${a})`
        ctx.fillText(g.ch, g.x, g.y - p * 22)
      }
    }

    let raf = 0
    const loop = (ms: number) => {
      const t = ms / 1000
      if (t >= nextSpawn) {
        nextSpawn = t + 0.35 + Math.random() * 0.7
        glyphs.push({
          x: 20 + Math.random() * Math.max(1, width - 40),
          y: height * 0.42 + Math.random() * height * 0.5,
          ch: Math.random() < 0.5 ? "0" : "1",
          born: t,
          ttl: 1.6 + Math.random() * 1.3,
        })
        while (glyphs.length > 0 && t - glyphs[0].born > glyphs[0].ttl) glyphs.shift()
      }
      draw(t)
      raf = requestAnimationFrame(loop)
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    if (reduced.matches) {
      draw(0)
    } else {
      window.addEventListener("mousemove", onMove, { passive: true })
      window.addEventListener("mouseout", onLeave, { passive: true })
      raf = requestAnimationFrame(loop)
    }

    onCleanup(() => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseout", onLeave)
    })
  })

  return (
    <>
      <div class="ourapp-dotwave" aria-hidden="true">
        <canvas ref={canvas} />
      </div>
      <CreditCapsules />
    </>
  )
}

/**
 * Капсулы, плавающие по волнам. Клик → +1 кредит к балансу (creditBonus) и
 * капсула лопается, затем возрождается в новой случайной точке. Отдельный
 * fixed-слой поверх фона, но ниже шапки/модалок; при reduced-motion отключён.
 */
type Capsule = { id: number; left: number; top: number; dur: number; delay: number; pop: boolean }

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const makeCapsule = (id: number): Capsule => ({
  id,
  left: rnd(6, 90),
  top: rnd(16, 84),
  dur: rnd(6, 10),
  delay: rnd(0, 4),
  pop: false,
})

function CreditCapsules() {
  if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return null
  }
  const [caps, setCaps] = createStore<Capsule[]>(Array.from({ length: 4 }, (_, i) => makeCapsule(i)))
  const timers: number[] = []

  const pop = (i: number) => {
    if (caps[i]?.pop) return
    addCreditBonus(1)
    setCaps(i, "pop", true)
    timers.push(
      window.setTimeout(() => {
        setCaps(i, { ...makeCapsule(caps[i].id), pop: false })
      }, 480),
    )
  }

  onCleanup(() => timers.forEach((t) => clearTimeout(t)))

  return (
    <div class="ourapp-capsules" aria-hidden="true">
      <For each={caps}>
        {(c, i) => (
          <button
            type="button"
            class="ourapp-capsule"
            classList={{ "ourapp-capsule--pop": c.pop }}
            style={{
              left: `${c.left}%`,
              top: `${c.top}%`,
              "animation-duration": `${c.dur}s`,
              "animation-delay": `${c.delay}s`,
            }}
            title="+1 кредит"
            onClick={() => pop(i())}
          >
            +1
          </button>
        )}
      </For>
    </div>
  )
}

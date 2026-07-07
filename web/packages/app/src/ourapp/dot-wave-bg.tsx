/**
 * OurApp — фоновые «3D-волны» из бирюзовых точек (фидбек 2026-07-07, замена
 * статичной зернистости). Canvas с перспективной сеткой точек: плоскость
 * волнуется синусами, точки рядом с курсором мягко приподнимаются и подсвечиваются.
 *
 * Монтируется первым ребёнком страничного корня (корню нужен isolation:isolate,
 * см. index.css). Обёртка position:sticky + z-index:-1 держит канву за контентом
 * и в кадре при прокрутке. prefers-reduced-motion → один статичный кадр без rAF.
 */
import { onCleanup, onMount } from "solid-js"

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
    }

    let raf = 0
    const loop = (ms: number) => {
      draw(ms / 1000)
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
    <div class="ourapp-dotwave" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  )
}

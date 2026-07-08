/**
 * OurApp — фоновые «3D-волны» из бирюзовых точек (фидбек 2026-07-07, замена
 * статичной зернистости). Canvas с перспективной сеткой точек: плоскость
 * волнуется синусами, точки рядом с курсором мягко приподнимаются и подсвечиваются.
 *
 * Монтируется первым ребёнком страничного корня (корню нужен isolation:isolate,
 * см. index.css). Обёртка position:sticky + z-index:-1 держит канву за контентом
 * и в кадре при прокрутке. prefers-reduced-motion → один статичный кадр без rAF.
 */
import { For, onCleanup, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { addCreditBonus } from "./credit-bonus"

const COLS = 72
const ROWS = 26

/**
 * @param capsules — показывать ли ловимые капсулы «+1 кредит» (только на главной).
 *   Рябь из 0/1 рисуется на канве всегда (на всех экранах с этим фоном).
 */
export function DotWaveBackground(props: { capsules?: boolean }) {
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

    // «Рябь» из 0/1 — намёк на вычисления. Каждая рябь = облачко мелких цифр в
    // несколько слоёв: цифры переливаются (0↔1) и мерцают, облачко плавно
    // спускается к волне и гаснет за 1–2 с. Одновременно держим 2–3 ряби,
    // только в нижней половине экрана.
    type RippleDot = { dx: number; dy: number; seed: number }
    type Ripple = { cx: number; cy: number; born: number; ttl: number; vy: number; dots: RippleDot[] }
    const ripples: Ripple[] = []
    let nextRipple = 0
    const makeRipple = (t: number): Ripple => {
      const count = 12 + Math.floor(Math.random() * 12) // «больше» мелких цифр
      const dots: RippleDot[] = []
      for (let i = 0; i < count; i++) {
        dots.push({ dx: (Math.random() - 0.5) * 78, dy: (Math.random() - 0.5) * 48, seed: Math.random() * 12 })
      }
      return {
        cx: 40 + Math.random() * Math.max(1, width - 80),
        cy: height * 0.55 + Math.random() * height * 0.32, // нижняя половина
        born: t,
        ttl: 1 + Math.random(), // 1–2 с
        vy: 26 + Math.random() * 26, // спуск к волне, px/с
        dots,
      }
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

      // Бинарная рябь поверх точек: мелкие мерцающие 0/1, спускаются к волне.
      ctx.font = '600 8px "JetBrains Mono", ui-monospace, monospace'
      ctx.textBaseline = "middle"
      ctx.textAlign = "center"
      for (const r of ripples) {
        const age = t - r.born
        if (age < 0 || age > r.ttl) continue
        const p = age / r.ttl
        const baseA = Math.sin(p * Math.PI) // проявление/затухание
        const descent = age * r.vy
        for (const d of r.dots) {
          // Переливание: символ и яркость меняются во времени (0↔1, мерцание).
          const ch = Math.floor(t * 6 + d.seed) % 2 === 0 ? "0" : "1"
          const flick = 0.5 + 0.5 * Math.sin(t * 8 + d.seed * 3)
          const a = baseA * 0.4 * flick
          if (a <= 0.02) continue
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${a})`
          ctx.fillText(ch, r.cx + d.dx, r.cy + d.dy + descent)
        }
      }
    }

    let raf = 0
    const loop = (ms: number) => {
      const t = ms / 1000
      // Прополка отживших ряби.
      for (let i = ripples.length - 1; i >= 0; i--) {
        if (t - ripples[i].born > ripples[i].ttl) ripples.splice(i, 1)
      }
      // Держим 2–3 ряби одновременно.
      if (t >= nextRipple && ripples.length < 3) {
        nextRipple = t + 0.3 + Math.random() * 0.5
        ripples.push(makeRipple(t))
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
      <Show when={props.capsules}>
        <CreditCapsules />
      </Show>
    </>
  )
}

/**
 * Капсулы «+1 кредит», плавающие по волнам в НИЖНЕЙ части экрана (на заднем
 * фоне, не перекрывая UX — ловятся только сами пилюли). Клик → +1 к балансу
 * (creditBonus) и капсула лопается. Максимум 3 на экране, новая появляется раз
 * в 5 с. При reduced-motion отключены. Показываются только на главной.
 */
type Capsule = { id: number; left: number; top: number; dur: number; pop: boolean }

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
let capsuleSeq = 0
const makeCapsule = (): Capsule => ({
  id: capsuleSeq++,
  left: rnd(8, 88),
  top: rnd(66, 88), // нижняя часть экрана, над волной
  dur: rnd(7, 11),
  pop: false,
})

function CreditCapsules() {
  if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return null
  }
  const [caps, setCaps] = createStore<Capsule[]>([makeCapsule()])
  const timers: number[] = []

  // Новая капсула раз в 5 с, но не больше 3 одновременно.
  const spawn = window.setInterval(() => {
    setCaps(
      produce((list) => {
        if (list.length < 3) list.push(makeCapsule())
      }),
    )
  }, 5000)

  const pop = (id: number) => {
    const i = caps.findIndex((c) => c.id === id)
    if (i < 0 || caps[i].pop) return
    addCreditBonus(1)
    setCaps(i, "pop", true)
    timers.push(
      window.setTimeout(() => {
        setCaps(produce((list) => {
          const j = list.findIndex((c) => c.id === id)
          if (j >= 0) list.splice(j, 1)
        }))
      }, 460),
    )
  }

  onCleanup(() => {
    clearInterval(spawn)
    timers.forEach((t) => clearTimeout(t))
  })

  return (
    <div class="ourapp-capsules" aria-hidden="true">
      <For each={caps}>
        {(c) => (
          <button
            type="button"
            class="ourapp-capsule"
            classList={{ "ourapp-capsule--pop": c.pop }}
            style={{
              left: `${c.left}%`,
              top: `${c.top}%`,
              "animation-duration": `${c.dur}s`,
            }}
            title="+1 кредит"
            onClick={() => pop(c.id)}
          >
            +1
          </button>
        )}
      </For>
    </div>
  )
}

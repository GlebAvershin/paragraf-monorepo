/**
 * OurApp — онбординг-подсказки («стеклянные» плашки в стиле Apple).
 *
 * После авторизации пользователь видит серию подсказок, привязанных к элементам
 * UI (по data-hint-атрибутам). Показ — пачками по 1–2, чтобы не захламлять
 * экран, со стаггером появления; пачка живёт ~10 с и растворяется, дальше
 * следующая. Поведение:
 *   - клик по любой кнопке/ссылке → скрыть ВСЕ подсказки и завершить тур;
 *   - клик по самой подсказке → скрыть только её (когда пачка пуста — следующая);
 *   - появление — плавный fade+blur, исчезновение — растворение.
 * Тур показывается один раз (localStorage ourapp.hints.<tourId>.v1). Каждая
 * плашка стрелкой указывает на элемент, о котором рассказывает.
 */
import { createSignal, For, onCleanup, onMount, type Component } from "solid-js"
import { Portal } from "solid-js/web"

export interface HintDef {
  id: string
  /** CSS-селектор целевого элемента (обычно [data-hint="..."]); можно несколько через запятую. */
  target: string
  title: string
  text: string
  /** Сторона от цели, где встаёт плашка. */
  placement?: "top" | "bottom" | "left" | "right"
  /** Выравнивание вдоль цели (для top/bottom). */
  align?: "start" | "center" | "end"
}

interface HintRect {
  top: number
  left: number
  width: number
  height: number
}

interface ActiveHint extends HintDef {
  rect: HintRect
  leaving: boolean
}

const doneKey = (tourId: string) => `ourapp.hints.${tourId}.v1`

const FADE_MS = 450 // должен совпадать с transition в hint-tour.css
const BATCH_LIFETIME_MS = 10000
const NEXT_BATCH_DELAY_MS = 650

export const HintTour: Component<{ tourId: string; batches: HintDef[][] }> = (props) => {
  let seen = false
  try {
    seen = !!localStorage.getItem(doneKey(props.tourId))
  } catch {}
  if (seen) return null

  const [hints, setHints] = createSignal<ActiveHint[]>([])
  let batchIndex = 0
  let gen = 0 // защита от «стухших» таймеров пачки
  let finished = false
  const timers: number[] = []
  const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms))

  const markDone = () => {
    try {
      localStorage.setItem(doneKey(props.tourId), new Date().toISOString())
    } catch {}
  }

  const rectOf = (selector: string): HintRect | undefined => {
    const el = document.querySelector(selector)
    if (!el) return undefined
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return undefined // скрытый/схлопнутый таргет
    return { top: r.top, left: r.left, width: r.width, height: r.height }
  }

  const finish = () => {
    if (finished) return
    finished = true
    markDone()
  }

  const startBatch = () => {
    if (finished) return
    if (batchIndex >= props.batches.length) {
      finish()
      return
    }
    const g = ++gen
    const defs = props.batches[batchIndex]
    let attempts = 0
    const tryShow = () => {
      if (finished || g !== gen) return
      const found = defs.map((d) => ({ d, rect: rectOf(d.target) }))
      // Асинхронный UI: даём целям до ~2 с на монтирование.
      if (!found.some((f) => f.rect) && attempts < 8) {
        attempts += 1
        later(tryShow, 250)
        return
      }
      const visible = found.filter((f): f is { d: HintDef; rect: HintRect } => !!f.rect)
      if (visible.length === 0) {
        batchIndex += 1
        startBatch()
        return
      }
      setHints(visible.map(({ d, rect }) => ({ ...d, rect, leaving: false })))
      later(() => {
        if (!finished && g === gen) fadeOutBatchAndAdvance()
      }, BATCH_LIFETIME_MS)
    }
    tryShow()
  }

  const advance = () => {
    batchIndex += 1
    later(startBatch, NEXT_BATCH_DELAY_MS)
  }

  const fadeOutBatchAndAdvance = () => {
    gen++
    setHints((list) => list.map((h) => ({ ...h, leaving: true })))
    later(() => {
      setHints([])
      advance()
    }, FADE_MS)
  }

  const dismissHint = (id: string) => {
    if (!hints().some((h) => h.id === id && !h.leaving)) return
    setHints((list) => list.map((h) => (h.id === id ? { ...h, leaving: true } : h)))
    later(() => {
      const rest = hints().filter((h) => h.id !== id)
      setHints(rest)
      if (rest.length === 0 && !finished) {
        gen++
        advance()
      }
    }, FADE_MS)
  }

  const dismissAll = () => {
    if (finished) return
    finish()
    gen++
    setHints((list) => list.map((h) => ({ ...h, leaving: true })))
    later(() => setHints([]), FADE_MS)
  }

  const onPointerDown = (e: PointerEvent) => {
    const t = e.target as Element | null
    if (!t) return
    const hintEl = t.closest("[data-ourapp-hint]")
    if (hintEl) {
      // Клик по плашке гасит только её и не «протекает» в UI под ней.
      e.preventDefault()
      e.stopPropagation()
      dismissHint(hintEl.getAttribute("data-ourapp-hint")!)
      return
    }
    // Клик по любой кнопке/интерактиву — скрыть все подсказки (сам клик работает).
    if (t.closest("button, a, [role='button'], [role='menuitem'], input, textarea, select")) {
      dismissAll()
    }
  }

  const reposition = () => {
    setHints((list) => list.map((h) => ({ ...h, rect: rectOf(h.target) ?? h.rect })))
  }

  onMount(() => {
    document.addEventListener("pointerdown", onPointerDown, { capture: true })
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, { capture: true, passive: true })
    later(startBatch, 1400) // даём странице отрисоваться
  })

  onCleanup(() => {
    timers.forEach((t) => clearTimeout(t))
    document.removeEventListener("pointerdown", onPointerDown, { capture: true })
    window.removeEventListener("resize", reposition)
    window.removeEventListener("scroll", reposition, { capture: true })
  })

  return (
    <Portal>
      <div class="ourapp-hints">
        <For each={hints()}>{(h, i) => <HintBubble hint={h} index={i()} />}</For>
      </div>
    </Portal>
  )
}

const GAP = 12

const HintBubble: Component<{ hint: ActiveHint; index: number }> = (props) => {
  const [shown, setShown] = createSignal(false)
  onMount(() => {
    // Стаггер появления внутри пачки — плашки проявляются одна за другой.
    const t = window.setTimeout(() => setShown(true), 120 + props.index * 320)
    onCleanup(() => clearTimeout(t))
  })

  const placement = () => props.hint.placement ?? "bottom"
  const align = () => props.hint.align ?? "center"

  const style = () => {
    const r = props.hint.rect
    const p = placement()
    let top = 0
    let left = 0
    let transform = ""
    if (p === "bottom" || p === "top") {
      top = p === "bottom" ? r.top + r.height + GAP : r.top - GAP
      const a = align()
      if (a === "center") {
        left = r.left + r.width / 2
        transform = "translateX(-50%)"
      } else if (a === "end") {
        left = r.left + r.width
        transform = "translateX(-100%)"
      } else {
        left = r.left
      }
      if (p === "top") transform += " translateY(-100%)"
    } else {
      top = r.top + r.height / 2
      transform = "translateY(-50%)"
      left = p === "right" ? r.left + r.width + GAP : r.left - GAP
      if (p === "left") transform += " translateX(-100%)"
    }
    return { top: `${Math.round(top)}px`, left: `${Math.round(left)}px`, transform }
  }

  return (
    <div
      class={`ourapp-hint ourapp-hint--${placement()} ourapp-hint--align-${align()}`}
      classList={{
        "ourapp-hint--in": shown() && !props.hint.leaving,
        "ourapp-hint--out": props.hint.leaving,
      }}
      style={style()}
      data-ourapp-hint={props.hint.id}
      role="note"
    >
      <span class="ourapp-hint__arrow" aria-hidden="true" />
      <div class="ourapp-hint__title">{props.hint.title}</div>
      <div class="ourapp-hint__text">{props.hint.text}</div>
    </div>
  )
}

/* ---- Контент туров ---- */

/** Главная: профессия и сценарии → история и аналитика → кредиты и профиль. */
export const HOME_HINTS: HintDef[][] = [
  [
    {
      id: "home-vertical",
      target: '[data-hint="home-vertical"]',
      title: "Профессия",
      text: "Выберите свою специальность — под неё подстроятся сценарии и подсказки Isaac.",
      placement: "bottom",
      align: "start",
    },
    {
      id: "home-scenarios",
      target: '[data-hint="home-scenarios"]',
      title: "Сценарии",
      text: "Готовые пошаговые мастера под типовые задачи. Нажмите на сценарий, чтобы начать.",
      placement: "right",
    },
  ],
  [
    {
      id: "home-history",
      target: '[data-hint="home-nav-history"]',
      title: "История",
      text: "Все ваши сессии: поиск, возврат к работе и экспорт в DOCX, PDF или MD.",
      placement: "bottom",
      align: "start",
    },
    {
      id: "home-analytics",
      target: '[data-hint="home-nav-analytics"]',
      title: "Аналитика",
      text: "Расход кредитов по дням, моделям и сценариям — с выгрузкой в CSV.",
      placement: "bottom",
    },
  ],
  [
    {
      id: "home-credits",
      target: '[data-hint="home-credits"]',
      title: "Кредиты",
      text: "Остаток кредитов на месяц. Нажмите, чтобы открыть тарифы и пополнение.",
      placement: "bottom",
      align: "end",
    },
    {
      id: "home-account",
      target: '[data-hint="home-account"]',
      title: "Профиль",
      text: "Настройки аккаунта: тема оформления, защита данных, выход.",
      placement: "bottom",
      align: "end",
    },
  ],
]

/** Воркспейс: бренд и сценарии в сайдбаре → уровень модели в композере. */
export const WORKSPACE_HINTS: HintDef[][] = [
  [
    {
      id: "ws-brand",
      target: '[data-hint="ws-brand"]',
      title: "На главную",
      text: "Клик по имени Isaac возвращает на главный экран.",
      placement: "bottom",
      align: "start",
    },
    {
      id: "ws-scenarios",
      target: '[data-hint="ws-scenarios"]',
      title: "Сценарии",
      text: "Выберите сценарий — мастер откроется в новой сессии и проведёт по шагам.",
      placement: "right",
    },
  ],
  [
    {
      id: "ws-tier",
      target: '[data-hint="ws-tier"], [data-hint="ws-model"]',
      title: "Уровень модели",
      text: "Сила ИИ под задачу: Medium — быстрые и простые, High — большинство задач, Ultra — сложный анализ.",
      placement: "top",
      align: "start",
    },
  ],
]

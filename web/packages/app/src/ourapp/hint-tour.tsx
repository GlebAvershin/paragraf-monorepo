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
 * Тур показывается один раз ЗА ВХОД (localStorage ourapp.hints.<tourId>.v1):
 * при каждом успешном логине флаги сбрасываются (resetHintTours из
 * onboarding-page), так что подсказки видит каждый вход в аккаунт — даже
 * повторный на том же устройстве. Каждая плашка стрелкой указывает на элемент,
 * о котором рассказывает.
 */
import { createMemo, createSignal, For, onCleanup, onMount, type Component } from "solid-js"
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

const DONE_KEY_PREFIX = "ourapp.hints."
const doneKey = (tourId: string) => `${DONE_KEY_PREFIX}${tourId}.v1`

/**
 * Сбросить флаги «тур просмотрен» — вызывается при успешном входе, чтобы
 * подсказки показывались на каждый логин (а не один раз на устройство).
 */
export function resetHintTours(): void {
  try {
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(DONE_KEY_PREFIX)) stale.push(key)
    }
    stale.forEach((key) => localStorage.removeItem(key))
  } catch {}
}

const FADE_MS = 900 // время растворения (карточка + белые пиксели), см. hint-tour.css
const BATCH_LIFETIME_MS = 15000 // держим подсказки подольше — и на главной, и в воркспейсе
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
const EDGE = 8 // минимальный отступ плашки от края вьюпорта
const PIXEL_COUNT = 18

interface DissolvePixel {
  left: number
  top: number
  dx: number
  dy: number
  delay: number
  size: number
}

const HintBubble: Component<{ hint: ActiveHint; index: number }> = (props) => {
  let el!: HTMLDivElement
  const [shown, setShown] = createSignal(false)
  const [size, setSize] = createSignal<{ w: number; h: number }>()
  onMount(() => {
    // Размер нужен для точного позиционирования и клампа в границы экрана.
    setSize({ w: el.offsetWidth, h: el.offsetHeight })
    // Стаггер появления внутри пачки — плашки проявляются одна за другой.
    const t = window.setTimeout(() => setShown(true), 120 + props.index * 320)
    onCleanup(() => clearTimeout(t))
  })

  const placement = () => props.hint.placement ?? "bottom"
  const align = () => props.hint.align ?? "center"

  const style = () => {
    const s = size()
    // До замера прячем за экраном (плашка и так с opacity 0).
    if (!s) return { top: "-9999px", left: "-9999px" }
    const r = props.hint.rect
    const p = placement()
    let top = 0
    let left = 0
    if (p === "bottom" || p === "top") {
      top = p === "bottom" ? r.top + r.height + GAP : r.top - GAP - s.h
      const a = align()
      if (a === "center") left = r.left + r.width / 2 - s.w / 2
      else if (a === "end") left = r.left + r.width - s.w
      else left = r.left
    } else {
      top = r.top + r.height / 2 - s.h / 2
      left = p === "right" ? r.left + r.width + GAP : r.left - GAP - s.w
    }
    // Кламп в границы вьюпорта — плашка не уезжает за край экрана.
    left = Math.min(Math.max(EDGE, left), window.innerWidth - s.w - EDGE)
    top = Math.min(Math.max(EDGE, top), window.innerHeight - s.h - EDGE)
    return { top: `${Math.round(top)}px`, left: `${Math.round(left)}px` }
  }

  // Растворение «на беленькие пиксели»: при leaving создаём горсть белых
  // квадратиков в случайных точках карточки — они разлетаются вверх и гаснут.
  const pixels = createMemo<DissolvePixel[]>(() => {
    if (!props.hint.leaving) return []
    return Array.from({ length: PIXEL_COUNT }, () => ({
      left: 4 + Math.random() * 92,
      top: 6 + Math.random() * 86,
      dx: (Math.random() - 0.5) * 52,
      dy: -8 - Math.random() * 34,
      delay: Math.random() * 220,
      size: 3 + Math.random() * 2.5,
    }))
  })

  return (
    <div
      ref={el}
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
      <span class="ourapp-hint__pixels" aria-hidden="true">
        <For each={pixels()}>
          {(px) => (
            <span
              class="ourapp-hint__pixel"
              style={{
                left: `${px.left}%`,
                top: `${px.top}%`,
                width: `${px.size}px`,
                height: `${px.size}px`,
                "animation-delay": `${px.delay}ms`,
                "--px-dx": `${px.dx}px`,
                "--px-dy": `${px.dy}px`,
              }}
            />
          )}
        </For>
      </span>
    </div>
  )
}

/* ---- Контент туров ----
 * Пачки собраны так, чтобы плашки одной пачки НЕ перекрывали друг друга:
 * соседние по экрану элементы (История/Аналитика, Кредиты/Профиль) разнесены
 * по разным пачкам и спарены с элементами из другого конца экрана. */

/** Главная: профессия + сценарии → история + кредиты → аналитика + профиль → последние сессии. */
export const HOME_HINTS: HintDef[][] = [
  [
    {
      id: "home-vertical",
      target: '[data-hint="home-vertical"]',
      title: "Профессия",
      text: "Кнопка выбора профессии. От неё зависит, какие сценарии Isaac предложит на главной и в воркспейсе.",
      placement: "bottom",
      align: "start",
    },
    {
      // Плашка встаёт ПОД колонкой сценариев (пустая зона) и указывает вверх на список.
      id: "home-scenarios",
      target: '[data-hint="home-scenarios"]',
      title: "Сценарии",
      text: "Сценарии — готовые формы под типовые рабочие задачи. Выберите сценарий, ответьте на несколько вопросов — и получите готовый результат.",
      placement: "bottom",
      align: "start",
    },
  ],
  [
    {
      id: "home-history",
      target: '[data-hint="home-nav-history"]',
      title: "История",
      text: "Открывает список всех ваших сессий: можно найти нужную по названию, продолжить работу или выгрузить в DOCX, PDF, MD.",
      placement: "bottom",
      align: "start",
    },
    {
      id: "home-credits",
      target: '[data-hint="home-credits"]',
      title: "Кредиты",
      text: "Остаток кредитов на месяц — они списываются за каждый запрос. Клик откроет страницу с тарифами и пополнением.",
      placement: "bottom",
      align: "end",
    },
  ],
  [
    {
      id: "home-analytics",
      target: '[data-hint="home-nav-analytics"]',
      title: "Аналитика",
      text: "Диаграммы расхода кредитов: по дням, по моделям и по сценариям. Отчёт можно выгрузить в CSV.",
      placement: "bottom",
      align: "start",
    },
    {
      id: "home-account",
      target: '[data-hint="home-account"]',
      title: "Профиль",
      text: "Ваш аккаунт. Внутри — тема оформления (светлая/тёмная), настройки защиты данных и кнопка выхода.",
      placement: "bottom",
      align: "end",
    },
  ],
  [
    {
      // ПОД колонкой «Продолжить работу» (пустая зона), не закрывая список и hero.
      id: "home-recent",
      target: '[data-hint="home-recent"]',
      title: "Последние сессии",
      text: "Ваши недавние сессии. Кликните по любой, чтобы вернуться к незавершённой задаче — список прокручивается по всей истории.",
      placement: "bottom",
      align: "end",
    },
  ],
]

/** Воркспейс: бренд и сценарии в сайдбаре → уровень модели в композере. */
export const WORKSPACE_HINTS: HintDef[][] = [
  [
    {
      // Компактная плашка (короткий текст), чтобы минимально накрывать сайдбар.
      id: "ws-brand",
      target: '[data-hint="ws-brand"]',
      title: "На главную",
      text: "Клик по «Isaac» — возврат на главную.",
      placement: "bottom",
      align: "start",
    },
    {
      // Справа от секции сценариев — над пустой зоной чата, не над сайдбаром.
      id: "ws-scenarios",
      target: '[data-hint="ws-scenarios"]',
      title: "Сценарии",
      text: "Список сценариев: клик открывает выбранный сценарий в новой сессии — останется заполнить несколько полей.",
      placement: "right",
    },
  ],
  [
    {
      id: "ws-tier",
      target: '[data-hint="ws-tier"], [data-hint="ws-model"]',
      title: "Уровень модели",
      text: "Выбор уровня модели под задачу: Medium — быстрые простые запросы, High — большинство задач, Ultra — глубокий анализ. Менять можно перед каждым запросом.",
      placement: "top",
      align: "start",
    },
  ],
]

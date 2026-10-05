/**
 * Публичный маркетинговый лендинг Isaac (`/landing`). Позиционирование —
 * инфраструктура и единый доступ бизнеса ко всем сильнейшим нейросетям (см. copy.ts).
 *
 * Композиция: статичный фон за контентом, верхняя навигация,
 * секции-истории (проблема → платформа →
 * модели → возможности → результаты → механизм сценариев → примеры → доступ) и
 * waitlist-CTA. Секции полупрозрачны — «мир» виден за ними и всегда в кадре.
 *
 * DEFAULT-экспорт: страницу грузит `entry.tsx` через
 * `lazy(() => import("@/ourapp/landing/landing-page"))` при пути `/landing`.
 * Server/session-провайдеры сюда НЕ приходят — только базовые (тема/шрифты/мета).
 *
 * `.isaac-lp-reveal` появляются при прокрутке (IntersectionObserver),
 * счётчики результатов считаются вверх. Прокрутка
 * берётся у контейнера `.isaac-lp` (лендинг скроллится внутри него), фолбэк — окно.
 * Всё под `prefers-reduced-motion` — статичная читаемая страница.
 */
import { Meta, Title } from "@solidjs/meta"
import { For, onCleanup, onMount, Show } from "solid-js"
import { ACCESS, ENGINE, EXAMPLES, FEATURES, FOOTER, HERO, MODELS, NAV, PILLARS, PROBLEM, RESULTS } from "./copy"
import { WaitlistForm } from "./waitlist-form"
import "./landing.css"

function FeatureIcon(props: { name: string }) {
  return (
    <Show when={props.name === "analytics"} fallback={<FeatureIconRest name={props.name} />}>
      <svg viewBox="0 0 24 24">
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </svg>
    </Show>
  )
}

function FeatureIconRest(props: { name: string }) {
  return (
    <>
      <Show when={props.name === "files"}>
        <svg viewBox="0 0 24 24">
          <path d="M14 3v5h5" />
          <path d="M6 3h8l5 5v13H6z" />
        </svg>
      </Show>
      <Show when={props.name === "team"}>
        <svg viewBox="0 0 24 24">
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20c0-3 3-5 6-5s6 2 6 5" />
          <circle cx="18" cy="9" r="2.4" />
          <path d="M16 20c0-2.5 2-4 4-4" />
        </svg>
      </Show>
      <Show when={props.name === "shield"}>
        <svg viewBox="0 0 24 24">
          <path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      </Show>
      <Show when={props.name === "billing"}>
        <svg viewBox="0 0 24 24">
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="M3 10h18" />
        </svg>
      </Show>
      <Show when={props.name === "history"}>
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
      </Show>
    </>
  )
}

function fmtCount(v: number, dec: number): string {
  const s = dec ? v.toFixed(dec) : Math.round(v).toString()
  return dec ? s.replace(".", ",") : s
}

export default function LandingPage() {
  let rootEl: HTMLElement | undefined

  onMount(() => {
    const root = rootEl
    if (!root) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const hasIO = "IntersectionObserver" in window

    // Секции и элементы всплывают снизу.
    const revs = Array.from(root.querySelectorAll<HTMLElement>(".isaac-lp-reveal"))
    if (!reduce && hasIO) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add("is-in")
              io.unobserve(e.target)
            }
          }
        },
        { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
      )
      for (const el of revs) io.observe(el)
      onCleanup(() => io.disconnect())
    } else {
      for (const el of revs) el.classList.add("is-in")
    }

    // Счётчики результатов считаются вверх при появлении.
    const countUp = (el: HTMLElement) => {
      const target = parseFloat(el.dataset.value ?? "0") || 0
      const dec = parseInt(el.dataset.decimals ?? "0", 10)
      const pre = el.dataset.prefix ?? ""
      const suf = el.dataset.suffix ?? ""
      if (reduce) {
        el.textContent = pre + fmtCount(target, dec) + suf
        return
      }
      const dur = 1300
      let t0: number | null = null
      const tick = (ts: number) => {
        if (t0 === null) t0 = ts
        const p = Math.min((ts - t0) / dur, 1)
        const e = 1 - Math.pow(1 - p, 3)
        el.textContent = pre + fmtCount(target * e, dec) + suf
        if (p < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }
    const stats = Array.from(root.querySelectorAll<HTMLElement>(".isaac-lp-stat__v"))
    if (hasIO) {
      const sio = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              countUp(e.target as HTMLElement)
              sio.unobserve(e.target)
            }
          }
        },
        { threshold: 0.5 },
      )
      for (const el of stats) sio.observe(el)
      onCleanup(() => sio.disconnect())
    } else {
      for (const el of stats) countUp(el)
    }

    // Прокрутка: nav-состояние и скрытие подсказки.
    const nav = root.querySelector(".isaac-lp-nav")
    const onScroll = () => {
      const y = root.scrollTop || window.scrollY
      nav?.classList.toggle("is-scrolled", y > 40)
      root.classList.toggle("is-hidehint", y > 120)
    }
    root.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    onCleanup(() => {
      root.removeEventListener("scroll", onScroll)
      window.removeEventListener("scroll", onScroll)
    })
  })

  return (
    <main class="isaac-lp" ref={rootEl}>
      <Title>Isaac — инфраструктура ИИ для бизнеса</Title>
      <Meta
        name="description"
        content="Isaac подключает бизнес к самым сильным нейросетям мира: единый доступ ко всем моделям, готовая инфраструктура (аналитика, файлы, команды) и механизм сценариев. Помогаем бизнесу работать с ИИ эффективно."
      />

      <div class="isaac-lp-world" aria-hidden="true" />

      <header class="isaac-lp-nav">
        <a class="isaac-lp-nav__brand" href="#top">
          Isaac
        </a>
        <nav class="isaac-lp-nav__links" aria-label="Разделы">
          <For each={NAV}>{(l) => <a href={l.href}>{l.label}</a>}</For>
        </nav>
        <div class="isaac-lp-nav__cta">
          <a class="isaac-lp-nav__login" href="/">
            {HERO.login}
          </a>
          <a class="isaac-lp-btn isaac-lp-btn--primary" href="#access">
            {HERO.ctaPrimary}
          </a>
        </div>
      </header>

      <span id="top" />

      {/* Hero */}
      <section class="isaac-lp-hero">
        <div class="isaac-lp-flow">
          <span class="isaac-lp-eyebrow isaac-lp-reveal is-in">{HERO.eyebrow}</span>
          <h1 class="isaac-lp-hero__h1 isaac-lp-reveal is-in">
            {HERO.h1Lead} <span class="isaac-lp-hero__accent">{HERO.h1Accent}</span>
          </h1>
          <p class="isaac-lp-hero__sub isaac-lp-reveal is-in isaac-lp-d1">{HERO.sub}</p>
          <div class="isaac-lp-hero__cta isaac-lp-reveal is-in isaac-lp-d2">
            <a class="isaac-lp-btn isaac-lp-btn--primary isaac-lp-btn--lg" href="#access">
              {HERO.ctaPrimary}
            </a>
            <a class="isaac-lp-btn isaac-lp-btn--ghost isaac-lp-btn--lg" href="#platform">
              {HERO.ctaSecondary}
            </a>
          </div>
          <div class="isaac-lp-ticker isaac-lp-reveal is-in isaac-lp-d3">
            <For each={HERO.ticker}>
              {(t) => (
                <div class="isaac-lp-ticker__item">
                  <b>{t.v}</b>
                  <span class="isaac-lp-mono">{t.label}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </section>

      {/* 01 — Проблема */}
      <section id="problem" class="isaac-lp-section">
        <div class="isaac-lp-flow">
          <SectionHead num={PROBLEM.num} eyebrow="Проблема" title={PROBLEM.title} lede={PROBLEM.lede} />
          <div class="isaac-lp-cards3">
            <For each={PROBLEM.points}>
              {(p, i) => (
                <div class="isaac-lp-pcard isaac-lp-glass isaac-lp-reveal" classList={{ [`isaac-lp-d${i()}`]: i() > 0 }}>
                  <span class="isaac-lp-mono isaac-lp-pcard__k">{p.k}</span>
                  <h3 class="isaac-lp-pcard__title">{p.title}</h3>
                  <p class="isaac-lp-pcard__desc">{p.desc}</p>
                </div>
              )}
            </For>
          </div>
        </div>
      </section>

      {/* 02 — Платформа */}
      <section id="platform" class="isaac-lp-section">
        <div class="isaac-lp-flow">
          <SectionHead num={PILLARS.num} eyebrow="Платформа" title={PILLARS.title} lede={PILLARS.lede} />
          <div class="isaac-lp-pillars">
            <For each={PILLARS.items}>
              {(it, i) => (
                <div class="isaac-lp-pillar isaac-lp-glass isaac-lp-reveal" classList={{ [`isaac-lp-d${i()}`]: i() > 0 }}>
                  <span class="isaac-lp-mono isaac-lp-pillar__num">{it.num}</span>
                  <div class="isaac-lp-pillar__ic">
                    <PillarIcon idx={i()} />
                  </div>
                  <h3 class="isaac-lp-pillar__title">{it.title}</h3>
                  <p class="isaac-lp-pillar__desc">{it.desc}</p>
                </div>
              )}
            </For>
          </div>
        </div>
      </section>

      {/* 03 — Модели */}
      <section id="models" class="isaac-lp-section">
        <div class="isaac-lp-flow">
          <SectionHead num={MODELS.num} eyebrow="Модели" title={MODELS.title} lede={MODELS.lede} />
          <div class="isaac-lp-models">
            <div class="isaac-lp-tiers isaac-lp-glass isaac-lp-reveal">
              <For each={MODELS.tiers}>
                {(tier) => (
                  <div class="isaac-lp-tier">
                    <span class="isaac-lp-mono isaac-lp-tier__name">{tier.name}</span>
                    <span class="isaac-lp-tier__bar">
                      <i style={{ "--w": tier.w }} />
                    </span>
                    <span class="isaac-lp-tier__note">{tier.note}</span>
                  </div>
                )}
              </For>
            </div>
            <div class="isaac-lp-chips isaac-lp-glass isaac-lp-reveal isaac-lp-d1">
              <For each={MODELS.chips}>{(c) => <span class="isaac-lp-mono isaac-lp-chip">{c}</span>}</For>
              <span class="isaac-lp-chips__note">{MODELS.note}</span>
            </div>
          </div>
        </div>
      </section>

      {/* 04 — Возможности */}
      <section id="features" class="isaac-lp-section">
        <div class="isaac-lp-flow">
          <SectionHead num={FEATURES.num} eyebrow="Возможности" title={FEATURES.title} lede={FEATURES.lede} />
          <div class="isaac-lp-features">
            <For each={FEATURES.cards}>
              {(c, i) => (
                <div class="isaac-lp-feat isaac-lp-glass isaac-lp-reveal" classList={{ [`isaac-lp-d${i() % 3}`]: i() % 3 > 0 }}>
                  <div class="isaac-lp-feat__ic">
                    <FeatureIcon name={c.icon} />
                  </div>
                  <h3 class="isaac-lp-feat__title">{c.title}</h3>
                  <p class="isaac-lp-feat__desc">{c.desc}</p>
                </div>
              )}
            </For>
          </div>
        </div>
      </section>

      {/* 05 — Результат */}
      <section id="results" class="isaac-lp-section">
        <div class="isaac-lp-flow">
          <SectionHead num={RESULTS.num} eyebrow="Результат" title={RESULTS.title} />
          <div class="isaac-lp-stats isaac-lp-reveal isaac-lp-d1">
            <div class="isaac-lp-stats__grid">
              <For each={RESULTS.stats}>
                {(s) => (
                  <div class="isaac-lp-stat">
                    <div
                      class="isaac-lp-stat__v"
                      data-prefix={s.prefix ?? ""}
                      data-value={String(s.value)}
                      data-decimals={String(s.decimals ?? 0)}
                      data-suffix={s.suffix ?? ""}
                    >
                      {s.prefix ?? ""}0{s.suffix ?? ""}
                    </div>
                    <div class="isaac-lp-stat__l">{s.label}</div>
                  </div>
                )}
              </For>
            </div>
            <div class="isaac-lp-mono isaac-lp-stats__disc">{RESULTS.disc}</div>
          </div>
        </div>
      </section>

      {/* 06 — Механизм сценариев */}
      <section id="engine" class="isaac-lp-section">
        <div class="isaac-lp-flow">
          <SectionHead num={ENGINE.num} eyebrow="Сценарии" title={ENGINE.title} lede={ENGINE.lede} />
          <div class="isaac-lp-steps isaac-lp-glass isaac-lp-reveal isaac-lp-d1">
            <For each={ENGINE.steps}>
              {(s, i) => (
                <div class="isaac-lp-step">
                  <span class="isaac-lp-mono isaac-lp-step__n">{s.n}</span>
                  <h3 class="isaac-lp-step__title">{s.title}</h3>
                  <p class="isaac-lp-step__desc">{s.desc}</p>
                  <Show when={i() < ENGINE.steps.length - 1}>
                    <span class="isaac-lp-step__arrow" aria-hidden="true">
                      →
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </section>

      {/* 07 — Примеры сценариев (частные случаи) */}
      <section id="scenarios" class="isaac-lp-section">
        <div class="isaac-lp-flow">
          <SectionHead num={EXAMPLES.num} eyebrow="Примеры" title={EXAMPLES.title} lede={EXAMPLES.lede} />
          <div class="isaac-lp-scen isaac-lp-reveal isaac-lp-d1">
            <For each={EXAMPLES.cards}>
              {(c) => (
                <div class="isaac-lp-scen__item">
                  <span class="isaac-lp-mono isaac-lp-scen__tag">{c.tag}</span>
                  <h4 class="isaac-lp-scen__title">{c.title}</h4>
                  <Show when={c.soon}>
                    <span class="isaac-lp-mono isaac-lp-scen__soon">{EXAMPLES.soonBadge}</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </section>

      {/* 08 — Доступ */}
      <section id="access" class="isaac-lp-section">
        <div class="isaac-lp-flow">
          <div class="isaac-lp-access isaac-lp-glass isaac-lp-reveal">
            <span class="isaac-lp-eyebrow isaac-lp-access__eyebrow">{ACCESS.num} — Доступ</span>
            <h2 class="isaac-lp-access__title">{ACCESS.title}</h2>
            <p class="isaac-lp-access__lede">{ACCESS.lede}</p>
            <WaitlistForm />
            <p class="isaac-lp-access__fine">{ACCESS.fine}</p>
          </div>
        </div>
      </section>

      <footer class="isaac-lp-footer">
        <div class="isaac-lp-footer__brand">{FOOTER.brand}</div>
        <span class="isaac-lp-mono isaac-lp-footer__rights">{FOOTER.rights}</span>
      </footer>

      <div class="isaac-lp-hint" aria-hidden="true">
        Листайте
        <i />
      </div>
    </main>
  )
}

function SectionHead(props: { num: string; eyebrow: string; title: string; lede?: string }) {
  return (
    <div class="isaac-lp-head isaac-lp-reveal">
      <span class="isaac-lp-eyebrow">
        {props.num} — {props.eyebrow}
      </span>
      <h2 class="isaac-lp-head__title">{props.title}</h2>
      <Show when={props.lede}>
        <p class="isaac-lp-head__lede">{props.lede}</p>
      </Show>
    </div>
  )
}

function PillarIcon(props: { idx: number }) {
  return (
    <>
      <Show when={props.idx === 0}>
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3" />
        </svg>
      </Show>
      <Show when={props.idx === 1}>
        <svg viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="5" rx="1.5" />
          <rect x="3" y="12" width="18" height="8" rx="1.5" />
          <path d="M7 16.5h5" />
        </svg>
      </Show>
      <Show when={props.idx === 2}>
        <svg viewBox="0 0 24 24">
          <path d="M4 6h10M4 12h16M4 18h7" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="14" cy="18" r="2" />
        </svg>
      </Show>
    </>
  )
}

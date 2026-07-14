/**
 * Публичный маркетинговый лендинг Isaac (`/landing`). Композиция страницы:
 * hero с WebGL-фоном (lazy-чанк three.js), левый chapter-rail 01–05 с подсветкой
 * активной секции, секции-истории (проблема → сценарии → как отвечает → данные →
 * доступ) и waitlist-CTA в финале.
 *
 * DEFAULT-экспорт: страницу подгружает `entry.tsx` через
 * `lazy(() => import("@/ourapp/landing/landing-page"))` при пути `/landing`.
 * Server/session-провайдеры сюда НЕ приходят — только базовые (тема/шрифты/мета)
 * из `AppBaseProviders`.
 *
 * Namespace классов — `.isaac-lp-*` (не `.ourapp-landing`, который занят
 * залогиненной главной). Скролл-хореография входов — CSS (`landing.css`),
 * подсветка rail — IntersectionObserver (мягко деградирует: без него rail просто
 * без активного пункта).
 */
import { Meta, Title } from "@solidjs/meta"
import { createSignal, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import { ACCESS, CHAPTERS, DATA, FOOTER, HERO, HOW, PROBLEM, SCENARIOS } from "./copy"
import { WaitlistForm } from "./waitlist-form"
import "./landing.css"

const ThreeHero = lazy(() => import("./three-hero"))

export default function LandingPage() {
  const [active, setActive] = createSignal(CHAPTERS[0]?.id ?? "")

  onMount(() => {
    const sections = CHAPTERS.map((c) => document.getElementById(c.id)).filter(
      (el): el is HTMLElement => el !== null,
    )
    if (sections.length === 0 || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id)
        }
      },
      // Активна секция, чья верхняя треть в кадре.
      { rootMargin: "-35% 0px -60% 0px", threshold: 0 },
    )
    for (const el of sections) observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  const scrollTo = (id: string) => (e: Event) => {
    e.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <main class="isaac-lp">
      <Title>Isaac — ИИ-инженер по стандартам ГОСТ</Title>
      <Meta
        name="description"
        content="Isaac находит, разъясняет и проверяет документы по ГОСТ. Пошаговые инженерные сценарии с проверкой каждого ответа. Для инженеров-технологов, РФ и СНГ."
      />

      <header class="isaac-lp-topbar">
        <span class="isaac-lp-topbar__brand">Isaac</span>
        <a class="isaac-lp-topbar__login" href="/">
          {HERO.ctaSecondary}
        </a>
      </header>

      <nav class="isaac-lp-rail" aria-label="Разделы">
        <For each={CHAPTERS}>
          {(ch) => (
            <a
              class="isaac-lp-rail__item"
              classList={{ "is-active": active() === ch.id }}
              href={`#${ch.id}`}
              onClick={scrollTo(ch.id)}
            >
              <span class="isaac-lp-mono isaac-lp-rail__num">{ch.num}</span>
              <span class="isaac-lp-rail__label">{ch.rail}</span>
            </a>
          )}
        </For>
      </nav>

      {/* Hero */}
      <section class="isaac-lp-hero">
        <Suspense>
          <ThreeHero />
        </Suspense>
        <div class="isaac-lp-hero__content">
          <span class="isaac-lp-mono isaac-lp-hero__eyebrow">{HERO.eyebrow}</span>
          <h1 class="isaac-lp-hero__h1">
            {HERO.h1Lead} <span class="isaac-lp-mono isaac-lp-hero__accent">{HERO.h1Accent}</span>.
          </h1>
          <p class="isaac-lp-hero__sub">{HERO.sub}</p>
          <div class="isaac-lp-hero__cta">
            <a class="isaac-lp-btn isaac-lp-btn--primary" href="#access" onClick={scrollTo("access")}>
              {HERO.ctaPrimary}
            </a>
            <a class="isaac-lp-btn isaac-lp-btn--ghost" href="/">
              {HERO.ctaSecondary}
            </a>
          </div>
          <span class="isaac-lp-mono isaac-lp-hero__audience">{HERO.audience}</span>
        </div>
      </section>

      {/* 01 — Проблема */}
      <section id="problem" class="isaac-lp-section isaac-lp-section--problem">
        <SectionHead num={PROBLEM.num} title={PROBLEM.title} lede={PROBLEM.lede} />
        <div class="isaac-lp-problem__grid">
          <For each={PROBLEM.points}>
            {(p) => (
              <div class="isaac-lp-problem__item isaac-lp-reveal">
                <span class="isaac-lp-mono isaac-lp-problem__k">{p.k}</span>
                <p class="isaac-lp-problem__v">{p.v}</p>
              </div>
            )}
          </For>
        </div>
      </section>

      {/* 02 — Сценарии */}
      <section id="scenarios" class="isaac-lp-section isaac-lp-section--scenarios">
        <SectionHead num={SCENARIOS.num} title={SCENARIOS.title} lede={SCENARIOS.lede} />
        <div class="isaac-lp-scen__grid">
          <For each={SCENARIOS.cards}>
            {(c) => (
              <article class="isaac-lp-scen__card isaac-lp-reveal" classList={{ "is-soon": c.soon }}>
                <div class="isaac-lp-scen__tags">
                  <span class="isaac-lp-mono isaac-lp-scen__tag">{c.tag}</span>
                  <Show when={c.soon}>
                    <span class="isaac-lp-mono isaac-lp-scen__soon">{SCENARIOS.soonBadge}</span>
                  </Show>
                </div>
                <h3 class="isaac-lp-scen__title">{c.title}</h3>
                <p class="isaac-lp-scen__desc">{c.desc}</p>
              </article>
            )}
          </For>
        </div>
      </section>

      {/* 03 — Как отвечает */}
      <section id="how" class="isaac-lp-section isaac-lp-section--how">
        <SectionHead num={HOW.num} title={HOW.title} lede={HOW.lede} />
        <div class="isaac-lp-how__grid">
          <div class="isaac-lp-how__cell isaac-lp-how__cell--wide isaac-lp-reveal">
            <h3 class="isaac-lp-how__title">{HOW.grounding.title}</h3>
            <p class="isaac-lp-how__desc">{HOW.grounding.desc}</p>
          </div>
          <div class="isaac-lp-how__cell isaac-lp-reveal">
            <h3 class="isaac-lp-how__title">{HOW.verify.title}</h3>
            <p class="isaac-lp-how__desc">{HOW.verify.desc}</p>
          </div>
          <div class="isaac-lp-how__cell isaac-lp-how__cell--levels isaac-lp-reveal">
            <h3 class="isaac-lp-how__title">{HOW.levels.title}</h3>
            <p class="isaac-lp-how__desc">{HOW.levels.desc}</p>
            <ul class="isaac-lp-how__tiers">
              <For each={HOW.levels.tiers}>
                {(tier) => (
                  <li class="isaac-lp-how__tier">
                    <span class="isaac-lp-mono isaac-lp-how__tier-name">{tier.name}</span>
                    <span class="isaac-lp-how__tier-note">{tier.note}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </div>
      </section>

      {/* 04 — Данные (152-ФЗ) */}
      <section id="data" class="isaac-lp-section isaac-lp-section--data">
        <SectionHead num={DATA.num} title={DATA.title} lede={DATA.lede} />
        <div class="isaac-lp-data__flow">
          <For each={DATA.steps}>
            {(s, idx) => (
              <>
                <div class="isaac-lp-data__node isaac-lp-reveal">
                  <span class="isaac-lp-mono isaac-lp-data__k">{s.k}</span>
                  <p class="isaac-lp-data__v">{s.v}</p>
                </div>
                <Show when={idx() < DATA.steps.length - 1}>
                  <span class="isaac-lp-data__arrow isaac-lp-mono" aria-hidden="true">
                    →
                  </span>
                </Show>
              </>
            )}
          </For>
        </div>
      </section>

      {/* 05 — Доступ (waitlist) */}
      <section id="access" class="isaac-lp-section isaac-lp-section--access">
        <div class="isaac-lp-access__inner">
          <SectionHead num={ACCESS.num} title={ACCESS.title} lede={ACCESS.lede} />
          <WaitlistForm />
          <p class="isaac-lp-access__soon">{ACCESS.soon}</p>
        </div>
      </section>

      <footer class="isaac-lp-footer">
        <div class="isaac-lp-footer__brand">
          <span class="isaac-lp-footer__name">{FOOTER.brand}</span>
          <span class="isaac-lp-mono isaac-lp-footer__tag">{FOOTER.tagline}</span>
        </div>
        <span class="isaac-lp-footer__rights">{FOOTER.rights}</span>
      </footer>
    </main>
  )
}

function SectionHead(props: { num: string; title: string; lede: string }) {
  return (
    <div class="isaac-lp-head isaac-lp-reveal">
      <span class="isaac-lp-mono isaac-lp-head__num">{props.num} /</span>
      <h2 class="isaac-lp-head__title">{props.title}</h2>
      <p class="isaac-lp-head__lede">{props.lede}</p>
    </div>
  )
}

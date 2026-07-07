/**
 * OurApp — простой SVG bar-chart (ТЗ-05 §6).
 *
 * Без зависимостей — нативный SVG. Подходит для дашборда расхода кредитов
 * по дням. Использует наш emerald accent. Hover — тултип с значением.
 */
import { For, Show, createMemo, createSignal, type Component } from "solid-js"

export interface BarChartProps {
  data: Array<{ label: string; value: number }>
  height?: number
  /** Подпись Y-axis для тултипа, напр. «кредитов». */
  unit?: string
  /** Форматтер метки — по умолчанию as-is. */
  formatLabel?: (label: string) => string
}

export const BarChart: Component<BarChartProps> = (props) => {
  const height = () => props.height ?? 180
  const max = () => Math.max(1, ...props.data.map((d) => d.value))
  const [hover, setHover] = createSignal<number | null>(null)

  const total = createMemo(() => props.data.reduce((s, d) => s + d.value, 0))

  const formatLabel = (l: string) => (props.formatLabel ? props.formatLabel(l) : l)

  // Постоянная подпись под графиком вместо тултипа по наведению (было —
  // значение видно только при hover, неудобно). По умолчанию — последний
  // (самый свежий) день; при наведении переключается на наведённый бар.
  const activeIndex = createMemo(() => hover() ?? props.data.length - 1)
  const activeDay = createMemo(() => props.data[activeIndex()])

  return (
    <Show
      when={props.data.length > 0}
      fallback={<div class="ourapp-chart-empty">Нет данных за период</div>}
    >
      <div class="ourapp-chart">
        <svg
          class="ourapp-chart__svg"
          viewBox={`0 0 ${props.data.length * 24} ${height()}`}
          preserveAspectRatio="none"
          aria-label="График расхода"
        >
          <For each={props.data}>
            {(d, i) => {
              const h = (d.value / max()) * (height() - 24)
              return (
                <g
                  class="ourapp-chart__bar"
                  classList={{ "ourapp-chart__bar--hover": hover() === i() }}
                  onMouseEnter={() => setHover(i())}
                  onMouseLeave={() => setHover(null)}
                >
                  <rect
                    x={i() * 24 + 4}
                    y={height() - h - 4}
                    width={16}
                    height={Math.max(1, h)}
                    rx={2}
                  />
                </g>
              )
            }}
          </For>
        </svg>
        <div class="ourapp-chart__labels">
          <span>{formatLabel(props.data[0]?.label ?? "")}</span>
          <span>{formatLabel(props.data[props.data.length - 1]?.label ?? "")}</span>
        </div>
        <div class="ourapp-chart__readout">
          <span class="ourapp-chart__readoutDay">
            <span class="ourapp-chart__readoutDate">{formatLabel(activeDay()?.label ?? "")}</span>
            <span class="ourapp-chart__readoutValue">
              {activeDay()?.value ?? 0} {props.unit ?? ""}
            </span>
          </span>
          <span class="ourapp-chart__total">Итого: {total()} {props.unit ?? ""}</span>
        </div>
      </div>
    </Show>
  )
}

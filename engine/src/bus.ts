/**
 * In-process шина событий: публикуем события домена per-userId, SSE-эндпоинт их дренит.
 * Формы событий — контракт opencode (message.updated / message.part.updated / session.* ).
 * Один процесс на всех; изоляция по userId (события юзера видит только его SSE-канал).
 */
export type BusEvent = { type: string; properties?: Record<string, unknown> }

type Listener = (e: BusEvent) => void

const listeners = new Map<string, Set<Listener>>()

export function publish(userId: string, event: BusEvent): void {
  const set = listeners.get(userId)
  if (!set) return
  for (const l of set) l(event)
}

/** Подписка для SSE: возвращает асинхронный итератор событий + функцию отписки. */
export function subscribe(userId: string): { events: AsyncIterable<BusEvent>; close: () => void } {
  const queue: BusEvent[] = []
  let wake: (() => void) | null = null
  let closed = false

  const listener: Listener = (e) => {
    queue.push(e)
    wake?.()
  }
  const set = listeners.get(userId) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(userId, set)

  const close = () => {
    closed = true
    set.delete(listener)
    if (set.size === 0) listeners.delete(userId)
    wake?.()
  }

  const events: AsyncIterable<BusEvent> = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => (wake = resolve))
          wake = null
          continue
        }
        yield queue.shift()!
      }
    },
  }

  return { events, close }
}

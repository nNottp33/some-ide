export type Listener<T> = (event: T) => void
export type Disposer = () => void

/** Minimal typed event emitter. `on` returns a function that removes the listener. */
export class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>()

  on(listener: Listener<T>): Disposer {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

/** Returns a debounced version of `fn` plus a `flush` to run any pending call now. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: A | undefined
  const debounced = (...args: A) => {
    pending = args
    clearTimeout(timer)
    timer = setTimeout(debounced.flush, ms)
  }
  debounced.flush = () => {
    clearTimeout(timer)
    if (!pending) return
    const args = pending
    pending = undefined
    fn(...args)
  }
  return debounced
}

import { accessSync, constants, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Find an executable on PATH (like the `which` CLI). */
export function which(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

/** Data directory of the daemon: $SOMED_HOME or ~/.some-ide/somed. */
export function dataDir(): string {
  const dir = process.env.SOMED_HOME && process.env.SOMED_HOME.length > 0
    ? process.env.SOMED_HOME
    : join(homedir(), '.some-ide', 'somed')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function nowMs(): number {
  return Date.now()
}

/** Minimal typed event emitter (no Node EventEmitter typing hassle). */
export class Emitter<T> {
  #listeners = new Set<(value: T) => void>()
  on(listener: (value: T) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  fire(value: T): void {
    for (const l of [...this.#listeners]) l(value)
  }
  get size(): number {
    return this.#listeners.size
  }
  clear(): void {
    this.#listeners.clear()
  }
}

export function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

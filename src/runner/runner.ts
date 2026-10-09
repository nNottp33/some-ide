import { Emitter } from '../core/emitter'
import type { RunnerMessage, RunRequest } from './protocol'

export type ProgramRuntime = 'javascript' | 'python'

export type RunEvent =
  | RunnerMessage
  | { type: 'start'; entry: string; runtime: ProgramRuntime }
  | { type: 'stopped' }

/** Owns the runner workers and turns their messages into `RunEvent`s for the UI. */
export class Runner {
  readonly onEvent = new Emitter<RunEvent>()
  private jsWorker: Worker | null = null
  /** Kept between runs because loading Pyodide takes a few seconds. */
  private pyWorker: Worker | null = null
  private active: { entry: string; runtime: ProgramRuntime } | null = null

  get running(): boolean {
    return this.active !== null
  }

  get current(): { entry: string; runtime: ProgramRuntime } | null {
    return this.active
  }

  run(runtime: ProgramRuntime, entry: string, files: Record<string, string>, stdin: string): void {
    if (this.active) this.stop()
    this.disposeJsWorker()
    const worker = runtime === 'javascript' ? this.createJsWorker() : this.getPyWorker()
    this.active = { entry, runtime }
    this.onEvent.emit({ type: 'start', entry, runtime })
    worker.postMessage({ type: 'run', entry, files, stdin } satisfies RunRequest)
  }

  stop(): void {
    if (!this.active) return
    if (this.active.runtime === 'javascript') {
      this.disposeJsWorker()
    } else {
      this.pyWorker?.terminate()
      this.pyWorker = null
    }
    this.active = null
    this.onEvent.emit({ type: 'stopped' })
  }

  dispose(): void {
    this.disposeJsWorker()
    this.pyWorker?.terminate()
    this.pyWorker = null
  }

  private createJsWorker(): Worker {
    const worker = new Worker(new URL('./js-worker.ts', import.meta.url), { type: 'module', name: 'run-javascript' })
    this.wire(worker, 'javascript')
    this.jsWorker = worker
    return worker
  }

  private getPyWorker(): Worker {
    if (!this.pyWorker) {
      this.pyWorker = new Worker(new URL('./py-worker.ts', import.meta.url), { type: 'module', name: 'run-python' })
      this.wire(this.pyWorker, 'python')
    }
    return this.pyWorker
  }

  private disposeJsWorker(): void {
    this.jsWorker?.terminate()
    this.jsWorker = null
  }

  private wire(worker: Worker, runtime: ProgramRuntime): void {
    worker.onmessage = (event: MessageEvent<RunnerMessage>) => {
      const message = event.data
      if (message.type === 'done') {
        this.active = null
        if (runtime === 'javascript' && worker === this.jsWorker) this.disposeJsWorker()
      }
      this.onEvent.emit(message)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      this.onEvent.emit({ type: 'console', level: 'error', text: `Runner failed: ${event.message || 'unknown error'}` })
      if (runtime === 'python') {
        this.pyWorker?.terminate()
        this.pyWorker = null
      } else {
        this.disposeJsWorker()
      }
      this.active = null
      this.onEvent.emit({ type: 'done', ok: false, ms: 0 })
    }
  }
}

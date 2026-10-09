/** Messages exchanged between the IDE and the runner workers / preview frame. */

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'input' | 'system'

export interface RunRequest {
  type: 'run'
  entry: string
  files: Record<string, string>
  /** Text from the Input box; each line answers one `input()` / `prompt()` call. */
  stdin: string
}

export type RunnerMessage =
  | { type: 'console'; level: ConsoleLevel; text: string; indent?: number }
  | { type: 'clear' }
  | { type: 'status'; text: string }
  | { type: 'done'; ok: boolean; ms: number }

/** Posted by the preview iframe; `source` distinguishes it from other postMessage traffic. */
export interface PreviewMessage {
  source: 'some-ide-preview'
  level: ConsoleLevel
  text: string
}

/** The parts of a dedicated worker's global scope the runners use (avoids pulling in the WebWorker lib). */
export interface WorkerScope {
  postMessage(message: RunnerMessage): void
  onmessage: ((event: MessageEvent<RunRequest>) => void) | null
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  addEventListener(type: 'unhandledrejection', listener: (event: PromiseRejectionEvent) => void): void
  location: { href: string }
}

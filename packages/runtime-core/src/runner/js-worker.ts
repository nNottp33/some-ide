/**
 * Runs a JavaScript/TypeScript entry file in a dedicated module worker.
 * A fresh worker is created per run, so "Stop" is simply `worker.terminate()`.
 */
import { formatArgs, formatTable, inspect } from './inspect'
import { linkModules } from './modules'
import type { ConsoleLevel, RunnerMessage, RunRequest, WorkerScope } from './protocol'

const scope = self as unknown as WorkerScope
const post = (message: RunnerMessage) => scope.postMessage(message)
// Captured before user code runs: `trackAsyncWork` replaces the global later.
const nativeSetTimeout = setTimeout

let stdinLines: string[] = []
let groupDepth = 0
const blobToPath = new Map<string, string>()

const print = (level: ConsoleLevel, text: string) => post({ type: 'console', level, text, indent: groupDepth })

/**
 * Under `vite dev` the HMR client also runs inside this worker. Its logs and timers are not
 * the user's program, so they must not show up in the console or keep the program "running".
 */
const fromViteClient = import.meta.env.DEV ? () => (new Error().stack ?? '').includes('/@vite/client') : () => false

/** Replaces blob: URLs with project paths and drops frames that belong to the runner itself. */
function cleanStack(text: string): string {
  let out = text
  for (const [url, path] of blobToPath) out = out.split(url).join(path)
  const ownUrl = scope.location.href.split('?')[0]
  return out
    .split('\n')
    .filter((line) => !(line.trim().startsWith('at ') && line.includes(ownUrl)))
    .join('\n')
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const stack = err.stack ?? ''
    return cleanStack(stack.includes(err.message) ? stack : `${err.name}: ${err.message}\n${stack}`).trim()
  }
  return `Uncaught ${inspect(err, true)}`
}

function installConsole() {
  const counters = new Map<string, number>()
  const timers = new Map<string, number>()
  const c = console as unknown as Record<string, unknown>
  const original = { ...c } as Record<string, (...args: unknown[]) => void>
  const make = (level: ConsoleLevel) => (...args: unknown[]) =>
    fromViteClient() ? original[level]?.(...args) : print(level, formatArgs(args))
  Object.assign(c, {
    log: make('log'),
    info: make('info'),
    debug: make('debug'),
    warn: make('warn'),
    error: make('error'),
    trace: (...args: unknown[]) => print('log', `Trace: ${formatArgs(args)}\n${cleanStack(new Error().stack ?? '').split('\n').slice(2).join('\n')}`),
    dir: (value: unknown) => print('log', inspect(value)),
    table: (data: unknown, columns?: string[]) => print('log', formatTable(data, columns) ?? formatArgs([data])),
    assert: (ok: unknown, ...args: unknown[]) => {
      if (!ok) print('error', `Assertion failed${args.length ? ': ' + formatArgs(args) : ''}`)
    },
    count: (label = 'default') => {
      counters.set(label, (counters.get(label) ?? 0) + 1)
      print('log', `${label}: ${counters.get(label)}`)
    },
    countReset: (label = 'default') => counters.delete(label),
    time: (label = 'default') => timers.set(label, performance.now()),
    timeLog: (label = 'default', ...args: unknown[]) => {
      const start = timers.get(label)
      if (start != null) print('log', `${label}: ${(performance.now() - start).toFixed(3)}ms ${formatArgs(args)}`.trimEnd())
    },
    timeEnd: (label = 'default') => {
      const start = timers.get(label)
      if (start == null) return
      timers.delete(label)
      print('log', `${label}: ${(performance.now() - start).toFixed(3)}ms`)
    },
    group: (...args: unknown[]) => {
      if (args.length) print('log', formatArgs(args))
      groupDepth++
    },
    groupCollapsed: (...args: unknown[]) => {
      if (args.length) print('log', formatArgs(args))
      groupDepth++
    },
    groupEnd: () => {
      groupDepth = Math.max(0, groupDepth - 1)
    },
    clear: () => post({ type: 'clear' }),
  })
}

function installGlobals(entry: string) {
  const g = globalThis as Record<string, unknown>
  // prompt() reads the next line from the Input box, so simple interactive programs work.
  g.prompt = (message?: string) => {
    const line = stdinLines.shift()
    print('input', `${message ?? ''}${line ?? ''}`)
    return line ?? null
  }
  const write = (level: ConsoleLevel) => (chunk: unknown) => {
    print(level, String(chunk).replace(/\n$/, ''))
    return true
  }
  // A tiny `process` so common Node-style snippets don't crash immediately.
  g.process = {
    argv: ['node', entry],
    env: {},
    platform: 'browser',
    stdout: { write: write('log') },
    stderr: { write: write('error') },
    exit: (code = 0) => {
      throw new Error(`process.exit(${code}) called`)
    },
  }
}

scope.addEventListener('error', (event) => {
  event.preventDefault()
  pendingWork.ok = false
  print('error', event.error ? `Uncaught ${describeError(event.error)}` : String(event.message))
})

scope.addEventListener('unhandledrejection', (event) => {
  event.preventDefault()
  pendingWork.ok = false
  print('error', `Uncaught (in promise) ${describeError(event.reason)}`)
})

/**
 * Like Node, a program is finished once the entry module has run and no timers or fetches
 * are pending. Track those so the IDE can report "finished" at the right moment.
 */
const pendingWork = { count: 0, mainDone: false, finished: false, ok: true, started: 0 }

function maybeFinish() {
  if (!pendingWork.mainDone || pendingWork.count > 0 || pendingWork.finished) return
  pendingWork.finished = true
  post({ type: 'done', ok: pendingWork.ok, ms: performance.now() - pendingWork.started })
}

function trackAsyncWork() {
  const g = globalThis as Record<string, unknown>
  const realSetTimeout = setTimeout
  const realClearTimeout = clearTimeout
  const realSetInterval = setInterval
  const realClearInterval = clearInterval
  const realFetch = fetch
  const timeouts = new Set<unknown>()
  const intervals = new Set<unknown>()
  // Defer the check to a fresh task so promise callbacks chained by user code run first.
  const later = scheduleFinish

  g.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (fromViteClient()) return realSetTimeout(fn, ms, ...args)
    pendingWork.count++
    const id = realSetTimeout(() => {
      timeouts.delete(id)
      pendingWork.count--
      try {
        if (typeof fn === 'function') fn(...args)
      } finally {
        later()
      }
    }, ms)
    timeouts.add(id)
    return id
  }
  g.clearTimeout = (id: ReturnType<typeof setTimeout>) => {
    if (timeouts.delete(id)) {
      pendingWork.count--
      later()
    }
    realClearTimeout(id)
  }
  g.setInterval = (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (fromViteClient()) return realSetInterval(fn, ms, ...args)
    pendingWork.count++
    const id = realSetInterval(() => typeof fn === 'function' && fn(...args), ms)
    intervals.add(id)
    return id
  }
  g.clearInterval = (id: ReturnType<typeof setInterval>) => {
    if (intervals.delete(id)) {
      pendingWork.count--
      later()
    }
    realClearInterval(id)
  }
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pendingWork.count++
    const settle = () => {
      pendingWork.count--
      later()
    }
    // A derived promise, so a rejection nobody handles is still reported as unhandled.
    return promise.then(
      (value) => (settle(), value),
      (error: unknown) => {
        settle()
        throw error
      },
    )
  }
  g.fetch = (...args: Parameters<typeof fetch>) => (fromViteClient() ? realFetch(...args) : track(realFetch(...args)))
  // Reading a response body is more async work: `fetch(u).then(r => r.json()).then(console.log)`
  // must still count as running after the headers have arrived.
  const proto = Response.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  for (const method of ['json', 'text', 'arrayBuffer', 'blob', 'formData', 'bytes']) {
    const original = proto[method]
    if (typeof original !== 'function') continue
    proto[method] = function (this: Response, ...a: unknown[]) {
      const result = original.apply(this, a)
      return fromViteClient() ? result : track(result)
    }
  }
}

/** Runs `maybeFinish` from a fresh task, after every pending microtask (awaits, .then chains). */
function scheduleFinish() {
  nativeSetTimeout(maybeFinish, 0)
}

scope.onmessage = async (event: MessageEvent<RunRequest>) => {
  const { entry, files, stdin } = event.data
  stdinLines = stdin ? stdin.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []
  installConsole()
  installGlobals(entry)
  trackAsyncWork()

  pendingWork.started = performance.now()
  try {
    const url = await linkModules({
      files: new Map(Object.entries(files)),
      entry,
      target: 'worker',
      emit: (path, code) => {
        const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
        blobToPath.set(blobUrl, path)
        return blobUrl
      },
    })
    await import(/* @vite-ignore */ url)
  } catch (err) {
    print('error', describeError(err))
    pendingWork.ok = false
    pendingWork.count = 0 // like Node: an uncaught error at the top level ends the program
  }
  pendingWork.mainDone = true
  // Not maybeFinish() directly: code still queued as microtasks (an async main() with many
  // awaits) would otherwise print after "done" and be lost when the worker is terminated.
  scheduleFinish()
}

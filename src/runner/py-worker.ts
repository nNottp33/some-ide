/**
 * Runs Python with Pyodide (CPython compiled to WebAssembly) inside a module worker.
 * The interpreter is loaded once and reused between runs; "Stop" terminates the worker.
 */
import type { ConsoleLevel, RunnerMessage, RunRequest, WorkerScope } from './protocol'

const PYODIDE_VERSION = '314.0.7'
const INDEX_URL: string =
  import.meta.env.VITE_PYODIDE_URL || `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`
const PROJECT_ROOT = '/project'

/** The subset of the Pyodide API this worker uses. */
interface Pyodide {
  runPython(code: string): unknown
  runPythonAsync(code: string, options?: { globals?: unknown; filename?: string; dedent?: boolean }): Promise<unknown>
  loadPackagesFromImports(
    code: string,
    options?: { messageCallback?: (msg: string) => void; errorCallback?: (msg: string) => void },
  ): Promise<unknown>
  setStdout(options: { write: (buffer: Uint8Array) => number }): void
  setStderr(options: { write: (buffer: Uint8Array) => number }): void
  setStdin(options: { stdin: () => string | null }): void
  toPy(value: unknown): { destroy(): void }
  FS: {
    mkdirTree(path: string): void
    writeFile(path: string, data: string): void
  }
}

const scope = self as unknown as WorkerScope
const post = (message: RunnerMessage) => scope.postMessage(message)
const print = (level: ConsoleLevel, text: string) => post({ type: 'console', level, text })

let pyodide: Promise<Pyodide> | undefined

/** Turns Python's byte stream into console lines; keeps a trailing partial line (e.g. an input() prompt). */
class LineWriter {
  private readonly decoder = new TextDecoder()
  private partial = ''

  constructor(private readonly level: ConsoleLevel) {}

  write = (buffer: Uint8Array): number => {
    this.partial += this.decoder.decode(buffer, { stream: true })
    const lines = this.partial.split('\n')
    this.partial = lines.pop()!
    for (const line of lines) print(this.level, line)
    return buffer.length
  }

  /** Returns and clears text written without a newline yet. */
  takePartial(): string {
    const text = this.partial
    this.partial = ''
    return text
  }

  flush(): void {
    if (this.partial) print(this.level, this.takePartial())
  }
}

function loadRuntime(): Promise<Pyodide> {
  pyodide ??= (async () => {
    post({ type: 'status', text: 'Loading Python runtime…' })
    const started = performance.now()
    const mod = (await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`)) as {
      loadPyodide(options: { indexURL: string }): Promise<Pyodide>
    }
    const py = await mod.loadPyodide({ indexURL: INDEX_URL })
    print('system', `Python runtime ready (${((performance.now() - started) / 1000).toFixed(1)}s)`)
    return py
  })().catch((err) => {
    pyodide = undefined
    throw new Error(
      `Could not load the Python runtime from ${INDEX_URL}\n${(err as Error).message}\n` +
        'Python needs an internet connection the first time it runs.',
    )
  })
  return pyodide
}

/** Keeps the user's frames and the final error, dropping Pyodide's internal frames. */
function trimTraceback(message: string): string {
  const lines = message.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    const frame = /^\s*File "([^"]+)"/.exec(line)
    if (frame) skipping = !(frame[1].startsWith(PROJECT_ROOT + '/') || frame[1] === '<exec>')
    else if (!line.startsWith(' ')) skipping = false
    if (!skipping) out.push(line.split(`"${PROJECT_ROOT}/`).join('"/'))
  }
  return out.join('\n').trim()
}

let flushOutput = () => {}

scope.onmessage = async (event: MessageEvent<RunRequest>) => {
  const { entry, files, stdin } = event.data
  const stdinLines = stdin ? stdin.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []
  let started = performance.now()
  try {
    const py = await loadRuntime()
    started = performance.now()

    const stdout = new LineWriter('log')
    const stderr = new LineWriter('error')
    py.setStdout({ write: stdout.write })
    py.setStderr({ write: stderr.write })
    py.setStdin({
      stdin: () => {
        // input("Name? ") writes the prompt without a newline; show it next to the answer.
        const prompt = stdout.takePartial()
        const line = stdinLines.shift()
        if (line === undefined) {
          if (prompt) print('log', prompt)
          return null
        }
        print('input', prompt + line)
        return line
      },
    })
    flushOutput = () => {
      stdout.flush()
      stderr.flush()
    }

    // Mirror the project into Pyodide's in-memory file system so imports and open() work.
    py.runPython(`
import shutil, os
shutil.rmtree(${JSON.stringify(PROJECT_ROOT)}, ignore_errors=True)
os.makedirs(${JSON.stringify(PROJECT_ROOT)}, exist_ok=True)
`)
    for (const [path, content] of Object.entries(files)) {
      const target = PROJECT_ROOT + path
      py.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')))
      py.FS.writeFile(target, content)
    }

    const entryDir = PROJECT_ROOT + entry.slice(0, entry.lastIndexOf('/'))
    py.runPython(`
import os, sys, importlib
os.chdir(${JSON.stringify(entryDir || PROJECT_ROOT)})
for _p in (${JSON.stringify(PROJECT_ROOT)}, ${JSON.stringify(entryDir)}):
    if _p in sys.path:
        sys.path.remove(_p)
    sys.path.insert(0, _p)
# Forget modules imported from the project by a previous run so edits are picked up.
for _name, _mod in list(sys.modules.items()):
    if (getattr(_mod, "__file__", None) or "").startswith(${JSON.stringify(PROJECT_ROOT + '/')}):
        del sys.modules[_name]
importlib.invalidate_caches()
`)

    const code = files[entry]
    await py.loadPackagesFromImports(code, {
      messageCallback: (msg) => post({ type: 'status', text: msg }),
      errorCallback: (msg) => print('warn', msg),
    })

    const globals = py.toPy({ __name__: '__main__', __file__: PROJECT_ROOT + entry })
    try {
      await py.runPythonAsync(code, { globals, filename: PROJECT_ROOT + entry, dedent: false })
    } finally {
      globals.destroy()
      flushOutput()
    }
    post({ type: 'done', ok: true, ms: performance.now() - started })
  } catch (err) {
    flushOutput()
    let text = trimTraceback((err as Error).message ?? String(err))
    if (/EOFError/.test(text)) text += '\n\nTip: type answers for input() in the Input box of the Console panel, one per line.'
    print('error', text)
    post({ type: 'done', ok: false, ms: performance.now() - started })
  }
}

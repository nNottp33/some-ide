import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlockDetector, type BlockEvent } from '../src/blocks.ts'
import { spawnShell, type SpawnedShell } from '../src/pty.ts'
import { which } from '../src/util.ts'
import { foldBlocks, type ReplayedBlock } from '../src/store.ts'

export interface Harness {
  shell: SpawnedShell
  detector: BlockDetector
  events: BlockEvent[]
  /** Send a line (Enter appended) and wait for the shell to report the next prompt (P;Cwd after D). */
  run(command: string): Promise<void>
  /** Wait for the next event of a type. */
  next<T extends BlockEvent['type']>(type: T, timeoutMs?: number): Promise<Extract<BlockEvent, { type: T }>>
  blocks(): ReplayedBlock[]
  exit(): Promise<{ exitCode: number }>
  raw: string
  home: string
}

export function fakeHome(extraRc = ''): string {
  const home = mkdtempSync(join(tmpdir(), 'somed-home-'))
  writeFileSync(join(home, '.bashrc'), `PS1='$ '\nHISTFILE=\nexport LANG=C.UTF-8\n${extraRc}\n`)
  writeFileSync(join(home, '.zshrc'), `PS1='%% '\n${extraRc}\n`)
  return home
}

export function hasShell(name: string): boolean {
  return which(name) !== undefined
}

export async function startShell(opts: { shell?: string; cols?: number; rows?: number; cwd?: string; rc?: string; env?: Record<string, string> } = {}): Promise<Harness> {
  const home = fakeHome(opts.rc)
  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TERM: 'xterm-256color', ...(opts.env ?? {}) }
  delete env.HISTCONTROL
  delete env.ZDOTDIR
  const shell = spawnShell({ shell: opts.shell ?? 'bash', cols, rows, cwd: opts.cwd ?? home, env, userZdotdir: home })
  const detector = new BlockDetector({ cols, rows, nonce: shell.nonce })
  const events: BlockEvent[] = []
  const waiters: { type: string; resolve: (e: BlockEvent) => void }[] = []
  detector.onEvent((e) => {
    events.push(e)
    for (const w of [...waiters]) {
      if (w.type === e.type) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(e)
      }
    }
  })
  const h: Harness = {
    shell,
    detector,
    events,
    raw: '',
    home,
    next(type, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}; events so far: ${JSON.stringify(events.slice(-5))}\nraw tail: ${JSON.stringify(h.raw.slice(-400))}`)), timeoutMs)
        waiters.push({
          type,
          resolve: (e) => {
            clearTimeout(timer)
            resolve(e as never)
          },
        })
      })
    },
    async run(command) {
      const p = h.next('cwd')
      shell.pty.write(command + '\r')
      await p
    },
    blocks() {
      return foldBlocks(events.map((e, i) => ({ ...e, seq: i + 1, ts: 'ts' in e ? e.ts : 0 })) as never)
    },
    exit() {
      return new Promise((resolve) => {
        shell.pty.onExit((e) => resolve(e))
        shell.pty.write('exit\r')
      })
    },
  }
  let chain = Promise.resolve()
  shell.pty.onData((d) => {
    h.raw += d
    chain = chain.then(() => detector.write(d))
  })
  // The script reports the cwd once before the first prompt.
  await h.next('cwd', 15_000)
  return h
}

/**
 * A terminal session = PTY + shell integration + block detector + persisted event log.
 * Sessions are owned by the SessionManager, not by a client connection, so they outlive
 * disconnects; clients attach and detach.
 */
import { randomBytes } from 'node:crypto'
import { BlockDetector, type BlockEvent } from './blocks.ts'
import { spawnShell, type SpawnedShell } from './pty.ts'
import { SessionStore, type SessionLog, type SessionMeta, type StoredEvent } from './store.ts'
import { Emitter } from './util.ts'

export interface SessionCreateOptions {
  shell?: string
  cwd?: string
  cols?: number
  rows?: number
  env?: NodeJS.ProcessEnv
  /** Override the generated id (tests). */
  id?: string
  /** Bytes of raw output kept in memory for reattaching terminals (default 256 KiB). */
  rawBufferBytes?: number
}

export interface SessionInfo {
  id: string
  shell: string
  cwd: string
  cols: number
  rows: number
  pid: number
  createdAt: number
  alive: boolean
  exitCode: number | undefined
  lastSeq: number
  blockCount: number
  shellIntegration: boolean
}

export class Session {
  readonly id: string
  readonly meta: SessionMeta
  readonly detector: BlockDetector
  readonly #shell: SpawnedShell
  readonly #log: SessionLog
  readonly #events = new Emitter<StoredEvent>()
  readonly #data = new Emitter<string>()
  readonly #exit = new Emitter<{ exitCode: number; signal?: number }>()
  readonly #rawLimit: number
  #raw = ''
  #cols: number
  #rows: number
  #alive = true
  #exitCode: number | undefined
  #blockCount = 0
  #writeChain: Promise<void> = Promise.resolve()

  constructor(store: SessionStore, options: SessionCreateOptions) {
    this.id = options.id ?? randomBytes(6).toString('hex')
    this.#cols = options.cols ?? 80
    this.#rows = options.rows ?? 24
    this.#rawLimit = options.rawBufferBytes ?? 256 * 1024
    this.#shell = spawnShell({
      shell: options.shell,
      cwd: options.cwd,
      cols: this.#cols,
      rows: this.#rows,
      env: options.env,
    })
    this.#log = store.open(this.id)
    this.meta = {
      type: 'session.meta',
      id: this.id,
      shell: this.#shell.executable,
      cwd: options.cwd ?? process.cwd(),
      cols: this.#cols,
      rows: this.#rows,
      createdAt: Date.now(),
      pid: this.#shell.pty.pid,
    }
    this.#emit(this.meta)
    this.detector = new BlockDetector({ cols: this.#cols, rows: this.#rows, nonce: this.#shell.nonce, idPrefix: `${this.id}:` })
    this.detector.onEvent((ev) => this.#onBlockEvent(ev))
    this.#shell.pty.onData((data) => {
      this.#raw += data
      if (this.#raw.length > this.#rawLimit) this.#raw = this.#raw.slice(this.#raw.length - this.#rawLimit)
      this.#data.fire(data)
      // Serialise writes so flushes happen in order.
      this.#writeChain = this.#writeChain.then(() => this.detector.write(data))
    })
    this.#shell.pty.onExit((e) => {
      this.#writeChain.then(() => {
        this.#alive = false
        this.#exitCode = e.exitCode
        this.detector.dispose(e.exitCode)
        this.#emit({ type: 'session.exit', exitCode: e.exitCode, signal: e.signal })
        this.#log.close()
        this.#exit.fire(e)
      })
    })
  }

  get info(): SessionInfo {
    return {
      id: this.id,
      shell: this.meta.shell,
      cwd: this.detector.cwd || this.meta.cwd,
      cols: this.#cols,
      rows: this.#rows,
      pid: this.meta.pid,
      createdAt: this.meta.createdAt,
      alive: this.#alive,
      exitCode: this.#exitCode,
      lastSeq: this.#log.seq,
      blockCount: this.#blockCount,
      shellIntegration: this.detector.shellIntegrationActive,
    }
  }

  get alive(): boolean {
    return this.#alive
  }

  get nonce(): string {
    return this.#shell.nonce
  }

  /** Raw terminal output kept for reattaching a terminal renderer. */
  get rawScrollback(): string {
    return this.#raw
  }

  /** Persisted + sequence-numbered block/session events. */
  onEvent(listener: (event: StoredEvent) => void): () => void {
    return this.#events.on(listener)
  }

  /** Raw PTY output (for a client-side terminal renderer). */
  onData(listener: (data: string) => void): () => void {
    return this.#data.on(listener)
  }

  onExit(listener: (e: { exitCode: number; signal?: number }) => void): () => void {
    return this.#exit.on(listener)
  }

  write(data: string): void {
    if (this.#alive) this.#shell.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.#alive) return
    this.#cols = cols
    this.#rows = rows
    this.#shell.pty.resize(cols, rows)
    this.detector.resize(cols, rows)
  }

  kill(signal?: string): void {
    if (this.#alive) this.#shell.pty.kill(signal)
  }

  /** Wait until the detector has processed everything the PTY produced so far. */
  flush(): Promise<void> {
    return this.#writeChain
  }

  #onBlockEvent(ev: BlockEvent): void {
    if (ev.type === 'block.start') this.#blockCount++
    this.#emit(ev)
  }

  #emit(ev: Parameters<SessionLog['append']>[0]): void {
    const stored = this.#log.append(ev)
    this.#events.fire(stored)
  }
}

export class SessionManager {
  readonly store: SessionStore
  readonly #sessions = new Map<string, Session>()
  readonly #created = new Emitter<Session>()

  constructor(dataDir: string) {
    this.store = new SessionStore(dataDir)
  }

  create(options: SessionCreateOptions = {}): Session {
    const session = new Session(this.store, options)
    this.#sessions.set(session.id, session)
    this.#created.fire(session)
    return session
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id)
  }

  /** Live sessions plus ids of persisted (dead) sessions that can still be replayed. */
  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => s.info)
  }

  listPersisted(): string[] {
    return this.store.list()
  }

  onCreated(listener: (s: Session) => void): () => void {
    return this.#created.on(listener)
  }

  replay(id: string, fromSeq = 0): StoredEvent[] {
    return this.store.read(id, fromSeq)
  }

  kill(id: string): boolean {
    const s = this.#sessions.get(id)
    if (!s) return false
    s.kill()
    return true
  }

  async disposeAll(): Promise<void> {
    for (const s of this.#sessions.values()) s.kill()
    this.#sessions.clear()
  }
}

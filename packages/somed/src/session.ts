/**
 * A terminal session = PTY + shell integration + block detector + persisted event log.
 * Sessions are owned by the SessionManager, not by a client connection, so they outlive
 * disconnects; clients attach and detach.
 *
 * Resource rules:
 *  - terminal size is bounded (SIZE_LIMITS) because the headless terminal allocates cols × rows
 *    cells (plus scrollback) and node-pty passes the size to the kernel;
 *  - a slow client can pause the PTY (`pause(token)` / `resume(token)`), which blocks the shell
 *    on its next write instead of buffering its output in the daemon;
 *  - the manager caps live sessions and evicts a session from memory once its shell exited; its
 *    JSONL log stays on disk and `list()` still describes it from there;
 *  - the per-session log is capped (see store.ts).
 */
import { randomBytes } from 'node:crypto'
import { BlockDetector, type BlockEvent } from './blocks.ts'
import { spawnShell, type SpawnedShell } from './pty.ts'
import { DEFAULT_MAX_LOG_BYTES, MAX_REPLAY_CHUNK, SessionStore, type LogPage, type SessionLog, type SessionMeta, type StoredEvent } from './store.ts'
import { Emitter } from './util.ts'

export const SIZE_LIMITS = { minCols: 2, maxCols: 1000, minRows: 1, maxRows: 500 } as const

export const DEFAULT_MAX_SESSIONS = 64

/** Validate a terminal size; returns an error message or undefined when acceptable. */
export function checkSize(cols: unknown, rows: unknown): string | undefined {
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) return 'cols and rows must be safe integers'
  const c = cols as number
  const r = rows as number
  if (c < SIZE_LIMITS.minCols || c > SIZE_LIMITS.maxCols) return `cols must be between ${SIZE_LIMITS.minCols} and ${SIZE_LIMITS.maxCols}`
  if (r < SIZE_LIMITS.minRows || r > SIZE_LIMITS.maxRows) return `rows must be between ${SIZE_LIMITS.minRows} and ${SIZE_LIMITS.maxRows}`
  return undefined
}

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
  /** Cap on the JSONL log of this session (default 64 MiB). */
  maxLogBytes?: number
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
  /** The log hit its size cap: `block.output` is no longer persisted (live streaming continues). */
  logTruncated: boolean
  /** Output is paused because an attached client is not reading fast enough. */
  paused: boolean
}

export class SessionLimitError extends Error {}

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
  readonly #pausers = new Set<object>()
  #raw = ''
  #cols: number
  #rows: number
  #alive = true
  #exitCode: number | undefined
  #blockCount = 0
  #writeChain: Promise<void> = Promise.resolve()

  constructor(store: SessionStore, options: SessionCreateOptions) {
    const sizeError = checkSize(options.cols ?? 80, options.rows ?? 24)
    if (sizeError) throw new RangeError(sizeError)
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
    try {
      this.#log = store.open(this.id, options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES)
    } catch (err) {
      this.#shell.pty.kill()
      this.#shell.cleanup()
      throw err
    }
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
        this.#emit({ type: 'session.exit', exitCode: e.exitCode, signal: e.signal, blockCount: this.#blockCount })
        this.#log.close()
        this.#shell.cleanup()
        this.#exit.fire(e)
        this.#exit.clear()
        this.#events.clear()
        this.#data.clear()
        this.#raw = ''
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
      logTruncated: this.#log.truncated,
      paused: this.paused,
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

  /** True while at least one token holds the PTY paused. */
  get paused(): boolean {
    return this.#pausers.size > 0
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
    const error = checkSize(cols, rows)
    if (error) throw new RangeError(error)
    if (!this.#alive) return
    this.#cols = cols
    this.#rows = rows
    this.#shell.pty.resize(cols, rows)
    this.detector.resize(cols, rows)
  }

  /**
   * Stop reading from the PTY on behalf of `token` (a slow consumer). The shell blocks once the
   * kernel's PTY buffer is full, so nothing accumulates in the daemon. Reading resumes when every
   * token that paused has resumed.
   */
  pause(token: object): void {
    if (!this.#alive) return
    const was = this.paused
    this.#pausers.add(token)
    if (!was) this.#shell.pty.pause()
  }

  resume(token: object): void {
    if (!this.#pausers.delete(token)) return
    if (this.#pausers.size === 0 && this.#alive) this.#shell.pty.resume()
  }

  kill(signal?: string): void {
    if (this.#alive) this.#shell.pty.kill(signal)
  }

  /** Kill the shell (if still running) and drop temporary files right away (daemon shutdown). */
  dispose(): void {
    this.kill()
    this.#shell.cleanup()
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

export interface SessionManagerOptions {
  /** Most sessions alive at the same time (default 64). */
  maxSessions?: number
  /** Default log cap for sessions created by this manager. */
  maxLogBytes?: number
}

export class SessionManager {
  readonly store: SessionStore
  readonly maxSessions: number
  readonly #maxLogBytes: number
  readonly #sessions = new Map<string, Session>()
  readonly #created = new Emitter<Session>()

  constructor(dataDir: string, options: SessionManagerOptions = {}) {
    this.store = new SessionStore(dataDir)
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.#maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
  }

  /** Spawn a session. Throws SessionLimitError when `maxSessions` are alive, RangeError on a bad size. */
  create(options: SessionCreateOptions = {}): Session {
    if (this.#sessions.size >= this.maxSessions) throw new SessionLimitError(`too many live sessions (limit ${this.maxSessions})`)
    const session = new Session(this.store, { maxLogBytes: this.#maxLogBytes, ...options })
    this.#sessions.set(session.id, session)
    // Evict from memory once the shell exited; the log stays on disk and list() reports it from there.
    session.onExit(() => {
      if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id)
    })
    this.#created.fire(session)
    return session
  }

  /** A live session (dead ones are evicted; use `replay` / `summary` for them). */
  get(id: string): Session | undefined {
    return this.#sessions.get(id)
  }

  get liveCount(): number {
    return this.#sessions.size
  }

  /** Live sessions, followed by persisted (exited) sessions described from their logs. */
  list(): SessionInfo[] {
    const out = [...this.#sessions.values()].map((s) => s.info)
    const live = new Set(this.#sessions.keys())
    for (const id of this.store.list()) {
      if (live.has(id)) continue
      const info = this.#fromDisk(id)
      if (info) out.push(info)
    }
    return out
  }

  /** Info of a live session, or of an exited one from its log on disk. */
  describe(id: string): SessionInfo | undefined {
    return this.#sessions.get(id)?.info ?? this.#fromDisk(id)
  }

  #fromDisk(id: string): SessionInfo | undefined {
    let summary
    try {
      summary = this.store.summary(id)
    } catch {
      return undefined
    }
    if (!summary) return undefined
    const { meta, exit, lastSeq } = summary
    return {
      id,
      shell: meta.shell,
      cwd: meta.cwd,
      cols: meta.cols,
      rows: meta.rows,
      pid: meta.pid,
      createdAt: meta.createdAt,
      alive: false,
      exitCode: exit?.exitCode,
      lastSeq,
      blockCount: exit?.blockCount ?? 0,
      shellIntegration: false,
      logTruncated: false,
      paused: false,
    }
  }

  listPersisted(): string[] {
    return this.store.list()
  }

  onCreated(listener: (s: Session) => void): () => void {
    return this.#created.on(listener)
  }

  /** Persisted events with seq > fromSeq, at most `limit` (≤ 1000) per call. */
  replay(id: string, fromSeq = 0, limit = MAX_REPLAY_CHUNK): StoredEvent[] {
    return this.store.read(id, fromSeq, limit)
  }

  /** One replay page plus whether a later one exists (one bisection + one scan). */
  replayPage(id: string, fromSeq = 0, limit = MAX_REPLAY_CHUNK): LogPage {
    return this.store.readPage(id, fromSeq, limit)
  }

  kill(id: string): boolean {
    const s = this.#sessions.get(id)
    if (!s) return false
    s.kill()
    return true
  }

  async disposeAll(): Promise<void> {
    for (const s of this.#sessions.values()) s.dispose()
    this.#sessions.clear()
  }
}

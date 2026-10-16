/**
 * Append-only JSONL persistence for session block events, so a client can reattach and replay.
 *
 * Layout: <dataDir>/sessions/<sessionId>.jsonl — one JSON object per line:
 *   { seq, ts, ...event }   (seq is a per-session monotonically increasing number)
 * plus a `session.meta` record on the first line describing the session.
 *
 * Limits: a log stops recording `block.output` once it reaches `maxBytes` (64 MiB by default);
 * the small structural events (block.start/command/end, cwd, session.exit) are still appended so
 * the block list stays complete. Reads are chunked: `read(id, fromSeq, limit)` stops as soon as
 * `limit` events were collected instead of parsing the whole file.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { BlockEvent } from './blocks.ts'

export interface SessionMeta {
  type: 'session.meta'
  id: string
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  pid: number
}

export interface SessionExit {
  type: 'session.exit'
  exitCode: number
  signal?: number
  /** Number of blocks the session produced (lets `session.list` describe dead sessions from disk). */
  blockCount?: number
}

export type SessionEvent = BlockEvent | SessionMeta | SessionExit

export type StoredEvent = SessionEvent & { seq: number; ts: number }

/** Default cap on a single session log. */
export const DEFAULT_MAX_LOG_BYTES = 64 * 1024 * 1024
/** Most events a single `read` returns (one replay chunk). */
export const MAX_REPLAY_CHUNK = 1000

const READ_CHUNK = 64 * 1024

export interface SessionSummary {
  meta: SessionMeta
  exit: SessionExit | undefined
  lastSeq: number
}

export class SessionStore {
  readonly dir: string
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'sessions')
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  pathFor(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
    return join(this.dir, `${sessionId}.jsonl`)
  }

  /** Open an appender for a session log. Writes are synchronous (small lines, local disk). */
  open(sessionId: string, maxBytes = DEFAULT_MAX_LOG_BYTES): SessionLog {
    return new SessionLog(this.pathFor(sessionId), maxBytes)
  }

  /**
   * Read persisted events of a session with seq > fromSeq, at most `limit` of them (default and
   * maximum MAX_REPLAY_CHUNK). The file is scanned in 64 KiB chunks and the scan stops early.
   */
  read(sessionId: string, fromSeq = 0, limit = MAX_REPLAY_CHUNK): StoredEvent[] {
    return readLogEvents(this.pathFor(sessionId), fromSeq, limit)
  }

  /** Does the log hold any event with seq > fromSeq? (Cheap "is there more?" check for chunked replay.) */
  hasMore(sessionId: string, fromSeq: number): boolean {
    return this.read(sessionId, fromSeq, 1).length > 0
  }

  /**
   * Describe a persisted session without reading the whole log: the `session.meta` first line,
   * the last complete line (seq, and the `session.exit` record when the session ended).
   */
  summary(sessionId: string): SessionSummary | undefined {
    return readLogSummary(this.pathFor(sessionId))
  }

  list(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
  }

  remove(sessionId: string): void {
    const path = this.pathFor(sessionId)
    if (existsSync(path)) unlinkSync(path)
  }
}

/** Events with seq > fromSeq from a JSONL log, at most `limit` (scanned in 64 KiB chunks, stops early). */
export function readLogEvents(path: string, fromSeq = 0, limit = MAX_REPLAY_CHUNK): StoredEvent[] {
  if (!existsSync(path)) return []
  const max = Math.max(1, Math.min(limit, MAX_REPLAY_CHUNK))
  const out: StoredEvent[] = []
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(READ_CHUNK)
    let rest = ''
    let position = 0
    for (;;) {
      const n = readSync(fd, buf, 0, READ_CHUNK, position)
      if (n === 0) break
      position += n
      rest += buf.toString('utf8', 0, n)
      let nl: number
      while ((nl = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, nl)
        rest = rest.slice(nl + 1)
        if (!line) continue
        const ev = parseLine(line)
        if (ev && ev.seq > fromSeq) {
          out.push(ev)
          if (out.length >= max) return out
        }
      }
    }
    // A torn last line (crash mid-write, no trailing newline) is skipped.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return out
}

/** First line of a log (the `session.meta` record of a session log). */
function readFirstLine(fd: number, size: number): StoredEvent | undefined {
  const head = Buffer.allocUnsafe(Math.min(size, READ_CHUNK))
  const n = readSync(fd, head, 0, head.length, 0)
  const text = head.toString('utf8', 0, n)
  const nl = text.indexOf('\n')
  return nl === -1 ? undefined : parseLine(text.slice(0, nl))
}

/** Last complete (newline terminated, parseable) line within the final 64 KiB of a log. */
function readLastLine(fd: number, size: number): StoredEvent | undefined {
  const tailStart = Math.max(0, size - READ_CHUNK)
  const tail = Buffer.allocUnsafe(size - tailStart)
  const m = readSync(fd, tail, 0, tail.length, tailStart)
  const lines = tail.toString('utf8', 0, m).split('\n')
  // The last element is '' when the file ends with a newline, otherwise a torn line.
  lines.pop()
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line) continue
    const ev = parseLine(line)
    if (ev) return ev
  }
  return undefined
}

/** Seq of the last complete line of a log (0 for a missing or empty log). */
export function readLastSeq(path: string): number {
  if (!existsSync(path)) return 0
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    return size === 0 ? 0 : (readLastLine(fd, size)?.seq ?? 0)
  } finally {
    closeSync(fd)
  }
}

/**
 * Describe a session log without reading all of it: the `session.meta` first line and the last
 * complete line (its seq, and the `session.exit` record when the session ended).
 */
export function readLogSummary(path: string): SessionSummary | undefined {
  if (!existsSync(path)) return undefined
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size === 0) return undefined
    const meta = readFirstLine(fd, size)
    if (!meta || meta.type !== 'session.meta') return undefined
    const last = readLastLine(fd, size) ?? meta
    return { meta, exit: last.type === 'session.exit' ? last : undefined, lastSeq: last.seq }
  } finally {
    closeSync(fd)
  }
}

function parseLine(line: string): StoredEvent | undefined {
  try {
    const ev = JSON.parse(line) as StoredEvent
    if (!ev || typeof ev !== 'object' || typeof ev.seq !== 'number') return undefined
    return ev
  } catch {
    return undefined
  }
}

export class SessionLog {
  readonly path: string
  readonly maxBytes: number
  #fd: number | undefined
  #seq = 0
  #bytes = 0
  #truncated = false
  constructor(path: string, maxBytes = DEFAULT_MAX_LOG_BYTES) {
    this.path = path
    this.maxBytes = maxBytes
    if (existsSync(path)) {
      // Resume numbering after whatever is already there.
      const fd = openSync(path, 'r')
      try {
        this.#bytes = fstatSync(fd).size
      } finally {
        closeSync(fd)
      }
      this.#seq = readLastSeq(path)
    }
    this.#fd = openSync(path, 'a', 0o600)
  }

  get seq(): number {
    return this.#seq
  }

  get bytes(): number {
    return this.#bytes
  }

  /** True once the byte cap was hit and `block.output` is no longer recorded. */
  get truncated(): boolean {
    return this.#truncated
  }

  /**
   * Append an event. Every event gets a seq (so live listeners see consistent numbering); once
   * the cap is reached only `block.output` is dropped from disk, everything else is still written.
   */
  append(event: SessionEvent): StoredEvent {
    const stored = { ...event, seq: ++this.#seq, ts: 'ts' in event && typeof event.ts === 'number' ? event.ts : Date.now() } as StoredEvent
    if (this.#fd === undefined) return stored
    const line = JSON.stringify(stored) + '\n'
    if (this.#bytes + line.length > this.maxBytes) {
      if (!this.#truncated) this.#truncated = true
      if (event.type === 'block.output') return stored
    }
    this.#bytes += line.length
    writeSync(this.#fd, line)
    return stored
  }

  close(): void {
    if (this.#fd !== undefined) {
      closeSync(this.#fd)
      this.#fd = undefined
    }
  }
}

/** Rebuild a list of complete blocks from stored events (used by the `replay` CLI and tests). */
export interface ReplayedBlock {
  id: string
  commandLine: string
  cwd: string
  output: string
  exitCode: number | undefined
  durationMs: number | undefined
  tui: boolean
  startTs: number
  /** The block was closed by a stray prompt sequence, not by the shell's own `D`. */
  truncated?: boolean
}

export function foldBlocks(events: StoredEvent[]): ReplayedBlock[] {
  const blocks = new Map<string, ReplayedBlock>()
  const order: ReplayedBlock[] = []
  for (const ev of events) {
    switch (ev.type) {
      case 'block.start': {
        const b: ReplayedBlock = { id: ev.id, commandLine: '', cwd: '', output: '', exitCode: undefined, durationMs: undefined, tui: false, startTs: ev.ts }
        blocks.set(ev.id, b)
        order.push(b)
        break
      }
      case 'block.command': {
        const b = blocks.get(ev.id)
        if (b) {
          b.commandLine = ev.commandLine
          b.cwd = ev.cwd
        }
        break
      }
      case 'block.output': {
        const b = blocks.get(ev.id)
        if (b) b.output += ev.text
        break
      }
      case 'block.end': {
        const b = blocks.get(ev.id)
        if (b) {
          b.exitCode = ev.exitCode
          b.durationMs = ev.durationMs
          b.tui = ev.tui
          if (ev.truncated) b.truncated = true
        }
        break
      }
      default:
        break
    }
  }
  return order
}

/**
 * Append-only JSONL persistence for session block events, so a client can reattach and replay.
 *
 * Layout: <dataDir>/sessions/<sessionId>.jsonl — one JSON object per line:
 *   { seq, ts, ...event }   (seq is a per-session monotonically increasing number)
 * plus a `session.meta` record on the first line describing the session.
 *
 * Limits: a log stops recording `block.output` once it reaches `maxBytes` (64 MiB by default);
 * the small structural events (block.start/command/end, cwd, session.exit) are still appended so
 * the block list stays complete. Reads are paged: `readPage(id, fromSeq, limit)` bisects the file
 * for the first line with `seq > fromSeq` (seqs grow with the offset), then scans forward and
 * stops after `limit` events or MAX_REPLAY_BYTES of lines, so paging through a log costs O(N)
 * in total and no page blocks the event loop for long.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
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
/** A page also ends once its lines add up to this many characters (bounds the size of one reply frame). */
export const MAX_REPLAY_BYTES = 1024 * 1024

const READ_CHUNK = 64 * 1024
/** Longest line the seq bisection will assemble for one probe before giving up on that probe. */
const MAX_PROBE_LINE = 16 * 1024 * 1024

export interface LogPage {
  events: StoredEvent[]
  /** More events with a higher seq exist (fetch the next page from the last returned seq). */
  more: boolean
}

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
   * maximum MAX_REPLAY_CHUNK) and at most MAX_REPLAY_BYTES of log lines. See `readLogPage`.
   */
  read(sessionId: string, fromSeq = 0, limit = MAX_REPLAY_CHUNK): StoredEvent[] {
    return this.readPage(sessionId, fromSeq, limit).events
  }

  /** One replay page: the events plus whether a later one exists (found by the same scan). */
  readPage(sessionId: string, fromSeq = 0, limit = MAX_REPLAY_CHUNK): LogPage {
    return readLogPage(this.pathFor(sessionId), fromSeq, limit)
  }

  /** Does the log hold any event with seq > fromSeq? (Bisection + one line.) */
  hasMore(sessionId: string, fromSeq: number): boolean {
    return this.readPage(sessionId, fromSeq, 1).events.length > 0
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

/** Events with seq > fromSeq from a JSONL log, at most `limit` (see `readLogPage`). */
export function readLogEvents(path: string, fromSeq = 0, limit = MAX_REPLAY_CHUNK): StoredEvent[] {
  return readLogPage(path, fromSeq, limit).events
}

/**
 * One page of events with seq > fromSeq: at most `limit` (≤ MAX_REPLAY_CHUNK) events and, past
 * the first one, at most MAX_REPLAY_BYTES of lines. The scan starts at the offset `seekSeq`
 * bisects to instead of at byte 0, parses only lines whose seq (read with a cheap string search)
 * is wanted, and reports `more` from the line that did not fit instead of a second scan.
 */
export function readLogPage(path: string, fromSeq = 0, limit = MAX_REPLAY_CHUNK): LogPage {
  if (!existsSync(path)) return { events: [], more: false }
  const max = Math.max(1, Math.min(limit, MAX_REPLAY_CHUNK))
  const out: StoredEvent[] = []
  let chars = 0
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const buf = Buffer.allocUnsafe(READ_CHUNK)
    // Decodes across chunk boundaries (a multi-byte character split at 64 KiB stays intact).
    const decoder = new StringDecoder('utf8')
    let rest = ''
    let position = fromSeq > 0 ? seekSeq(fd, size, fromSeq) : 0
    for (;;) {
      const n = readSync(fd, buf, 0, READ_CHUNK, position)
      if (n === 0) break
      position += n
      rest += decoder.write(buf.subarray(0, n))
      let nl: number
      while ((nl = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, nl)
        rest = rest.slice(nl + 1)
        if (!line) continue
        const seq = quickSeq(line)
        if (seq !== undefined && seq <= fromSeq) continue
        const ev = parseLine(line)
        if (!ev || ev.seq <= fromSeq) continue
        if (out.length >= max || (out.length > 0 && chars + line.length > MAX_REPLAY_BYTES)) return { events: out, more: true }
        out.push(ev)
        chars += line.length
      }
    }
    // A torn last line (crash mid-write, no trailing newline) is skipped.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return { events: out, more: false }
}

/**
 * The `seq` of a log line without parsing it. `"seq":` cannot occur inside a JSON string (a quote
 * in a string is always escaped) and keys are unique, so the last occurrence is the real field.
 */
function quickSeq(line: string): number | undefined {
  const i = line.lastIndexOf('"seq":')
  if (i === -1) return undefined
  let n = 0
  let digits = 0
  for (let j = i + 6; j < line.length; j++) {
    const c = line.charCodeAt(j)
    if (c < 48 || c > 57) break
    n = n * 10 + (c - 48)
    digits++
  }
  return digits > 0 ? n : undefined
}

/** Same as `quickSeq` on the bytes [from, to) of a buffer. */
function quickSeqBytes(buf: Buffer, from: number, to: number): number | undefined {
  const i = buf.lastIndexOf('"seq":', to - 1, 'latin1')
  if (i < from) return undefined
  let n = 0
  let digits = 0
  for (let j = i + 6; j < to; j++) {
    const c = buf[j]!
    if (c < 48 || c > 57) break
    n = n * 10 + (c - 48)
    digits++
  }
  return digits > 0 ? n : undefined
}

/**
 * Byte offset from which a forward scan finds every event with seq > fromSeq, by bisection:
 * each step probes the first complete line after the midpoint. `lo` only moves past lines known
 * to have seq ≤ fromSeq (and, seqs being monotonic, everything before them), and `hi` only moves
 * to lines known to be wanted; a probe that cannot be read (torn, huge or unparsable line) just
 * halves the range conservatively. The caller scans forward from the result, so the answer is
 * always correct and merely less tight in odd files.
 */
function seekSeq(fd: number, size: number, fromSeq: number): number {
  let lo = 0
  let hi = size
  while (hi - lo > 2 * READ_CHUNK) {
    const mid = lo + Math.floor((hi - lo) / 2)
    const probe = probeLine(fd, size, mid)
    if (!probe || probe.start >= hi) {
      hi = mid
      continue
    }
    if (probe.seq <= fromSeq) lo = probe.end
    else hi = probe.start
  }
  return lo
}

/** Bounds and seq of the first complete line that starts after `pos` (i.e. after the next newline). */
function probeLine(fd: number, size: number, pos: number): { start: number; end: number; seq: number } | undefined {
  let data = Buffer.alloc(0)
  const grow = (): boolean => {
    const have = data.length
    if (pos + have >= size || have >= MAX_PROBE_LINE) return false
    const len = Math.min(have === 0 ? READ_CHUNK : have, size - pos - have, MAX_PROBE_LINE - have)
    const more = Buffer.allocUnsafe(len)
    const n = readSync(fd, more, 0, len, pos + have)
    if (n === 0) return false
    data = Buffer.concat([data, more.subarray(0, n)])
    return true
  }
  let searchFrom = 0
  let nl: number
  while ((nl = data.indexOf(10, searchFrom)) === -1) {
    searchFrom = data.length
    if (!grow()) return undefined
  }
  const start = nl + 1
  searchFrom = start
  let end: number
  while ((end = data.indexOf(10, searchFrom)) === -1) {
    searchFrom = data.length
    if (!grow()) return undefined
  }
  const seq = quickSeqBytes(data, start, end)
  if (seq === undefined) return undefined
  return { start: pos + start, end: pos + end + 1, seq }
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
    if (!this.#truncated && this.#bytes + line.length > this.maxBytes) this.#truncated = true
    // Sticky: once the cap was hit no further output is recorded, however small the chunk.
    if (this.#truncated && event.type === 'block.output') return stored
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

/**
 * Append-only JSONL persistence for session block events, so a client can reattach and replay.
 *
 * Layout: <dataDir>/sessions/<sessionId>.jsonl — one JSON object per line:
 *   { seq, ts, ...event }   (seq is a per-session monotonically increasing number)
 * plus a `session.meta` record on the first line describing the session.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
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
}

export type SessionEvent = BlockEvent | SessionMeta | SessionExit

export type StoredEvent = SessionEvent & { seq: number; ts: number }

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
  open(sessionId: string): SessionLog {
    return new SessionLog(this.pathFor(sessionId))
  }

  /** Read all persisted events of a session with seq > fromSeq. */
  read(sessionId: string, fromSeq = 0): StoredEvent[] {
    const path = this.pathFor(sessionId)
    if (!existsSync(path)) return []
    const text = readFileSync(path, 'utf8')
    const out: StoredEvent[] = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const ev = JSON.parse(line) as StoredEvent
        if (ev.seq > fromSeq) out.push(ev)
      } catch {
        // A torn last line (crash mid-write) is skipped.
      }
    }
    return out
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

export class SessionLog {
  readonly path: string
  #fd: number | undefined
  #seq = 0
  constructor(path: string) {
    this.path = path
    if (existsSync(path)) {
      // Resume numbering after whatever is already there.
      const text = readFileSync(path, 'utf8')
      const lastLine = text.trimEnd().split('\n').pop()
      if (lastLine) {
        try {
          this.#seq = (JSON.parse(lastLine) as StoredEvent).seq ?? 0
        } catch {
          this.#seq = 0
        }
      }
    }
    this.#fd = openSync(path, 'a', 0o600)
  }

  get seq(): number {
    return this.#seq
  }

  append(event: SessionEvent): StoredEvent {
    const stored = { ...event, seq: ++this.#seq, ts: 'ts' in event && typeof event.ts === 'number' ? event.ts : Date.now() } as StoredEvent
    if (this.#fd !== undefined) writeSync(this.#fd, JSON.stringify(stored) + '\n')
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
        }
        break
      }
      default:
        break
    }
  }
  return order
}

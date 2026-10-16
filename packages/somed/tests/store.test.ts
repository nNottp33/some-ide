import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../src/session.ts'
import { MAX_REPLAY_BYTES, SessionLog, SessionStore, foldBlocks, readLogPage, type StoredEvent } from '../src/store.ts'
import { fakeHome } from './helpers.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'somed-store-'))
}

describe('session log (JSONL)', () => {
  it('appends sequence-numbered lines and resumes numbering after reopen', () => {
    const dir = tempDir()
    const store = new SessionStore(dir)
    const log = store.open('abc')
    expect(log.append({ type: 'cwd', cwd: '/a' }).seq).toBe(1)
    expect(log.append({ type: 'block.start', id: 'abc:1', ts: 5 })).toMatchObject({ seq: 2, ts: 5 })
    log.close()
    const reopened = new SessionLog(store.pathFor('abc'))
    expect(reopened.seq).toBe(2)
    expect(reopened.append({ type: 'cwd', cwd: '/b' }).seq).toBe(3)
    reopened.close()
    expect(store.read('abc').map((e) => e.seq)).toEqual([1, 2, 3])
    expect(store.read('abc', 2).map((e) => e.seq)).toEqual([3])
    expect(store.list()).toEqual(['abc'])
    expect(() => store.pathFor('../etc/passwd')).toThrow()
    const lines = readFileSync(store.pathFor('abc'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'block.start', id: 'abc:1', ts: 5, seq: 2 })
  })

  it('folds events into blocks and skips torn lines', () => {
    const events: StoredEvent[] = [
      { type: 'block.start', id: 'x:1', ts: 1, seq: 1 },
      { type: 'block.command', id: 'x:1', commandLine: 'echo a', cwd: '/', trusted: true, seq: 2, ts: 1 },
      { type: 'block.output', id: 'x:1', text: 'a\n', seq: 3, ts: 1 },
      { type: 'block.output', id: 'x:1', text: 'b\n', seq: 4, ts: 1 },
      { type: 'block.end', id: 'x:1', exitCode: 3, durationMs: 9, tui: false, ts: 2, seq: 5 },
    ]
    expect(foldBlocks(events)).toEqual([{ id: 'x:1', commandLine: 'echo a', cwd: '/', output: 'a\nb\n', exitCode: 3, durationMs: 9, tui: false, startTs: 1 }])
  })
})

describe('session persistence and replay with a real shell', () => {
  it('persists every block event so a client can replay after the session died', async () => {
    const dir = tempDir()
    const home = fakeHome()
    const manager = new SessionManager(dir)
    const session = manager.create({ shell: 'bash', cwd: home, cols: 80, rows: 24, env: { ...process.env, HOME: home } })
    const live: StoredEvent[] = []
    session.onEvent((e) => live.push(e))
    const waitFor = (type: string) => new Promise<StoredEvent>((resolve) => {
      const off = session.onEvent((e) => {
        if (e.type === type) {
          off()
          resolve(e)
        }
      })
    })
    await waitFor('cwd')
    for (const cmd of ['echo persisted', 'printf "x\\ny\\n"', 'exit 3']) {
      const done = cmd.startsWith('exit') ? waitFor('session.exit') : waitFor('cwd')
      session.write(cmd + '\r')
      await done
    }
    expect(session.alive).toBe(false)
    expect(session.info.exitCode).toBe(3)

    const replayed = manager.replay(session.id)
    // session.meta (seq 1) is written in the constructor, before a listener can subscribe.
    expect(replayed.slice(1).map((e) => e.seq)).toEqual(live.map((e) => e.seq))
    expect(replayed[0]).toMatchObject({ type: 'session.meta', id: session.id, shell: expect.stringMatching(/bash$/), seq: 1 })
    expect(replayed.at(-1)).toMatchObject({ type: 'session.exit', exitCode: 3 })
    const blocks = foldBlocks(replayed)
    expect(blocks.map((b) => [b.commandLine, b.output, b.exitCode])).toEqual([
      ['echo persisted', 'persisted\n', 0],
      ['printf "x\\ny\\n"', 'x\ny\n', 0],
      ['exit 3', 'exit\n', 3],
    ])
    // Replay from the middle only returns newer events.
    const mid = replayed[4]!.seq
    expect(manager.replay(session.id, mid).every((e) => e.seq > mid)).toBe(true)
    expect(manager.listPersisted()).toContain(session.id)
    expect(manager.list().find((s) => s.id === session.id)?.alive).toBe(false)
  }, 20_000)
})

describe('replay paging', () => {
  it('reaches a page near the end of a large log by bisection, with seq gaps and a torn tail', () => {
    const store = new SessionStore(tempDir())
    const path = store.pathFor('big')
    // ~24 MiB, 300 000 lines in SessionLog's own layout (event fields, then seq, then ts). Every 7th
    // seq is missing (block.output dropped past the log cap), the text contains a decoy "seq":N
    // (escaped inside the JSON string) and the last line is torn (crash mid-write).
    const lines: string[] = []
    const expectedSeqs: number[] = []
    let seq = 1
    lines.push(JSON.stringify({ type: 'session.meta', id: 'big', shell: '/bin/bash', cwd: '/', cols: 80, rows: 24, createdAt: 1, pid: 1, seq, ts: 1 }))
    expectedSeqs.push(seq)
    while (lines.length < 300_000) {
      seq++
      if (seq % 7 === 0) continue
      lines.push(JSON.stringify({ type: 'block.output', id: 'big:1', text: `${'x'.repeat(50)} "seq":${seq * 10}\n`, seq, ts: seq }))
      expectedSeqs.push(seq)
    }
    const lastSeq = seq
    writeFileSync(path, lines.join('\n') + '\n' + '{"type":"block.output","id":"big:1","text":"torn","seq":99')
    // Paging from the start yields every event exactly once, in order, and `more` comes from the same scan.
    const got: number[] = []
    let fromSeq = 0
    let pages = 0
    for (;;) {
      const page = store.readPage('big', fromSeq, 1000)
      got.push(...page.events.map((e) => e.seq))
      pages++
      if (!page.more) break
      expect(page.events).toHaveLength(1000)
      fromSeq = page.events[page.events.length - 1]!.seq
    }
    expect(pages).toBe(300)
    expect(got.length).toBe(expectedSeqs.length)
    expect(got.join(',')).toBe(expectedSeqs.join(','))
    // Random access: the first event of a page is the first seq above fromSeq, gaps included.
    for (const from of [0, 1, 6, 7, 8, 1234, 150_000, lastSeq - 8, lastSeq - 1, lastSeq, lastSeq + 5]) {
      const page = store.readPage('big', from, 3)
      const wanted = expectedSeqs.filter((s) => s > from)
      expect(page.events.map((e) => e.seq), `fromSeq ${from}`).toEqual(wanted.slice(0, 3))
      expect(page.more, `fromSeq ${from}`).toBe(wanted.length > 3)
    }
    expect(store.hasMore('big', lastSeq)).toBe(false)
    expect(store.hasMore('big', lastSeq - 1)).toBe(true)
    expect(readLogPage(join(store.dir, 'missing.jsonl'), 0)).toEqual({ events: [], more: false })
    // A page near the end costs a few 64 KiB probes plus the page itself, not a scan of the whole
    // file (which takes hundreds of milliseconds here and made paging a log O(N²)).
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) store.readPage('big', lastSeq - 1500 - i * 1000, 1000)
    expect((performance.now() - t0) / 20).toBeLessThan(100)
  }, 30_000)

  it('ends a page early once it holds about 1 MiB of lines, keeps delivering oversized events one per page', () => {
    const store = new SessionStore(tempDir())
    const log = store.open('fat', 1 << 30)
    log.append({ type: 'session.meta', id: 'fat', shell: '/bin/bash', cwd: '/', cols: 80, rows: 24, createdAt: 1, pid: 1 })
    for (let i = 0; i < 10; i++) log.append({ type: 'block.output', id: 'fat:1', text: 'y'.repeat(300 * 1024) })
    log.append({ type: 'block.output', id: 'fat:1', text: 'z'.repeat(2 * MAX_REPLAY_BYTES) })
    log.append({ type: 'session.exit', exitCode: 0, blockCount: 1 })
    log.close()
    const seqs: number[][] = []
    let fromSeq = 0
    for (;;) {
      const page = store.readPage('fat', fromSeq, 1000)
      seqs.push(page.events.map((e) => e.seq))
      if (!page.more) break
      fromSeq = page.events[page.events.length - 1]!.seq
    }
    // meta + 3 × 300 KiB fit under 1 MiB; the 4th output would not. The 2 MiB event travels alone.
    expect(seqs).toEqual([[1, 2, 3, 4], [5, 6, 7], [8, 9, 10], [11], [12], [13]])
    expect(seqs.flat()).toHaveLength(13)
  })

  it('decodes multi-byte characters that straddle a 64 KiB read boundary', () => {
    // Three ids of different lengths shift the text by one byte each, so one of the three logs has
    // a 3-byte character cut by the 65 536-byte chunk boundary.
    const text = 'ก'.repeat(40_000)
    for (const id of ['u1', 'u22', 'u333']) {
      const store = new SessionStore(tempDir())
      const log = store.open(id)
      log.append({ type: 'session.meta', id, shell: '/bin/bash', cwd: '/', cols: 80, rows: 24, createdAt: 1, pid: 1 })
      log.append({ type: 'block.output', id: `${id}:1`, text })
      log.append({ type: 'block.output', id: `${id}:1`, text: 'after' })
      log.close()
      const events = store.read(id)
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
      expect((events[1] as { text: string }).text).toBe(text)
      expect((events[2] as { text: string }).text).toBe('after')
    }
  })
})

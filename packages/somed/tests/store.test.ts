import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '../src/session.ts'
import { SessionLog, SessionStore, foldBlocks, type StoredEvent } from '../src/store.ts'
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

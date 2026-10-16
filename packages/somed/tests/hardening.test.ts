/**
 * Regression probes for the adversarial review findings. Most tests drive a real daemon over the
 * WebSocket like an attacker (or a buggy client) would.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry, FAILURE_WINDOW_MS, LOCKOUT_MS, MAX_FAILURES, Pairing, sanitizeDeviceName } from '../src/auth.ts'
import { loadOrCreateDevice, savePin, serverKey, SomedClient, type DeviceIdentity } from '../src/client.ts'
import { ErrorCodes, installCrashGuards, safePath, startDaemon, type Daemon } from '../src/server.ts'
import { DEFAULT_MAX_SESSIONS, SIZE_LIMITS, SessionManager, checkSize } from '../src/session.ts'
import { MAX_REPLAY_CHUNK, SessionStore, readLogSummary, type StoredEvent } from '../src/store.ts'
import { fakeHome } from './helpers.ts'

function tempDir(prefix = 'somed-harden-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** Start a daemon whose root is `root`, pair and authenticate one device against it. */
async function startPaired(options: Partial<Parameters<typeof startDaemon>[0]> & { root: string }, logs: string[] = []): Promise<{ daemon: Daemon; device: DeviceIdentity; connect: () => Promise<SomedClient>; logs: string[] }> {
  const dir = tempDir('somed-harden-data-')
  const daemon = await startDaemon({ port: 0, dataDir: dir, tls: true, log: (m) => logs.push(m), ...options })
  const device = loadOrCreateDevice(join(dir, 'client'), 'probe')
  const code = daemon.pairing.start()
  const c = await SomedClient.connect(daemon.url, { trustOnFirstUse: true })
  await c.pair(device, code.code)
  c.close()
  const connect = async () => {
    const client = await SomedClient.connect(daemon.url, { fingerprint: daemon.tls!.fingerprint })
    await client.authenticate(device)
    return client
  }
  return { daemon, device, connect, logs }
}

/** Send a raw text frame and wait for the first frame that comes back. */
function roundTrip(c: SomedClient, text: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${text}`)), timeoutMs)
    c.ws.once('message', (raw) => {
      clearTimeout(timer)
      resolve(JSON.parse(raw.toString()))
    })
    c.sendRaw(text)
  })
}

describe('1. malformed frames before authentication', () => {
  let daemon: Daemon
  const logs: string[] = []
  beforeAll(async () => {
    daemon = await startDaemon({ port: 0, dataDir: tempDir(), root: tempDir(), tls: false, log: (m) => logs.push(m) })
  })
  afterAll(() => daemon.close())

  it('answers every non-object / method-less frame with an error instead of crashing', async () => {
    const c = await SomedClient.connect(daemon.url)
    const probes: [string, number][] = [
      ['null', ErrorCodes.invalidRequest],
      ['[]', ErrorCodes.invalidRequest],
      ['"ping"', ErrorCodes.invalidRequest],
      ['123', ErrorCodes.invalidRequest],
      ['true', ErrorCodes.invalidRequest],
      ['{"id":1}', ErrorCodes.invalidRequest],
      ['{"id":1,"method":5}', ErrorCodes.invalidRequest],
      ['{"id":1,"method":{"toString":1}}', ErrorCodes.invalidRequest],
      ['{"id":1,"method":"ping","params":null}', 0],
      ['{"id":1,"method":"ping","params":[1,2]}', 0],
      ['{"id":1,"method":"ping","params":"x"}', 0],
      ['{"id":1,"method":"pair.complete","params":{"code":null}}', ErrorCodes.invalidParams],
      ['{"id":1,"method":"auth.verify","params":{"signature":{"a":1}}}', ErrorCodes.invalidParams],
      ['{"id":{"huge":"object"},"method":"ping"}', 0],
      ['not json at all', ErrorCodes.parse],
      ['{"method":"ping"}', -1], // notification: no reply expected
    ]
    for (const [text, expected] of probes) {
      if (expected === -1) {
        c.sendRaw(text)
        continue
      }
      const reply = await roundTrip(c, text)
      if (expected === 0) expect(reply.result, text).toBeDefined()
      else expect((reply.error as { code: number }).code, text).toBe(expected)
      if (text.startsWith('{"id":{')) expect(reply.id).toBeNull()
    }
    // The daemon is still alive and serving.
    expect(await c.call('ping')).toMatchObject({ tls: false })
    expect(daemon.httpServer.listening).toBe(true)
    c.close()
  })

  it('installCrashGuards keeps the process alive on stray errors (handlers registered, removable)', () => {
    const before = { rej: process.listenerCount('unhandledRejection'), exc: process.listenerCount('uncaughtException') }
    const messages: string[] = []
    const uninstall = installCrashGuards((m) => messages.push(m))
    expect(process.listenerCount('unhandledRejection')).toBe(before.rej + 1)
    expect(process.listenerCount('uncaughtException')).toBe(before.exc + 1)
    // Exercise the handlers directly (emitting for real would also trip the test runner's own hooks).
    const handlers = process.listeners('uncaughtException')
    ;(handlers[handlers.length - 1] as (err: Error) => void)(new Error('boom'))
    const rejections = process.listeners('unhandledRejection')
    ;(rejections[rejections.length - 1] as (reason: unknown) => void)(new TypeError("Cannot read properties of null (reading 'method')"))
    expect(messages[0]).toMatch(/uncaught exception \(daemon keeps serving\): Error: boom/)
    expect(messages[1]).toMatch(/unhandled rejection \(daemon keeps serving\): TypeError: Cannot read/)
    uninstall()
    expect(process.listenerCount('unhandledRejection')).toBe(before.rej)
    expect(process.listenerCount('uncaughtException')).toBe(before.exc)
  })
})

describe('2. pairing brute force', () => {
  afterEach(() => vi.useRealTimers())

  it('locks pairing after 5 failures within 5 minutes with exponential backoff (unit)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const dir = tempDir()
    const printed: string[] = []
    const pairing = new Pairing(dir, new DeviceRegistry(dir), (m) => printed.push(m))
    const device = loadOrCreateDevice(join(dir, 'client'))
    expect(pairing.status()).toEqual({ pending: false, expiresAt: undefined, lockedForMs: 0 })
    // Even without a pending code, guesses count as failures.
    const notLocked = (r: ReturnType<Pairing['complete']>) => {
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.locked).toBeFalsy()
    }
    for (let i = 0; i < MAX_FAILURES - 1; i++) notLocked(pairing.complete('123456', device.publicKey, 'x'))
    const locked = pairing.complete('123456', device.publicKey, 'x')
    expect(locked).toMatchObject({ ok: false, locked: true, retryAfterMs: LOCKOUT_MS })
    expect(pairing.lockedForMs()).toBe(LOCKOUT_MS)
    expect(printed.join('\n')).toMatch(/pairing locked for 60 s/)
    // While locked, even the right code is refused and does not consume the code.
    const code = pairing.start()
    expect(pairing.complete(code.code, device.publicKey, 'x')).toMatchObject({ ok: false, locked: true })
    expect(pairing.status()).toMatchObject({ pending: true, lockedForMs: LOCKOUT_MS })
    vi.advanceTimersByTime(LOCKOUT_MS + 1)
    expect(pairing.lockedForMs()).toBe(0)
    // Next streak: 5 failures again -> twice as long.
    for (let i = 0; i < MAX_FAILURES; i++) pairing.complete('000000', device.publicKey, 'x')
    expect(pairing.lockedForMs()).toBe(LOCKOUT_MS * 2)
    expect(readFileSync(join(dir, 'pairing.json'), 'utf8')).toBe('null') // 5 wrong guesses killed the code too
    vi.advanceTimersByTime(LOCKOUT_MS * 2 + 1)
    for (let i = 0; i < MAX_FAILURES; i++) pairing.complete('000000', device.publicKey, 'x')
    expect(pairing.lockedForMs()).toBe(LOCKOUT_MS * 4)
    vi.advanceTimersByTime(LOCKOUT_MS * 4 + 1)
    // Failures spread over more than the window do not accumulate.
    for (let i = 0; i < MAX_FAILURES - 1; i++) pairing.complete('000000', device.publicKey, 'x')
    vi.advanceTimersByTime(FAILURE_WINDOW_MS + 1)
    notLocked(pairing.complete('000000', device.publicKey, 'x'))
    // A successful pairing resets the streak.
    const good = pairing.start()
    expect(pairing.complete(good.code, device.publicKey, 'x').ok).toBe(true)
  })

  it('over the socket: pair.start mints nothing, failures close the socket, lockout applies globally', async () => {
    const logs: string[] = []
    const dir = tempDir()
    const daemon = await startDaemon({ port: 0, dataDir: dir, root: dir, tls: true, log: (m) => logs.push(m) })
    try {
      const device = loadOrCreateDevice(join(dir, 'client'), 'bot')
      for (let i = 0; i < 20; i++) {
        const c = await SomedClient.connect(daemon.url, { insecure: true })
        expect(await c.call('pair.start')).toMatchObject({ pending: false })
        c.close()
      }
      expect(existsSync(join(dir, 'pairing.json'))).toBe(false)
      expect(logs.join('\n')).not.toMatch(/Pairing code/)

      const code = daemon.pairing.start()
      let lockedAt = -1
      for (let i = 0; i < MAX_FAILURES; i++) {
        const c = await SomedClient.connect(daemon.url, { insecure: true })
        const closed = new Promise<number>((res) => c.ws.once('close', (closeCode) => res(closeCode)))
        let message = ''
        await c.pair(device, '999999').catch((e: Error) => (message = e.message))
        expect(message).toMatch(/wrong pairing code|invalidated|locked/)
        expect(await closed).toBe(1008) // the daemon hangs up after every failure
        if (/locked/.test(message)) lockedAt = i
      }
      expect(lockedAt).toBe(MAX_FAILURES - 1)
      expect(logs.filter((l) => /pairing failed from 127\.0\.0\.1:\d+/.test(l))).toHaveLength(MAX_FAILURES)
      // Locked: the right code (if it still existed) is refused from any connection.
      const c = await SomedClient.connect(daemon.url, { insecure: true })
      expect(await c.call('pair.start')).toMatchObject({ pending: false })
      await expect(c.pair(device, code.code)).rejects.toMatchObject({ code: ErrorCodes.pairing, message: expect.stringMatching(/locked/) })
      expect(daemon.pairing.lockedForMs()).toBeGreaterThan(0)
      expect(daemon.registry.list()).toHaveLength(0)
    } finally {
      await daemon.close()
    }
  })
})

describe('3. certificate pinning (trust on first use)', () => {
  it('stores the pin in device.json, keyed by host:port, and reloads it', () => {
    const dir = tempDir()
    const device = loadOrCreateDevice(join(dir, 'client'), 'laptop')
    expect(device.pins).toEqual({})
    expect(serverKey('wss://LocalHost:7700')).toBe('localhost:7700')
    expect(serverKey('wss://example.org')).toBe('example.org:443')
    expect(serverKey('ws://[::1]:7700/x')).toBe('[::1]:7700')
    savePin(device, serverKey('wss://localhost:7700'), 'ab:cd')
    const reloaded = loadOrCreateDevice(join(dir, 'client'))
    expect(reloaded.pins).toEqual({ 'localhost:7700': 'AB:CD' })
    expect(reloaded.publicKey).toBe(device.publicKey)
    expect(statSync(join(dir, 'client', 'device.json')).mode & 0o777).toBe(0o600)
  })

  it('the observed fingerprint on first use equals the daemon certificate, and a pinned mismatch is refused', async () => {
    const dir = tempDir()
    const daemon = await startDaemon({ port: 0, dataDir: dir, root: dir, tls: true, log: () => {} })
    try {
      const c = await SomedClient.connect(daemon.url, { trustOnFirstUse: true })
      expect(c.peerFingerprint).toBe(daemon.tls!.fingerprint)
      expect(c.peerCertHash).toEqual(daemon.tls!.certHash)
      c.close()
      const device = loadOrCreateDevice(join(dir, 'client'))
      savePin(device, serverKey(daemon.url), 'AA:BB') // a pin from "another" daemon
      await expect(SomedClient.connect(daemon.url, { fingerprint: device.pins[serverKey(daemon.url)] })).rejects.toThrow(/fingerprint mismatch/)
      // Default (no insecure / pin / TOFU) verifies the self-signed certificate and fails.
      await expect(SomedClient.connect(daemon.url)).rejects.toThrow()
    } finally {
      await daemon.close()
    }
  })
})

describe('4. terminal size limits', () => {
  it('checkSize requires safe integers inside the limits', () => {
    expect(checkSize(80, 24)).toBeUndefined()
    expect(checkSize(SIZE_LIMITS.maxCols, SIZE_LIMITS.maxRows)).toBeUndefined()
    expect(checkSize(20000, 20000)).toMatch(/cols must be between 2 and 1000/)
    expect(checkSize(80, 501)).toMatch(/rows must be between 1 and 500/)
    expect(checkSize(1, 24)).toMatch(/cols/)
    expect(checkSize(80, 0)).toMatch(/rows/)
    expect(checkSize(80.5, 24)).toMatch(/safe integers/)
    expect(checkSize(Number.MAX_SAFE_INTEGER + 2, 24)).toMatch(/safe integers/)
    expect(checkSize('80', 24)).toMatch(/safe integers/)
    expect(checkSize(NaN, Infinity)).toMatch(/safe integers/)
  })

  it('session.create / session.resize reject absurd sizes with invalidParams', async () => {
    const root = tempDir()
    const { daemon, connect } = await startPaired({ root })
    try {
      const c = await connect()
      for (const bad of [{ cols: 20000, rows: 20000 }, { cols: 1.5, rows: 24 }, { cols: 'x', rows: 24 }, { cols: 0, rows: 24 }, { cols: 80, rows: -1 }, { cols: 1e300, rows: 24 }]) {
        await expect(c.call('session.create', { shell: 'bash', ...bad })).rejects.toMatchObject({ code: ErrorCodes.invalidParams })
      }
      expect(daemon.sessions.liveCount).toBe(0)
      const s = await c.call<{ id: string }>('session.create', { shell: 'bash', cols: 80, rows: 24 })
      for (const bad of [{ cols: 20000, rows: 20000 }, { cols: 1001, rows: 24 }, { cols: 80, rows: 501 }, { cols: 80.1, rows: 24 }, { cols: null, rows: 24 }]) {
        await expect(c.call('session.resize', { id: s.id, ...bad })).rejects.toMatchObject({ code: ErrorCodes.invalidParams })
      }
      expect(daemon.sessions.get(s.id)!.info).toMatchObject({ cols: 80, rows: 24 })
      await c.call('session.resize', { id: s.id, cols: SIZE_LIMITS.maxCols, rows: SIZE_LIMITS.maxRows })
      expect(daemon.sessions.get(s.id)!.info).toMatchObject({ cols: 1000, rows: 500 })
      c.close()
    } finally {
      await daemon.close()
    }
  })
})

/** The daemon-side socket of a client (matched by port). */
function serverSideOf(daemon: Daemon, c: SomedClient): WebSocket {
  const port = (c.ws as unknown as { _socket: Socket })._socket.localPort
  const ws = [...daemon.wss.clients].find((w) => (w as unknown as { _socket: Socket })._socket.remotePort === port)
  if (!ws) throw new Error('server-side socket not found')
  return ws
}

describe('5. send-queue backpressure', () => {
  it('pauses the PTY when the socket queue is over the high-water mark, resumes on drain, detaches and closes a client stalled too long', async () => {
    const home = fakeHome()
    const logs: string[] = []
    const { daemon, connect } = await startPaired({ root: realpathSync(tmpdir()), stallTimeoutMs: 400, stallPollMs: 25, sendHighWaterBytes: 1024, sendLowWaterBytes: 256 }, logs)
    try {
      const c = await connect()
      const s = await c.call<{ id: string }>('session.create', { shell: 'bash', cwd: home, cols: 80, rows: 24 })
      const session = daemon.sessions.get(s.id)!
      await c.waitFor((m) => m === 'cwd')
      expect(session.paused).toBe(false)
      // Simulate a client that stopped reading: the kernel buffers are full, ws queues in memory.
      const serverWs = serverSideOf(daemon, c)
      let queued = 0
      Object.defineProperty(serverWs, 'bufferedAmount', { get: () => queued, configurable: true })
      queued = 10_000
      session.write('echo one\r') // output arrives while the queue is over the mark
      await vi.waitFor(() => expect(session.paused).toBe(true), { timeout: 2000 })
      expect(c.ws.readyState).toBe(c.ws.OPEN)
      // While it is stalled, its requests are refused instead of executed.
      await expect(c.call('session.input', { id: s.id, data: 'echo never\r' })).rejects.toMatchObject({ code: ErrorCodes.limit, message: /slow consumer/ })
      // The client drains: everything resumes and output keeps flowing.
      queued = 0
      await vi.waitFor(() => expect(session.paused).toBe(false), { timeout: 2000 })
      const end = c.waitFor((m, p) => m === 'block.end' && p.sessionId === s.id)
      await c.call('session.input', { id: s.id, data: 'echo two\r' })
      await end
      // Stalled for longer than stallTimeoutMs: the session is detached (and resumed), the client
      // is told and then closed with 1013 "slow consumer".
      queued = 10_000
      const closed = new Promise<[number, string]>((res) => c.ws.once('close', (code, reason) => res([code, reason.toString()])))
      const detached = c.waitFor((m, p) => m === 'session.detached' && p.id === s.id, 5000)
      session.write('echo three\r')
      await vi.waitFor(() => expect(session.paused).toBe(true), { timeout: 2000 })
      expect((await detached).params).toMatchObject({ reason: 'slow-consumer' })
      expect(await closed).toEqual([1013, 'slow consumer'])
      expect(session.paused).toBe(false)
      expect(logs.join('\n')).toMatch(/did not read for \d+ s .*detaching 1 session\(s\) and closing/)
      await vi.waitFor(() => expect(daemon.wss.clients.size).toBe(0), { timeout: 2000 })
      // The shell is still alive and finished the command; a new connection replays what was missed.
      expect(session.alive).toBe(true)
      await vi.waitFor(() => expect(session.info.blockCount).toBe(3), { timeout: 5000 })
      const c2 = await connect()
      const again = await c2.attach(s.id, 0)
      expect(again.events.filter((e) => e.type === 'block.command').map((e) => (e as { commandLine: string }).commandLine)).toEqual(['echo one', 'echo two', 'echo three'])
      c2.close()
    } finally {
      await daemon.close()
    }
  }, 20_000)
})

describe('11. request handling while a client is not reading', () => {
  it('handles frames in order, refuses requests and drops notifications while stalled, closes with 1013, terminates at the hard cap', async () => {
    const root = tempDir()
    const logs: string[] = []
    const { daemon, connect } = await startPaired({ root, sendHighWaterBytes: 256 * 1024, sendLowWaterBytes: 64 * 1024, sendHardCapBytes: 48 * 1024 * 1024, stallTimeoutMs: 500, stallPollMs: 25 }, logs)
    try {
      // 16 MiB so one reply overflows the kernel send buffer into ws.bufferedAmount; a smaller
      // reply fits in the kernel entirely and never trips the mark.
      const bigSize = 16 * 1024 * 1024
      writeFileSync(join(root, 'big.bin'), Buffer.alloc(bigSize, 0x61))
      // Frames of one connection run one after the other: a read sent right behind a write sees it.
      const c0 = await connect()
      const written = c0.call('fs.write', { path: 'ordered.txt', content: 'first' })
      const read = c0.call<{ content: string }>('fs.read', { path: 'ordered.txt' })
      await written
      expect((await read).content).toBe('first')
      c0.close()
      await vi.waitFor(() => expect(daemon.wss.clients.size).toBe(0), { timeout: 2000 })

      // A client that stops reading its socket but keeps sending (a stuck UI re-requesting files):
      // the first replies fill the kernel buffers, then the queue passes the high-water mark and
      // every further request is refused without running, notifications are dropped.
      const monitor = await connect()
      const stalled = await connect()
      const serverWs = serverSideOf(daemon, stalled)
      const sock = (stalled.ws as unknown as { _socket: Socket })._socket
      sock.pause()
      const N = 60
      const reads = Array.from({ length: N }, () => stalled.call<{ size: number }>('fs.read', { path: 'big.bin' }))
      stalled.notify('fs.write', { path: 'dropped.txt', content: 'x' })
      const refusedWrite = stalled.call('fs.write', { path: 'refused.txt', content: 'x' })
      // Other connections are served meanwhile...
      const t = Date.now()
      await monitor.call('ping')
      expect(Date.now() - t).toBeLessThan(2000)
      // ...and after the stall timeout the daemon gives up on this one.
      await vi.waitFor(() => expect(serverWs.readyState).not.toBe(serverWs.OPEN), { timeout: 5000 })
      expect(logs.join('\n')).toMatch(/did not read for \d+ s .*closing the connection/)
      // The client wakes up and drains: a few early replies, then -32005 for the rest, then the close.
      const closed = new Promise<[number, string]>((res) => stalled.ws.once('close', (code, reason) => res([code, reason.toString()])))
      sock.resume()
      const settled = await Promise.allSettled(reads)
      const ok = settled.filter((r) => r.status === 'fulfilled' && (r.value as { size: number }).size === bigSize).length
      const refused = settled.filter((r) => r.status === 'rejected' && (r.reason as { code?: number }).code === ErrorCodes.limit).length
      expect(ok + refused).toBe(N)
      expect(ok).toBeGreaterThan(0)
      expect(refused).toBeGreaterThan(0)
      await expect(refusedWrite).rejects.toMatchObject({ code: ErrorCodes.limit, message: /slow consumer/ })
      expect(await closed).toEqual([1013, 'slow consumer'])
      expect(existsSync(join(root, 'dropped.txt'))).toBe(false)
      expect(existsSync(join(root, 'refused.txt'))).toBe(false)

      // Hard cap: a queue that large means the client is not reading at all; the socket is
      // terminated right away (nothing more is queued), the daemon lives on.
      const c3 = await connect()
      Object.defineProperty(serverSideOf(daemon, c3), 'bufferedAmount', { get: () => 100 * 1024 * 1024, configurable: true })
      const closed3 = new Promise<number>((res) => c3.ws.once('close', (code) => res(code)))
      await expect(c3.call('ping')).rejects.toThrow(/connection closed/)
      expect(await closed3).toBe(1006)
      expect(logs.join('\n')).toMatch(/hard cap 50331648\): terminating the connection/)
      expect(await monitor.call('ping')).toMatchObject({ tls: true })
      monitor.close()
    } finally {
      await daemon.close()
    }
  }, 30_000)
})

describe('6. root confinement', () => {
  it('safePath resolves symlinks of the existing prefix and rejects anything outside root', () => {
    const base = tempDir()
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    mkdirSync(join(root, 'sub'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret'), 's')
    symlinkSync(outside, join(root, 'link'))
    symlinkSync(join(outside, 'secret'), join(root, 'file-link'))
    symlinkSync(join(root, 'sub'), join(root, 'inner-link'))
    expect(safePath(root, '.')).toBe(root)
    expect(safePath(root, root)).toBe(root)
    expect(safePath(root, 'sub')).toBe(join(root, 'sub'))
    expect(safePath(root, 'sub/new/file.txt')).toBe(join(root, 'sub', 'new', 'file.txt'))
    expect(safePath(root, 'inner-link/x')).toBe(join(root, 'sub', 'x'))
    for (const p of ['..', '../outside/secret', '/etc/passwd', 'link', 'link/secret', 'link/new', 'file-link', 'sub/../../outside', `${root}2`]) {
      expect(() => safePath(root, p), p).toThrow(/outside the daemon root/)
    }
    expect(() => safePath(root, 'a\0b')).toThrow(/NUL/)
  })

  it('fs.* and session.create.cwd are confined to --root; the daemon state directory is off limits', async () => {
    const base = tempDir()
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret'), 'top secret')
    writeFileSync(join(root, 'ok.txt'), 'fine')
    symlinkSync(outside, join(root, 'link'))
    const dataDir = join(root, 'state') // state dir inside root: still not writable through fs.*
    const { daemon, connect } = await startPaired({ root, dataDir })
    try {
      const c = await connect()
      expect(await c.call('fs.read', { path: 'ok.txt' })).toMatchObject({ content: 'fine', path: join(root, 'ok.txt') })
      expect(await c.call('fs.read', { path: join(root, 'ok.txt') })).toMatchObject({ content: 'fine' })
      const forbidden = { code: ErrorCodes.forbidden }
      await expect(c.call('fs.read', { path: '/etc/passwd' })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.read', { path: '../outside/secret' })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.read', { path: 'link/secret' })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.read', { path: join(outside, 'secret') })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.list', { path: '/' })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.list', { path: 'link' })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.write', { path: 'link/pwned', content: 'x' })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.write', { path: '../outside/pwned', content: 'x' })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.write', { path: '/tmp/pwned-' + process.pid, content: 'x', mkdir: true })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.watch', { path: outside })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.watch', { path: '/', recursive: true })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.read', { path: 'state/devices.json' })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.write', { path: join(dataDir, 'devices.json'), content: '{}' })).rejects.toMatchObject(forbidden)
      await expect(c.call('fs.list', { path: 'state' })).rejects.toMatchObject(forbidden)
      expect(existsSync(join(outside, 'pwned'))).toBe(false)
      expect(readdirSync(root).sort()).toEqual(['link', 'ok.txt', 'state'])
      // Sessions: cwd defaults to root and may not leave it.
      await expect(c.call('session.create', { shell: 'bash', cwd: outside, cols: 80, rows: 24 })).rejects.toMatchObject(forbidden)
      await expect(c.call('session.create', { shell: 'bash', cwd: 'link', cols: 80, rows: 24 })).rejects.toMatchObject(forbidden)
      await expect(c.call('session.create', { shell: 'bash', cwd: 'ok.txt', cols: 80, rows: 24 })).rejects.toMatchObject({ code: ErrorCodes.invalidParams })
      const s = await c.call<{ id: string; cwd: string }>('session.create', { shell: 'bash', cols: 80, rows: 24 })
      expect(s.cwd).toBe(root)
      expect(daemon.sessions.get(s.id)!.meta.cwd).toBe(root)
      expect((await c.call<{ root: string }>('server.info')).root).toBe(root)
      c.close()
    } finally {
      await daemon.close()
    }
  })
})

describe('7. fs edge cases', () => {
  it('fs.read refuses non-regular files promptly and fs.write replaces atomically, keeping the mode', async () => {
    const root = tempDir()
    const { daemon, connect } = await startPaired({ root })
    try {
      const c = await connect()
      execFileSync('mkfifo', [join(root, 'fifo')])
      mkdirSync(join(root, 'dir'))
      symlinkSync('/dev/zero', join(root, 'zero'))
      const t0 = Date.now()
      await expect(c.call('fs.read', { path: 'fifo' })).rejects.toMatchObject({ code: ErrorCodes.invalidParams, message: /not a regular file/ })
      expect(Date.now() - t0).toBeLessThan(2000) // did not block on the FIFO
      await expect(c.call('fs.read', { path: 'dir' })).rejects.toMatchObject({ code: ErrorCodes.invalidParams })
      await expect(c.call('fs.read', { path: 'zero' })).rejects.toMatchObject({ code: ErrorCodes.forbidden }) // symlink out of root
      await expect(c.call('fs.write', { path: 'dir', content: 'x' })).rejects.toMatchObject({ code: ErrorCodes.invalidParams })
      await expect(c.call('fs.write', { path: 'fifo', content: 'x' })).rejects.toMatchObject({ code: ErrorCodes.invalidParams })

      // Atomic write preserving mode.
      const target = join(root, 'conf')
      writeFileSync(target, 'old')
      chmodSync(target, 0o640)
      const ino = statSync(target).ino
      expect(await c.call('fs.write', { path: 'conf', content: 'new content' })).toEqual({ path: target, size: 11 })
      expect(readFileSync(target, 'utf8')).toBe('new content')
      expect(statSync(target).mode & 0o777).toBe(0o640)
      expect(statSync(target).ino).not.toBe(ino) // replaced by rename, not truncated in place
      expect(readdirSync(root).filter((f) => f.startsWith('.tmp-'))).toEqual([])
      // New file: default mode, parent created on request.
      expect(await c.call('fs.write', { path: 'deep/er/new.txt', content: 'x', mkdir: true })).toMatchObject({ size: 1 })
      expect(readFileSync(join(root, 'deep', 'er', 'new.txt'), 'utf8')).toBe('x')
      await expect(c.call('fs.write', { path: 'nodir/new.txt', content: 'x' })).rejects.toMatchObject({ code: ErrorCodes.internal })
      expect(readdirSync(root).filter((f) => f.startsWith('.tmp-'))).toEqual([])

      // Symlinks: one inside root is followed to its target (the link survives), one outside is refused.
      symlinkSync(target, join(root, 'conf-link'))
      expect(await c.call('fs.write', { path: 'conf-link', content: 'via link' })).toMatchObject({ path: target })
      expect(readFileSync(target, 'utf8')).toBe('via link')
      expect(lstatSync(join(root, 'conf-link')).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(root, 'conf-link'))).toBe(target)
      symlinkSync(join(tmpdir(), `somed-harden-escape-${process.pid}`), join(root, 'escape'))
      await expect(c.call('fs.write', { path: 'escape', content: 'x' })).rejects.toMatchObject({ code: ErrorCodes.forbidden })
      expect(existsSync(join(tmpdir(), `somed-harden-escape-${process.pid}`))).toBe(false)
      // Size caps: a file over 16 MiB is refused (sparse file, nothing is actually read)...
      writeFileSync(join(root, 'huge'), '')
      truncateSync(join(root, 'huge'), 16 * 1024 * 1024 + 1)
      await expect(c.call('fs.read', { path: 'huge' })).rejects.toMatchObject({ code: ErrorCodes.invalidParams, message: /too large/ })
      // ...and a frame over 16 MiB never reaches a handler: ws closes the socket (1009) and the daemon lives on.
      const closed = new Promise<number>((res) => c.ws.once('close', (code) => res(code)))
      await expect(c.call('fs.write', { path: 'big', content: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64'), encoding: 'base64' })).rejects.toThrow(/connection closed/)
      expect(await closed).toBe(1009)
      expect(existsSync(join(root, 'big'))).toBe(false)
      const c2 = await connect()
      expect(await c2.call('ping')).toMatchObject({ tls: true })
      c2.close()
    } finally {
      await daemon.close()
    }
  }, 20_000)
})

describe('9. session resource hygiene', () => {
  it('caps live sessions, evicts dead ones from memory, keeps them listable from disk', async () => {
    const home = fakeHome()
    const { daemon, connect } = await startPaired({ root: realpathSync(tmpdir()), maxSessions: 2 })
    try {
      expect(DEFAULT_MAX_SESSIONS).toBe(64)
      const c = await connect()
      const a = await c.call<{ id: string }>('session.create', { shell: 'bash', cwd: home, cols: 80, rows: 24 })
      const b = await c.call<{ id: string }>('session.create', { shell: 'bash', cwd: home, cols: 80, rows: 24 })
      await expect(c.call('session.create', { shell: 'bash', cwd: home, cols: 80, rows: 24 })).rejects.toMatchObject({ code: ErrorCodes.limit })
      expect(daemon.sessions.liveCount).toBe(2)
      const exited = c.waitFor((m, p) => m === 'session.exit' && p.sessionId === a.id)
      await c.waitFor((m, p) => m === 'cwd' && p.sessionId === a.id)
      await c.call('session.input', { id: a.id, data: 'echo bye; exit 5\r' })
      await exited
      expect(daemon.sessions.get(a.id)).toBeUndefined()
      expect(daemon.sessions.liveCount).toBe(1)
      const list = await c.call<{ sessions: { id: string; alive: boolean; exitCode?: number; blockCount: number }[]; persisted: string[] }>('session.list')
      expect(list.sessions.find((s) => s.id === a.id)).toMatchObject({ alive: false, exitCode: 5, blockCount: 1 })
      expect(list.sessions.find((s) => s.id === b.id)).toMatchObject({ alive: true })
      expect(list.persisted).toContain(a.id)
      // Room again for a new one; the dead session's log is still replayable.
      const d = await c.call<{ id: string }>('session.create', { shell: 'bash', cwd: home, cols: 80, rows: 24 })
      expect(d.id).not.toBe(a.id)
      const replay = await c.attach(a.id, 0)
      expect(replay.alive).toBe(false)
      expect(replay.info).toMatchObject({ id: a.id, alive: false, exitCode: 5 })
      expect(replay.events.at(-1)).toMatchObject({ type: 'session.exit', exitCode: 5, blockCount: 1 })
      await expect(c.call('session.attach', { id: 'does-not-exist' })).rejects.toMatchObject({ code: ErrorCodes.notFound })
      await expect(c.call('session.attach', { id: '../../etc/passwd' })).rejects.toMatchObject({ code: ErrorCodes.invalidParams })
      c.close()
    } finally {
      await daemon.close()
    }
  }, 20_000)

  it('stops persisting block.output once the log cap is hit but keeps block.end', async () => {
    const home = fakeHome()
    const { daemon, connect } = await startPaired({ root: realpathSync(tmpdir()), maxLogBytes: 3000 })
    try {
      const c = await connect()
      const s = await c.call<{ id: string }>('session.create', { shell: 'bash', cwd: home, cols: 80, rows: 24 })
      await c.waitFor((m, p) => m === 'cwd' && p.sessionId === s.id)
      let end = c.waitFor((m, p) => m === 'block.end' && p.sessionId === s.id)
      await c.call('session.input', { id: s.id, data: 'seq 1000\r' })
      await end
      end = c.waitFor((m, p) => m === 'block.end' && p.sessionId === s.id)
      const liveOutput: string[] = []
      const off = c.onNotification((m, p) => {
        if (m === 'block.output') liveOutput.push(p.text as string)
      })
      await c.call('session.input', { id: s.id, data: 'echo after-cap\r' })
      await end
      off()
      expect(liveOutput.join('')).toBe('after-cap\n') // live streaming is unaffected
      const info = daemon.sessions.get(s.id)!.info
      expect(info.logTruncated).toBe(true)
      const size = statSync(daemon.sessions.store.pathFor(s.id)).size
      expect(size).toBeLessThan(3000 + 500)
      const events = (await c.attach(s.id, 0)).events
      const types = events.map((e) => e.type)
      expect(types.filter((t) => t === 'block.end')).toHaveLength(2)
      expect(types.filter((t) => t === 'block.command')).toHaveLength(2)
      expect(events.filter((e) => e.type === 'block.output' && (e as { text: string }).text.includes('after-cap'))).toHaveLength(0)
      c.close()
    } finally {
      await daemon.close()
    }
  }, 20_000)

  it('replays long logs in pages of at most 1000 events', async () => {
    const root = tempDir()
    const { daemon, connect } = await startPaired({ root })
    try {
      // A synthetic log with 2 350 events.
      const store = new SessionStore(daemon.sessions.store.dir.replace(/\/sessions$/, ''))
      const log = store.open('synthetic')
      log.append({ type: 'session.meta', id: 'synthetic', shell: '/bin/bash', cwd: root, cols: 80, rows: 24, createdAt: 1, pid: 1 })
      for (let i = 0; i < 2348; i++) log.append({ type: 'block.output', id: 'synthetic:1', text: `line ${i}\n` })
      log.append({ type: 'session.exit', exitCode: 0, blockCount: 1 })
      log.close()
      expect(readLogSummary(store.pathFor('synthetic'))).toMatchObject({ lastSeq: 2350, exit: { exitCode: 0 } })
      expect(store.read('synthetic', 0, 5000)).toHaveLength(MAX_REPLAY_CHUNK)
      const c = await connect()
      const first = await c.call<{ events: StoredEvent[]; more: boolean; nextSeq: number; alive: boolean; info: { id: string } }>('session.attach', { id: 'synthetic', fromSeq: 0, limit: 100_000 })
      expect(first.events).toHaveLength(1000)
      expect(first).toMatchObject({ more: true, nextSeq: 1000, alive: false, info: { id: 'synthetic', alive: false } })
      const second = await c.call<{ events: StoredEvent[]; more: boolean; nextSeq: number }>('session.replay', { id: 'synthetic', fromSeq: first.nextSeq, limit: 10 })
      expect(second.events.map((e) => e.seq)).toEqual(Array.from({ length: 10 }, (_, i) => 1001 + i))
      expect(second.more).toBe(true)
      const all = await c.attach('synthetic', 0)
      expect(all.events).toHaveLength(2350)
      expect(all.events.map((e) => e.seq)).toEqual(Array.from({ length: 2350 }, (_, i) => i + 1))
      const tail = await c.call<{ events: StoredEvent[]; more: boolean }>('session.replay', { id: 'synthetic', fromSeq: 2349 })
      expect(tail).toMatchObject({ more: false, events: [{ seq: 2350, type: 'session.exit' }] })
      const list = await c.call<{ sessions: { id: string }[] }>('session.list')
      expect(list.sessions.find((s) => s.id === 'synthetic')).toMatchObject({ alive: false, exitCode: 0, lastSeq: 2350 })
      c.close()
    } finally {
      await daemon.close()
    }
  })

  it('SessionManager.create enforces the cap and bad sizes without a daemon', () => {
    const manager = new SessionManager(tempDir(), { maxSessions: 0 })
    expect(() => manager.create({ shell: 'bash' })).toThrow(/too many live sessions/)
    const manager2 = new SessionManager(tempDir())
    expect(() => manager2.create({ shell: 'bash', cols: 5000, rows: 24 })).toThrow(RangeError)
    expect(manager2.liveCount).toBe(0)
  })
})

describe('10. device names and temp directories', () => {
  it('strips control characters from device names before storing and logging', () => {
    expect(sanitizeDeviceName('evil\x1b[31mname\n\r\x7f\x00 ok')).toBe('evil[31mname ok')
    expect(sanitizeDeviceName('')).toBe('device')
    expect(sanitizeDeviceName(undefined)).toBe('device')
    expect(sanitizeDeviceName('\x1b\x1b')).toBe('device')
    expect(sanitizeDeviceName('x'.repeat(200))).toHaveLength(80)
    const dir = tempDir()
    const logs: string[] = []
    const registry = new DeviceRegistry(dir)
    const pairing = new Pairing(dir, registry, (m) => logs.push(m))
    const device = loadOrCreateDevice(join(dir, 'client'))
    const code = pairing.start()
    expect(pairing.complete(code.code, device.publicKey, 'lap\x1b]0;pwned\x07top\n')).toMatchObject({ ok: true, device: { name: 'lap]0;pwnedtop' } })
    expect(registry.get(device.publicKey)?.name).toBe('lap]0;pwnedtop')
    const stored = readFileSync(join(dir, 'devices.json'), 'utf8')
    expect(stored).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/)
    expect(logs.join('')).not.toMatch(/\x1b|\x07/)
    // Names that reach the registry by other paths are cleaned too.
    registry.add({ publicKey: 'k', name: 'a\x07b', pairedAt: 1 })
    expect(registry.get('k')?.name).toBe('ab')
  })
})

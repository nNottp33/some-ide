import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Authenticator, DeviceRegistry, Pairing, generatePairingCode, readPairingFile, writePairingFile } from '../src/auth.ts'
import { loadOrCreateDevice, RpcClientError, signNonce, SomedClient, type DeviceIdentity } from '../src/client.ts'
import { ensureTls, startDaemon, type Daemon } from '../src/server.ts'
import { fakeHome } from './helpers.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'somed-test-'))
}

describe('pairing and Ed25519 authentication (unit)', () => {
  it('pairs a device with the printed code and rejects wrong codes', () => {
    const dir = tempDir()
    const registry = new DeviceRegistry(dir)
    const printed: string[] = []
    const pairing = new Pairing(dir, registry, (m) => printed.push(m))
    const code = pairing.start()
    expect(code.code).toMatch(/^\d{6}$/)
    expect(printed.join('\n')).toContain(code.code)
    expect(readPairingFile(dir)?.code).toBe(code.code)
    const device = loadOrCreateDevice(join(dir, 'client'), 'laptop')
    expect(pairing.complete('000000', device.publicKey, 'laptop')).toMatchObject({ ok: false })
    expect(pairing.complete('not-a-key', 'zzz', 'laptop')).toMatchObject({ ok: false })
    const r = pairing.complete(code.code, device.publicKey, 'laptop')
    expect(r.ok).toBe(true)
    expect(registry.get(device.publicKey)?.name).toBe('laptop')
    expect(JSON.parse(readFileSync(join(dir, 'devices.json'), 'utf8')).devices).toHaveLength(1)
    // Code is single use.
    expect(pairing.complete(code.code, device.publicKey, 'laptop')).toMatchObject({ ok: false })
    expect(readPairingFile(dir)).toBeUndefined()
  })

  it('invalidates the code after too many wrong attempts', () => {
    const dir = tempDir()
    const pairing = new Pairing(dir, new DeviceRegistry(dir))
    const code = pairing.start()
    const device = loadOrCreateDevice(join(dir, 'client'))
    for (let i = 0; i < 5; i++) pairing.complete('111111', device.publicKey, 'x')
    expect(pairing.complete(code.code, device.publicKey, 'x')).toMatchObject({ ok: false })
  })

  it('accepts a code written by the `somed pair` CLI (pairing.json)', () => {
    const dir = tempDir()
    const code = generatePairingCode()
    writePairingFile(dir, { code, expiresAt: Date.now() + 60_000 })
    const registry = new DeviceRegistry(dir)
    const pairing = new Pairing(dir, registry)
    const device = loadOrCreateDevice(join(dir, 'client'))
    expect(pairing.complete(code, device.publicKey, 'phone').ok).toBe(true)
  })

  it('challenge/response with Node crypto', () => {
    const dir = tempDir()
    const registry = new DeviceRegistry(dir)
    const device = loadOrCreateDevice(join(dir, 'client'))
    registry.add({ publicKey: device.publicKey, name: 'd', pairedAt: Date.now() })
    const auth = new Authenticator(registry)
    expect(auth.verify('abc')).toMatchObject({ ok: false, error: 'no challenge outstanding' })
    const unknown = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    expect(auth.challenge(unknown)).toMatchObject({ ok: false })
    const ch = auth.challenge(device.publicKey)
    expect(ch.ok).toBe(true)
    if (!ch.ok) return
    // Wrong key signing the nonce fails.
    const other = generateKeyPairSync('ed25519').privateKey
    expect(auth.verify(signNonce(ch.nonce, other))).toMatchObject({ ok: false })
    expect(auth.authenticated).toBe(false)
    const ch2 = auth.challenge(device.publicKey)
    if (!ch2.ok) return
    expect(auth.verify(signNonce(ch2.nonce, device.privateKey))).toMatchObject({ ok: true })
    expect(auth.authenticated).toBe(true)
    // The device identity file is reloaded with the same key.
    expect(loadOrCreateDevice(join(dir, 'client')).publicKey).toBe(device.publicKey)
  })
})

describe('TLS material', () => {
  it('generates a self-signed certificate with openssl on first start', () => {
    const dir = tempDir()
    const tls = ensureTls(dir)
    expect(tls).toBeDefined()
    expect(tls!.cert.toString()).toContain('BEGIN CERTIFICATE')
    expect(tls!.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    // Second call re-uses the files.
    expect(ensureTls(dir)!.fingerprint).toBe(tls!.fingerprint)
  })
})

describe('daemon over WebSocket', () => {
  let daemon: Daemon
  let dir: string
  let device: DeviceIdentity
  let home: string
  const logs: string[] = []

  beforeAll(async () => {
    dir = tempDir()
    home = fakeHome()
    device = loadOrCreateDevice(join(dir, 'client'), 'test-device')
    daemon = await startDaemon({ port: 0, dataDir: dir, tls: true, log: (m) => logs.push(m) })
  }, 20_000)

  afterAll(async () => {
    await daemon.close()
  })

  async function connectAuthenticated(): Promise<SomedClient> {
    const c = await SomedClient.connect(daemon.url, { fingerprint: daemon.tls!.fingerprint })
    await c.authenticate(device)
    return c
  }

  it('serves wss and refuses authenticated methods before auth', async () => {
    expect(daemon.url.startsWith('wss://')).toBe(true)
    const c = await SomedClient.connect(daemon.url, { insecure: true })
    expect(await c.call('ping')).toMatchObject({ tls: true })
    await expect(c.call('session.list')).rejects.toMatchObject({ code: -32001 })
    await expect(c.call('nope')).rejects.toMatchObject({ code: -32001 })
    c.close()
  })

  it('rejects a connection pinned to the wrong fingerprint', async () => {
    await expect(SomedClient.connect(daemon.url, { fingerprint: 'AA:BB' })).rejects.toThrow(/fingerprint/)
  })

  it('pairs with the code printed on the console, then authenticates', async () => {
    const c = await SomedClient.connect(daemon.url, { insecure: true })
    const started = await c.call<{ expiresAt: number }>('pair.start')
    expect(started.expiresAt).toBeGreaterThan(Date.now())
    const code = /Pairing code: (\d{6})/.exec(logs.join('\n'))?.[1]
    expect(code).toBeDefined()
    await expect(c.pair(device, '000000')).rejects.toMatchObject({ code: -32003 })
    await c.pair(device, code!)
    expect(daemon.registry.get(device.publicKey)?.name).toBe('test-device')
    // Not yet authenticated: pairing alone does not grant access.
    await expect(c.call('session.list')).rejects.toMatchObject({ code: -32001 })
    await c.authenticate(device)
    const info = await c.call<{ shells: string[]; tls: boolean }>('server.info')
    expect(info.tls).toBe(true)
    expect(info.shells).toContain('bash')
    c.close()
  })

  it('rejects a forged signature', async () => {
    const c = await SomedClient.connect(daemon.url, { insecure: true })
    const { nonce } = await c.call<{ nonce: string }>('auth.challenge', { devicePublicKey: device.publicKey })
    const other = generateKeyPairSync('ed25519').privateKey
    await expect(c.call('auth.verify', { signature: signNonce(nonce, other) })).rejects.toMatchObject({ code: -32001 })
    c.close()
  })

  it('creates a session, streams block events, survives disconnect and replays from seq', async () => {
    const c1 = await connectAuthenticated()
    const received: Record<string, unknown>[] = []
    c1.onNotification((method, params) => received.push({ method, ...params }))
    const session = await c1.call<{ id: string; shell: string }>('session.create', { shell: 'bash', cwd: home, cols: 80, rows: 24 })
    expect(session.shell).toMatch(/bash$/)
    await c1.waitFor((m) => m === 'cwd')
    const end = c1.waitFor((m) => m === 'block.end')
    await c1.call('session.input', { id: session.id, data: 'echo via-ws\r' })
    const ended = await end
    expect(ended.params).toMatchObject({ sessionId: session.id, exitCode: 0 })
    const output = received.find((r) => r.method === 'block.output')
    expect(output).toMatchObject({ text: 'via-ws\n' })
    expect(received.some((r) => r.method === 'session.data')).toBe(true)
    const lastSeq = ended.params.seq as number

    // Disconnect: the session keeps running.
    c1.close()
    await new Promise((r) => setTimeout(r, 100))
    expect(daemon.sessions.get(session.id)?.alive).toBe(true)
    const list = await (await connectAuthenticated()).call<{ sessions: { id: string; alive: boolean }[] }>('session.list')
    expect(list.sessions.find((s) => s.id === session.id)?.alive).toBe(true)

    // Reattach from another client, replaying only what we missed.
    const c2 = await connectAuthenticated()
    const attached = await c2.call<{ alive: boolean; events: { seq: number; type: string }[]; scrollback: string }>('session.attach', { id: session.id, fromSeq: 0 })
    expect(attached.alive).toBe(true)
    expect(attached.events[0]).toMatchObject({ seq: 1, type: 'session.meta' })
    expect(attached.events.map((e) => e.type)).toEqual(expect.arrayContaining(['block.start', 'block.command', 'block.output', 'block.end']))
    expect(attached.scrollback).toContain('via-ws')
    const partial = await c2.call<{ events: { seq: number }[] }>('session.attach', { id: session.id, fromSeq: lastSeq })
    expect(partial.events.every((e) => e.seq > lastSeq)).toBe(true)

    // Live events continue to flow to the reattached client.
    const end2 = c2.waitFor((m) => m === 'block.end')
    await c2.call('session.input', { id: session.id, data: 'false\r' })
    expect((await end2).params).toMatchObject({ exitCode: 1 })
    await c2.call('session.resize', { id: session.id, cols: 120, rows: 40 })

    // Kill and verify the exit is persisted.
    const exit = c2.waitFor((m) => m === 'session.exit')
    await c2.call('session.kill', { id: session.id })
    await exit
    const persisted = daemon.sessions.replay(session.id)
    expect(persisted.at(-1)?.type).toBe('session.exit')
    expect(existsSync(join(dir, 'sessions', `${session.id}.jsonl`))).toBe(true)
    await expect(c2.call('session.input', { id: 'nope', data: 'x' })).rejects.toMatchObject({ code: -32002 })
    c2.close()
  }, 20_000)

  it('fs.list / fs.read / fs.write / fs.watch', async () => {
    const c = await connectAuthenticated()
    const root = tempDir()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'a.txt'), 'hello')
    const list = await c.call<{ entries: { name: string; type: string; size?: number }[] }>('fs.list', { path: root })
    expect(list.entries.map((e) => [e.name, e.type]).sort()).toEqual([
      ['a.txt', 'file'],
      ['sub', 'dir'],
    ])
    expect(await c.call('fs.read', { path: join(root, 'a.txt') })).toMatchObject({ content: 'hello', size: 5, encoding: 'utf8' })
    const b64 = await c.call<{ content: string }>('fs.read', { path: join(root, 'a.txt'), encoding: 'base64' })
    expect(Buffer.from(b64.content, 'base64').toString()).toBe('hello')
    const { watchId } = await c.call<{ watchId: string }>('fs.watch', { path: root })
    const event = c.waitFor((m, p) => m === 'fs.event' && p.watchId === watchId)
    await c.call('fs.write', { path: join(root, 'b.txt'), content: 'new file' })
    expect((await event).params).toMatchObject({ watchId, filename: 'b.txt' })
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('new file')
    expect(await c.call('fs.unwatch', { watchId })).toEqual({ ok: true })
    await expect(c.call('fs.read', { path: join(root, 'missing') })).rejects.toBeInstanceOf(RpcClientError)
    c.close()
  })
})

describe('daemon without TLS', () => {
  it('falls back to ws:// with a warning when tls is disabled', async () => {
    const dir = tempDir()
    const logs: string[] = []
    const daemon = await startDaemon({ port: 0, dataDir: dir, tls: false, log: (m) => logs.push(m) })
    try {
      expect(daemon.url.startsWith('ws://')).toBe(true)
      expect(logs.join('\n')).toMatch(/WARNING.*without TLS/)
      const c = await SomedClient.connect(daemon.url)
      expect(await c.call('ping')).toMatchObject({ tls: false })
      c.close()
    } finally {
      await daemon.close()
    }
  })
})

import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Authenticator, DeviceRegistry, Pairing, authPayload, generatePairingCode, readPairingFile, writePairingFile } from '../src/auth.ts'
import { loadOrCreateDevice, RpcClientError, signChallenge, SomedClient, type DeviceIdentity } from '../src/client.ts'
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
    expect(readPairingFile(dir)).toBeUndefined()
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

  it('challenge/response with Node crypto, bound to the server certificate hash', () => {
    const dir = tempDir()
    const registry = new DeviceRegistry(dir)
    const device = loadOrCreateDevice(join(dir, 'client'))
    registry.add({ publicKey: device.publicKey, name: 'd', pairedAt: Date.now() })
    const certHash = Buffer.alloc(32, 7)
    const auth = new Authenticator(registry, certHash)
    expect(auth.verify('abc')).toMatchObject({ ok: false, error: 'no challenge outstanding' })
    const unknown = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    expect(auth.challenge(unknown)).toMatchObject({ ok: false })
    const ch = auth.challenge(device.publicKey)
    expect(ch.ok).toBe(true)
    if (!ch.ok) return
    // Wrong key signing the payload fails.
    const other = generateKeyPairSync('ed25519').privateKey
    expect(auth.verify(signChallenge(ch.nonce, certHash, other))).toMatchObject({ ok: false })
    expect(auth.authenticated).toBe(false)
    // Right key, wrong channel binding (what a relay with its own certificate would obtain) fails.
    const ch2 = auth.challenge(device.publicKey)
    if (!ch2.ok) return
    expect(auth.verify(signChallenge(ch2.nonce, Buffer.alloc(32, 9), device.privateKey))).toMatchObject({ ok: false })
    // Right key, legacy payload (raw nonce only) fails.
    const ch3 = auth.challenge(device.publicKey)
    if (!ch3.ok) return
    const legacy = cryptoSign(null, Buffer.from(ch3.nonce, 'base64'), device.privateKey).toString('base64')
    expect(auth.verify(legacy)).toMatchObject({ ok: false })
    const ch4 = auth.challenge(device.publicKey)
    if (!ch4.ok) return
    expect(auth.verify(signChallenge(ch4.nonce, certHash, device.privateKey))).toMatchObject({ ok: true })
    expect(auth.authenticated).toBe(true)
    expect(authPayload(certHash, Buffer.alloc(32)).subarray(0, 13).toString()).toBe('somed-auth-v1')
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
    expect(tls!.certHash.toString('hex').toUpperCase()).toBe(tls!.fingerprint.replaceAll(':', ''))
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
    daemon = await startDaemon({ port: 0, dataDir: dir, root: realpathSync(tmpdir()), tls: true, log: (m) => logs.push(m) })
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
    expect(c.peerFingerprint).toBe(daemon.tls!.fingerprint)
    await expect(c.call('session.list')).rejects.toMatchObject({ code: -32001 })
    await expect(c.call('nope')).rejects.toMatchObject({ code: -32001 })
    c.close()
  })

  it('rejects a connection pinned to the wrong fingerprint', async () => {
    await expect(SomedClient.connect(daemon.url, { fingerprint: 'AA:BB' })).rejects.toThrow(/fingerprint/)
  })

  it('pairs with the code printed on the console (never minted over the network), then authenticates', async () => {
    const c = await SomedClient.connect(daemon.url, { insecure: true })
    // pair.start only reports; it does not create a code.
    expect(await c.call('pair.start')).toMatchObject({ pending: false, lockedForMs: 0 })
    expect(logs.join('\n')).not.toMatch(/Pairing code/)
    const started = daemon.pairing.start() // what `somed pair` / `somed serve --pair` do on the host
    expect(await c.call('pair.start')).toMatchObject({ pending: true, expiresAt: started.expiresAt })
    const code = /Pairing code: (\d{6})/.exec(logs.join('\n'))?.[1]
    expect(code).toBe(started.code)
    // A wrong code is refused, logged with the remote address, and the socket is closed.
    const closed = new Promise<number>((res) => c.ws.once('close', (closeCode) => res(closeCode)))
    await expect(c.pair(device, '000000')).rejects.toMatchObject({ code: -32003 })
    expect(await closed).toBe(1008)
    expect(logs.join('\n')).toMatch(/pairing failed from 127\.0\.0\.1:\d+: wrong pairing code/)
    const c2 = await SomedClient.connect(daemon.url, { insecure: true })
    await c2.pair(device, code!)
    expect(daemon.registry.get(device.publicKey)?.name).toBe('test-device')
    // Not yet authenticated: pairing alone does not grant access.
    await expect(c2.call('session.list')).rejects.toMatchObject({ code: -32001 })
    await c2.authenticate(device)
    const info = await c2.call<{ shells: string[]; tls: boolean; root: string; limits: { maxSessions: number } }>('server.info')
    expect(info.tls).toBe(true)
    expect(info.shells).toContain('bash')
    expect(info.root).toBe(daemon.root)
    expect(info.limits.maxSessions).toBe(64)
    c2.close()
  })

  it('rejects forged, relayed and legacy signatures', async () => {
    const c = await SomedClient.connect(daemon.url, { insecure: true })
    const other = generateKeyPairSync('ed25519').privateKey
    let { nonce } = await c.call<{ nonce: string }>('auth.challenge', { devicePublicKey: device.publicKey })
    await expect(c.call('auth.verify', { signature: signChallenge(nonce, c.peerCertHash, other) })).rejects.toMatchObject({ code: -32001 })
    // Relay: the device signed what it saw on a connection to an attacker with another certificate.
    ;({ nonce } = await c.call<{ nonce: string }>('auth.challenge', { devicePublicKey: device.publicKey }))
    await expect(c.call('auth.verify', { signature: signChallenge(nonce, Buffer.alloc(32, 1), device.privateKey) })).rejects.toMatchObject({ code: -32001 })
    // Legacy payload (signature over the raw nonce).
    ;({ nonce } = await c.call<{ nonce: string }>('auth.challenge', { devicePublicKey: device.publicKey }))
    const legacy = cryptoSign(null, Buffer.from(nonce, 'base64'), device.privateKey).toString('base64')
    await expect(c.call('auth.verify', { signature: legacy })).rejects.toMatchObject({ code: -32001 })
    await expect(c.call('session.list')).rejects.toMatchObject({ code: -32001 })
    expect(logs.join('\n')).toMatch(/authentication failed from 127\.0\.0\.1:\d+/)
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
    const attached = await c2.call<{ alive: boolean; events: { seq: number; type: string }[]; scrollback: string; more: boolean }>('session.attach', { id: session.id, fromSeq: 0 })
    expect(attached.alive).toBe(true)
    expect(attached.more).toBe(false)
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

    // Kill and verify the exit is persisted; the dead session is evicted from memory but still listed.
    const exit = c2.waitFor((m) => m === 'session.exit')
    await c2.call('session.kill', { id: session.id })
    await exit
    const persisted = daemon.sessions.replay(session.id)
    expect(persisted.at(-1)?.type).toBe('session.exit')
    expect(existsSync(join(dir, 'sessions', `${session.id}.jsonl`))).toBe(true)
    expect(daemon.sessions.get(session.id)).toBeUndefined()
    const after = await c2.call<{ sessions: { id: string; alive: boolean; blockCount: number }[] }>('session.list')
    expect(after.sessions.find((s) => s.id === session.id)).toMatchObject({ alive: false, blockCount: 2 })
    const dead = await c2.attach(session.id, 0)
    expect(dead.alive).toBe(false)
    expect(dead.events.at(-1)?.type).toBe('session.exit')
    await expect(c2.call('session.input', { id: session.id, data: 'x' })).rejects.toMatchObject({ code: -32002 })
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
    const event = c.waitFor((m, p) => m === 'fs.event' && p.watchId === watchId && p.filename === 'b.txt')
    await c.call('fs.write', { path: join(root, 'b.txt'), content: 'new file' })
    expect((await event).params).toMatchObject({ watchId, filename: 'b.txt' })
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('new file')
    expect(await c.call('fs.unwatch', { watchId })).toEqual({ ok: true })
    await expect(c.call('fs.read', { path: join(root, 'missing') })).rejects.toBeInstanceOf(RpcClientError)
    c.close()
  })
})

describe('daemon without TLS', () => {
  it('falls back to ws:// with a warning when tls is disabled, auth uses the empty channel binding', async () => {
    const dir = tempDir()
    const logs: string[] = []
    const daemon = await startDaemon({ port: 0, dataDir: dir, root: dir, tls: false, log: (m) => logs.push(m) })
    try {
      expect(daemon.url.startsWith('ws://')).toBe(true)
      expect(logs.join('\n')).toMatch(/WARNING.*without TLS/)
      const c = await SomedClient.connect(daemon.url)
      expect(await c.call('ping')).toMatchObject({ tls: false })
      expect(c.peerCertHash).toBeUndefined()
      const device = loadOrCreateDevice(join(dir, 'client'), 'plain')
      const code = daemon.pairing.start()
      await c.pair(device, code.code)
      await c.authenticate(device)
      expect(await c.call('server.info')).toMatchObject({ tls: false })
      c.close()
    } finally {
      await daemon.close()
    }
  })
})

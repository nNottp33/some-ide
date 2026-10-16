/**
 * Minimal client for the somed protocol (used by the `somed client` demo and the tests).
 *
 * TLS trust: the daemon uses a self-signed certificate, so a client must either pin its SHA-256
 * fingerprint (`fingerprint`), accept whatever it sees on first use (`trustOnFirstUse`, meant
 * for pairing; the demo CLI stores the observed fingerprint in device.json and enforces it from
 * then on) or explicitly opt out of verification (`insecure`). Authentication signs the
 * certificate hash the client saw on its own socket, so a relay with a different certificate
 * cannot reuse the signature against the real daemon.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { WebSocket } from 'ws'
import { authPayload } from './auth.ts'
import type { StoredEvent } from './store.ts'
import { defer } from './util.ts'

export interface DeviceIdentity {
  /** Base64 SPKI DER Ed25519 public key. */
  publicKey: string
  privateKey: KeyObject
  name: string
  /** Where the identity is stored (device.json); undefined for in-memory identities. */
  path?: string
  /** Pinned daemon certificate fingerprints by server key (`host:port`), learnt at pairing time. */
  pins: Record<string, string>
}

interface DeviceFile {
  publicKey: string
  privateKeyPem: string
  name: string
  pins?: Record<string, string>
}

/** Load the device key from <dir>/device.json or create a new Ed25519 identity there. */
export function loadOrCreateDevice(dir: string, name?: string): DeviceIdentity {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'device.json')
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as DeviceFile
    const pins: Record<string, string> = {}
    if (parsed.pins && typeof parsed.pins === 'object') {
      for (const [k, v] of Object.entries(parsed.pins)) if (typeof v === 'string') pins[k] = v
    }
    return { publicKey: parsed.publicKey, privateKey: createPrivateKey(parsed.privateKeyPem), name: parsed.name, path, pins }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const file: DeviceFile = {
    publicKey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    name: name ?? `${hostname()}-somed-client`,
    pins: {},
  }
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
  return { publicKey: file.publicKey, privateKey, name: file.name, path, pins: {} }
}

/** The key under which a daemon's fingerprint is pinned: lower-case host and port of its URL. */
export function serverKey(url: string): string {
  const u = new URL(url)
  const port = u.port || (u.protocol === 'wss:' || u.protocol === 'https:' ? '443' : '80')
  return `${u.hostname.toLowerCase()}:${port}`
}

/** Remember the daemon's certificate fingerprint in device.json (trust on first use). */
export function savePin(device: DeviceIdentity, key: string, fingerprint: string): void {
  device.pins[key] = fingerprint.toUpperCase()
  if (!device.path) return
  const parsed = JSON.parse(readFileSync(device.path, 'utf8')) as DeviceFile
  parsed.pins = device.pins
  writeFileSync(device.path, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
}

/**
 * Sign an `auth.challenge` nonce: the payload is "somed-auth-v1" || sha256(server cert DER) || nonce,
 * `serverCertHash` being what the client observed on its TLS socket (undefined without TLS).
 */
export function signChallenge(nonceBase64: string, serverCertHash: Buffer | undefined, privateKey: KeyObject): string {
  return cryptoSign(null, authPayload(serverCertHash, Buffer.from(nonceBase64, 'base64')), privateKey).toString('base64')
}

export interface ConnectOptions {
  /** Accept any certificate without pinning (explicit opt-out; the CLI prints a warning). */
  insecure?: boolean
  /** Pin the daemon certificate by its SHA-256 fingerprint ("AB:CD:…"). */
  fingerprint?: string
  /** Accept the certificate seen on this connection; read it back from `peerFingerprint` and pin it. */
  trustOnFirstUse?: boolean
  timeoutMs?: number
}

export class RpcClientError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export interface ReplayPage {
  events: StoredEvent[]
  more: boolean
  nextSeq: number
}

export class SomedClient {
  readonly ws: WebSocket
  /** SHA-256 of the daemon certificate as seen on this socket (undefined for ws://). */
  readonly peerCertHash: Buffer | undefined
  /** Same, colon separated hex ("AB:CD:…"). */
  readonly peerFingerprint: string | undefined
  #nextId = 1
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  readonly #listeners = new Set<(method: string, params: Record<string, unknown>) => void>()

  private constructor(ws: WebSocket, peerCertHash: Buffer | undefined) {
    this.ws = ws
    this.peerCertHash = peerCertHash
    this.peerFingerprint = peerCertHash ? peerCertHash.toString('hex').toUpperCase().match(/.{2}/g)!.join(':') : undefined
    ws.on('message', (raw) => {
      let msg: { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown> }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (typeof msg.id === 'number' && this.#pending.has(msg.id)) {
        const p = this.#pending.get(msg.id)!
        this.#pending.delete(msg.id)
        if (msg.error) p.reject(new RpcClientError(msg.error.code, msg.error.message))
        else p.resolve(msg.result)
      } else if (typeof msg.method === 'string') {
        for (const l of this.#listeners) l(msg.method, msg.params ?? {})
      }
    })
    ws.on('close', () => {
      for (const p of this.#pending.values()) p.reject(new Error('connection closed'))
      this.#pending.clear()
    })
  }

  static connect(url: string, options: ConnectOptions = {}): Promise<SomedClient> {
    const d = defer<SomedClient>()
    const trustAny = Boolean(options.insecure || options.fingerprint || options.trustOnFirstUse)
    const ws = new WebSocket(url, { rejectUnauthorized: !trustAny, handshakeTimeout: options.timeoutMs ?? 10_000 })
    let certHash: Buffer | undefined
    ws.on('upgrade', (res) => {
      const socket = res.socket as TLSSocket
      if (typeof socket.getPeerCertificate !== 'function') return
      const cert = socket.getPeerCertificate()
      if (cert && cert.raw) certHash = createHash('sha256').update(cert.raw).digest()
      if (options.fingerprint) {
        const wanted = options.fingerprint.toUpperCase()
        const actual = cert?.fingerprint256
        if (actual !== wanted) {
          ws.terminate()
          d.reject(new Error(`certificate fingerprint mismatch: got ${actual}, expected ${wanted}`))
        }
      }
    })
    ws.once('open', () => d.resolve(new SomedClient(ws, certHash)))
    ws.once('error', (err) => d.reject(err))
    return d.promise
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.#nextId++
    const d = defer<unknown>()
    this.#pending.set(id, d)
    this.ws.send(JSON.stringify({ id, method, params }))
    return d.promise as Promise<T>
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.ws.send(JSON.stringify({ method, params }))
  }

  /** Send a raw text frame (tests: malformed requests). */
  sendRaw(text: string): void {
    this.ws.send(text)
  }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Wait for the next notification matching `predicate`. */
  waitFor(predicate: (method: string, params: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<{ method: string; params: Record<string, unknown> }> {
    const d = defer<{ method: string; params: Record<string, unknown> }>()
    const timer = setTimeout(() => {
      off()
      d.reject(new Error('timeout waiting for notification'))
    }, timeoutMs)
    const off = this.onNotification((method, params) => {
      if (predicate(method, params)) {
        clearTimeout(timer)
        off()
        d.resolve({ method, params })
      }
    })
    return d.promise
  }

  async pair(device: DeviceIdentity, code: string): Promise<void> {
    await this.call('pair.complete', { code, devicePublicKey: device.publicKey, deviceName: device.name })
  }

  async authenticate(device: DeviceIdentity): Promise<void> {
    const { nonce } = await this.call<{ nonce: string }>('auth.challenge', { devicePublicKey: device.publicKey })
    await this.call('auth.verify', { signature: signChallenge(nonce, this.peerCertHash, device.privateKey) })
  }

  /**
   * Attach to a session and collect its whole persisted history: the first page comes with
   * `session.attach`, the rest through `session.replay` pages of at most 1000 events.
   */
  async attach(id: string, fromSeq = 0): Promise<{ info: unknown; alive: boolean; events: StoredEvent[]; scrollback: string }> {
    const first = await this.call<ReplayPage & { info: unknown; alive: boolean; scrollback: string }>('session.attach', { id, fromSeq })
    const events = [...first.events]
    let { more, nextSeq } = first
    while (more) {
      const page = await this.call<ReplayPage>('session.replay', { id, fromSeq: nextSeq })
      events.push(...page.events)
      more = page.more
      nextSeq = page.nextSeq
    }
    return { info: first.info, alive: first.alive, events, scrollback: first.scrollback }
  }

  close(): void {
    this.ws.close()
  }
}

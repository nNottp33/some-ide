/**
 * Minimal client for the somed protocol (used by the `somed client` demo and the tests).
 */
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { WebSocket } from 'ws'
import { defer } from './util.ts'

export interface DeviceIdentity {
  /** Base64 SPKI DER Ed25519 public key. */
  publicKey: string
  privateKey: KeyObject
  name: string
}

/** Load the device key from <dir>/device.json or create a new Ed25519 identity there. */
export function loadOrCreateDevice(dir: string, name?: string): DeviceIdentity {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'device.json')
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { publicKey: string; privateKeyPem: string; name: string }
    return { publicKey: parsed.publicKey, privateKey: createPrivateKey(parsed.privateKeyPem), name: parsed.name }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const identity = {
    publicKey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    name: name ?? `${hostname()}-somed-client`,
  }
  writeFileSync(path, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 })
  return { publicKey: identity.publicKey, privateKey, name: identity.name }
}

export function signNonce(nonceBase64: string, privateKey: KeyObject): string {
  return cryptoSign(null, Buffer.from(nonceBase64, 'base64'), privateKey).toString('base64')
}

export interface ConnectOptions {
  /** Accept any certificate (self-signed daemon cert). */
  insecure?: boolean
  /** Pin the daemon certificate by its SHA-256 fingerprint ("AB:CD:…"). Implies insecure. */
  fingerprint?: string
  timeoutMs?: number
}

export class RpcClientError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export class SomedClient {
  readonly ws: WebSocket
  #nextId = 1
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  readonly #listeners = new Set<(method: string, params: Record<string, unknown>) => void>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (raw) => {
      let msg: { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: Record<string, unknown> }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
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
    const ws = new WebSocket(url, { rejectUnauthorized: !(options.insecure || options.fingerprint), handshakeTimeout: options.timeoutMs ?? 10_000 })
    if (options.fingerprint) {
      const wanted = options.fingerprint.toUpperCase()
      ws.on('upgrade', (res) => {
        const socket = res.socket as TLSSocket
        const actual = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate().fingerprint256 : undefined
        if (actual !== wanted) {
          ws.terminate()
          d.reject(new Error(`certificate fingerprint mismatch: got ${actual}, expected ${wanted}`))
        }
      })
    }
    ws.once('open', () => d.resolve(new SomedClient(ws)))
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
    await this.call('auth.verify', { signature: signNonce(nonce, device.privateKey) })
  }

  close(): void {
    this.ws.close()
  }
}

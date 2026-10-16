/**
 * Device pairing and authentication.
 *
 * Pairing: a 6-digit code is created on the host side only (the `somed pair` CLI or `somed serve
 * --pair`; both write <dataDir>/pairing.json and print the code). The network can only ask
 * whether a code is pending (`pair.start`) and present a guess together with an Ed25519 public
 * key (`pair.complete`). Paired devices are stored in <dataDir>/devices.json.
 *
 * Brute force: a code is single use, expires after 5 minutes and dies after 5 wrong guesses.
 * On top of that, failed `pair.complete` calls are counted globally (whatever the code): 5
 * failures within 5 minutes lock pairing for 60 s, doubling on every further lockout (1 h cap).
 *
 * Authentication: `auth.challenge {devicePublicKey}` returns a random nonce; the client signs
 *   "somed-auth-v1" || sha256(server certificate DER) || nonce
 * with its private key and sends `auth.verify {signature}`. The certificate hash binds the
 * signature to the TLS channel the client actually sees: a relay with its own certificate cannot
 * forward the signature to the real daemon. Without TLS the hash is 32 zero bytes (and the
 * channel offers no protection at all). Verification uses Node's built-in Ed25519 support.
 */
import { createPublicKey, randomBytes, randomInt, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PairedDevice {
  /** Base64 SPKI DER encoding of the Ed25519 public key. */
  publicKey: string
  name: string
  pairedAt: number
  lastSeenAt?: number
}

export interface PairingCode {
  code: string
  expiresAt: number
}

export const CODE_TTL_MS = 5 * 60 * 1000
/** Wrong guesses a single code survives. */
export const MAX_ATTEMPTS_PER_CODE = 5
/** Failed `pair.complete` calls (any code, any reason) within FAILURE_WINDOW_MS that trigger a lockout. */
export const MAX_FAILURES = 5
export const FAILURE_WINDOW_MS = 5 * 60 * 1000
export const LOCKOUT_MS = 60 * 1000
export const MAX_LOCKOUT_MS = 60 * 60 * 1000
/** A lockout streak is forgotten after this much time without a failure. */
const LOCKOUT_DECAY_MS = 60 * 60 * 1000

/** Domain separation prefix of the authentication payload. */
export const AUTH_PREFIX = Buffer.from('somed-auth-v1', 'utf8')
/** Channel binding used when the connection is not TLS protected. */
export const NO_CHANNEL_BINDING: Buffer = Buffer.alloc(32)

export function generatePairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/** Device names end up in logs and in devices.json: drop control characters and cap the length. */
export function sanitizeDeviceName(name: unknown): string {
  const clean = String(name ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 80)
  return clean.length > 0 ? clean : 'device'
}

export function readPairingFile(dataDir: string): PairingCode | undefined {
  const p = join(dataDir, 'pairing.json')
  if (!existsSync(p)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as PairingCode
    if (typeof parsed.code !== 'string' || typeof parsed.expiresAt !== 'number') return undefined
    if (parsed.expiresAt < Date.now()) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function writePairingFile(dataDir: string, code: PairingCode | undefined): void {
  const p = join(dataDir, 'pairing.json')
  writeFileSync(p, JSON.stringify(code ?? null), { mode: 0o600 })
}

/** Turn a base64 SPKI DER (or PEM) Ed25519 public key into a KeyObject, or undefined if invalid. */
export function importPublicKey(encoded: string): KeyObject | undefined {
  try {
    const key = encoded.includes('-----BEGIN')
      ? createPublicKey(encoded)
      : createPublicKey({ key: Buffer.from(encoded, 'base64'), type: 'spki', format: 'der' })
    if (key.asymmetricKeyType !== 'ed25519') return undefined
    return key
  } catch {
    return undefined
  }
}

/** Canonical base64 SPKI form of a public key, used as the device identity. */
export function canonicalPublicKey(key: KeyObject): string {
  return (key.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
}

/**
 * The bytes a device signs to authenticate: "somed-auth-v1" || sha256(server cert DER) || nonce.
 * `certHash` is the SHA-256 of the server certificate as the client observed it on the TLS socket
 * (undefined / 32 zero bytes without TLS). Both sides build the payload with this function.
 */
export function authPayload(certHash: Buffer | undefined, nonce: Buffer): Buffer {
  const binding = certHash && certHash.length > 0 ? certHash : NO_CHANNEL_BINDING
  if (binding.length !== 32) throw new Error('certificate hash must be 32 bytes')
  return Buffer.concat([AUTH_PREFIX, binding, nonce])
}

/** Parse a colon separated hex fingerprint ("AB:CD:…", as `getPeerCertificate().fingerprint256`) into bytes. */
export function fingerprintToBuffer(fingerprint: string): Buffer {
  const hex = fingerprint.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 64) throw new Error('fingerprint must be a SHA-256 hex digest')
  return Buffer.from(hex, 'hex')
}

export class DeviceRegistry {
  readonly path: string
  #devices: PairedDevice[] = []
  constructor(dataDir: string) {
    this.path = join(dataDir, 'devices.json')
    this.#load()
  }

  #load(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { devices?: PairedDevice[] }
      this.#devices = Array.isArray(parsed.devices) ? parsed.devices : []
    } catch {
      this.#devices = []
    }
  }

  #save(): void {
    writeFileSync(this.path, JSON.stringify({ devices: this.#devices }, null, 2) + '\n', { mode: 0o600 })
  }

  list(): PairedDevice[] {
    return [...this.#devices]
  }

  get(publicKey: string): PairedDevice | undefined {
    return this.#devices.find((d) => d.publicKey === publicKey)
  }

  add(device: PairedDevice): void {
    this.#devices = this.#devices.filter((d) => d.publicKey !== device.publicKey)
    this.#devices.push({ ...device, name: sanitizeDeviceName(device.name) })
    this.#save()
  }

  remove(publicKey: string): boolean {
    const before = this.#devices.length
    this.#devices = this.#devices.filter((d) => d.publicKey !== publicKey)
    if (this.#devices.length !== before) this.#save()
    return this.#devices.length !== before
  }

  touch(publicKey: string): void {
    const d = this.get(publicKey)
    if (d) {
      d.lastSeenAt = Date.now()
      this.#save()
    }
  }
}

export type PairingResult =
  | { ok: true; device: PairedDevice }
  | { ok: false; error: string; locked?: boolean; retryAfterMs?: number }

export class Pairing {
  readonly #dataDir: string
  readonly #registry: DeviceRegistry
  readonly #log: (msg: string) => void
  #current: PairingCode | undefined
  #attempts = 0
  /** Timestamps of recent failed `complete` calls (any code). */
  #failures: number[] = []
  #lockedUntil = 0
  #lockouts = 0
  #lastFailureAt = 0

  constructor(dataDir: string, registry: DeviceRegistry, log: (msg: string) => void = () => {}) {
    this.#dataDir = dataDir
    this.#registry = registry
    this.#log = log
  }

  /**
   * Create (or re-use a still valid) pairing code and print it on the daemon console. This is a
   * host-side operation (`somed pair`, `somed serve --pair`); it is deliberately not reachable
   * over the network, otherwise a remote client could mint fresh codes after every lockout.
   */
  start(): PairingCode {
    const existing = this.current()
    if (existing) return existing
    const code = { code: generatePairingCode(), expiresAt: Date.now() + CODE_TTL_MS }
    this.#current = code
    this.#attempts = 0
    writePairingFile(this.#dataDir, code)
    this.#log(`\n  Pairing code: ${code.code}   (valid for ${CODE_TTL_MS / 60000} minutes)\n`)
    return code
  }

  /** The currently valid code, from memory or from pairing.json (written by `somed pair`). */
  current(): PairingCode | undefined {
    if (this.#current && this.#current.expiresAt > Date.now()) return this.#current
    const fromFile = readPairingFile(this.#dataDir)
    if (fromFile) {
      this.#current = fromFile
      this.#attempts = 0
    }
    return this.#current && this.#current.expiresAt > Date.now() ? this.#current : undefined
  }

  /** What `pair.start` may tell the network: whether a code is pending and until when. */
  status(): { pending: boolean; expiresAt?: number; lockedForMs: number } {
    const c = this.current()
    return { pending: c !== undefined, expiresAt: c?.expiresAt, lockedForMs: this.lockedForMs() }
  }

  /** Milliseconds until `complete` accepts attempts again (0 when not locked). */
  lockedForMs(now = Date.now()): number {
    return Math.max(0, this.#lockedUntil - now)
  }

  complete(code: string, devicePublicKey: string, deviceName: string): PairingResult {
    const now = Date.now()
    const locked = this.lockedForMs(now)
    if (locked > 0) {
      return { ok: false, error: `pairing locked after too many failed attempts, retry in ${Math.ceil(locked / 1000)} s`, locked: true, retryAfterMs: locked }
    }
    const key = importPublicKey(devicePublicKey)
    if (!key) return this.#fail(now, 'devicePublicKey must be a base64 SPKI DER Ed25519 public key')
    const current = this.current()
    if (!current) return this.#fail(now, 'no pairing in progress (run `somed pair` on the host)')
    const a = Buffer.from(String(code))
    const b = Buffer.from(current.code)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.#attempts++
      if (this.#attempts >= MAX_ATTEMPTS_PER_CODE) {
        this.#current = undefined
        writePairingFile(this.#dataDir, undefined)
        return this.#fail(now, 'too many attempts, pairing code invalidated')
      }
      return this.#fail(now, 'wrong pairing code')
    }
    this.#current = undefined
    writePairingFile(this.#dataDir, undefined)
    this.#failures = []
    this.#lockouts = 0
    const device: PairedDevice = { publicKey: canonicalPublicKey(key), name: sanitizeDeviceName(deviceName), pairedAt: now }
    this.#registry.add(device)
    this.#log(`  Paired device "${device.name}"`)
    return { ok: true, device }
  }

  #fail(now: number, error: string): PairingResult {
    if (now - this.#lastFailureAt > LOCKOUT_DECAY_MS) this.#lockouts = 0
    this.#lastFailureAt = now
    this.#failures = this.#failures.filter((t) => now - t < FAILURE_WINDOW_MS)
    this.#failures.push(now)
    if (this.#failures.length >= MAX_FAILURES) {
      const duration = Math.min(LOCKOUT_MS * 2 ** this.#lockouts, MAX_LOCKOUT_MS)
      this.#lockouts++
      this.#lockedUntil = now + duration
      this.#failures = []
      this.#log(`  pairing locked for ${Math.round(duration / 1000)} s after ${MAX_FAILURES} failed attempts`)
      return { ok: false, error: `${error}; pairing locked for ${Math.round(duration / 1000)} s`, locked: true, retryAfterMs: duration }
    }
    return { ok: false, error }
  }
}

/** Per-connection authentication state machine. */
export class Authenticator {
  readonly #registry: DeviceRegistry
  /** SHA-256 of the daemon's own certificate DER (undefined without TLS). */
  readonly #certHash: Buffer | undefined
  #pending: { publicKey: string; key: KeyObject; nonce: Buffer; expiresAt: number } | undefined
  #device: PairedDevice | undefined

  constructor(registry: DeviceRegistry, certHash?: Buffer) {
    this.#registry = registry
    this.#certHash = certHash
  }

  get device(): PairedDevice | undefined {
    return this.#device
  }

  get authenticated(): boolean {
    return this.#device !== undefined
  }

  challenge(devicePublicKey: string): { ok: true; nonce: string } | { ok: false; error: string } {
    const key = importPublicKey(devicePublicKey)
    if (!key) return { ok: false, error: 'invalid devicePublicKey' }
    const canonical = canonicalPublicKey(key)
    if (!this.#registry.get(canonical)) return { ok: false, error: 'unknown device, pair first' }
    const nonce = randomBytes(32)
    this.#pending = { publicKey: canonical, key, nonce, expiresAt: Date.now() + 60_000 }
    return { ok: true, nonce: nonce.toString('base64') }
  }

  verify(signature: string): { ok: true; device: PairedDevice } | { ok: false; error: string } {
    const pending = this.#pending
    this.#pending = undefined
    if (!pending) return { ok: false, error: 'no challenge outstanding' }
    if (pending.expiresAt < Date.now()) return { ok: false, error: 'challenge expired' }
    let sig: Buffer
    try {
      sig = Buffer.from(String(signature), 'base64')
    } catch {
      return { ok: false, error: 'invalid signature encoding' }
    }
    let valid = false
    try {
      valid = cryptoVerify(null, authPayload(this.#certHash, pending.nonce), pending.key, sig)
    } catch {
      valid = false
    }
    if (!valid) return { ok: false, error: 'signature verification failed' }
    const device = this.#registry.get(pending.publicKey)
    if (!device) return { ok: false, error: 'device was unpaired' }
    this.#registry.touch(device.publicKey)
    this.#device = device
    return { ok: true, device }
  }
}

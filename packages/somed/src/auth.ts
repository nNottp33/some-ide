/**
 * Device pairing and authentication.
 *
 * Pairing: the daemon prints a 6-digit code (`pair.start` or `somed pair`); the client sends it
 * together with its Ed25519 public key (`pair.complete`). Paired devices are stored in
 * <dataDir>/devices.json. The current code is also written to <dataDir>/pairing.json so the
 * `somed pair` CLI and the server share it.
 *
 * Authentication: `auth.challenge {devicePublicKey}` returns a random nonce; the client signs it
 * with its private key and sends `auth.verify {signature}`. Verification uses Node's built-in
 * Ed25519 support (crypto.verify with a null algorithm).
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

const CODE_TTL_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 5

export function generatePairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
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
    this.#devices.push(device)
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

export class Pairing {
  readonly #dataDir: string
  readonly #registry: DeviceRegistry
  readonly #log: (msg: string) => void
  #current: PairingCode | undefined
  #attempts = 0

  constructor(dataDir: string, registry: DeviceRegistry, log: (msg: string) => void = () => {}) {
    this.#dataDir = dataDir
    this.#registry = registry
    this.#log = log
  }

  /** Create (or re-use a still valid) pairing code; prints it on the server console. */
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

  complete(code: string, devicePublicKey: string, deviceName: string): { ok: true; device: PairedDevice } | { ok: false; error: string } {
    const key = importPublicKey(devicePublicKey)
    if (!key) return { ok: false, error: 'devicePublicKey must be a base64 SPKI DER Ed25519 public key' }
    const current = this.current()
    if (!current) return { ok: false, error: 'no pairing in progress (call pair.start or run `somed pair`)' }
    const a = Buffer.from(String(code))
    const b = Buffer.from(current.code)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.#attempts++
      if (this.#attempts >= MAX_ATTEMPTS) {
        this.#current = undefined
        writePairingFile(this.#dataDir, undefined)
        return { ok: false, error: 'too many attempts, pairing code invalidated' }
      }
      return { ok: false, error: 'wrong pairing code' }
    }
    this.#current = undefined
    writePairingFile(this.#dataDir, undefined)
    const device: PairedDevice = { publicKey: canonicalPublicKey(key), name: String(deviceName || 'device').slice(0, 80), pairedAt: Date.now() }
    this.#registry.add(device)
    this.#log(`  Paired device "${device.name}"`)
    return { ok: true, device }
  }
}

/** Per-connection authentication state machine. */
export class Authenticator {
  readonly #registry: DeviceRegistry
  #pending: { publicKey: string; key: KeyObject; nonce: Buffer; expiresAt: number } | undefined
  #device: PairedDevice | undefined

  constructor(registry: DeviceRegistry) {
    this.#registry = registry
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
      valid = cryptoVerify(null, pending.nonce, pending.key, sig)
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

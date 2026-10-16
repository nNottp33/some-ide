/**
 * WebSocket JSON-RPC-style server.
 *
 *   request:      { id, method, params }
 *   response:     { id, result } | { id, error: { code, message } }
 *   notification: { method, params }            (server -> client, no id)
 *
 * Unauthenticated methods: ping, pair.start, pair.complete, auth.challenge, auth.verify.
 * Everything else requires a completed Ed25519 challenge/response on this connection.
 *
 * Hardening summary (see README "Threat model"):
 *  - every frame is validated before any property access and every handler failure is turned
 *    into an error response; `installCrashGuards` keeps the process alive on stray errors;
 *  - pairing codes are never created over the network; failed `pair.complete` calls are rate
 *    limited globally, close the socket and are logged with the remote address;
 *  - the auth signature is bound to the TLS certificate the client saw (relay/MITM resistant);
 *  - terminal sizes, session count, replay page size (events and bytes) and file sizes are bounded;
 *  - a client that stops reading pauses the PTYs it is attached to instead of filling memory;
 *    while its send queue is over the high-water mark its requests are refused (-32005) instead
 *    of being executed, it is detached and closed (1013) after `stallTimeoutMs`, and a queue over
 *    the hard cap terminates the socket at once;
 *  - frames of one connection are handled one at a time, in order (no 80 concurrent file reads
 *    from one TCP chunk, and `fs.write` followed by `fs.read` of the same path cannot race);
 *  - every `fs.*` path and `session.create.cwd` must resolve (through symlinks) inside `root`.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { Authenticator, DeviceRegistry, Pairing } from './auth.ts'
import { SessionLimitError, SessionManager, SIZE_LIMITS, checkSize, type Session } from './session.ts'
import { MAX_REPLAY_CHUNK } from './store.ts'
import { which } from './util.ts'

export interface RpcError {
  code: number
  message: string
}

export const ErrorCodes = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32001,
  notFound: -32002,
  pairing: -32003,
  /** Path outside `--root` (or inside the daemon's own state directory). */
  forbidden: -32004,
  /** A resource cap was hit (sessions, watchers), or the connection's send queue is full (slow consumer). */
  limit: -32005,
} as const

/** Largest file `fs.read` returns / `fs.write` accepts. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024
export const MAX_WATCHERS_PER_CONNECTION = 64
export const DEFAULT_SEND_HIGH_WATER = 4 * 1024 * 1024
export const DEFAULT_SEND_LOW_WATER = 1024 * 1024
/** Send queue size at which a connection is terminated outright (a client that is not reading at all). */
export const DEFAULT_SEND_HARD_CAP = 64 * 1024 * 1024
export const DEFAULT_STALL_TIMEOUT_MS = 30_000

export interface DaemonOptions {
  port?: number
  host?: string
  dataDir: string
  /**
   * Directory the `fs.*` methods and `session.create.cwd` are confined to (default: the current
   * working directory). Resolved through symlinks at start.
   */
  root?: string
  /** Use TLS when a certificate can be generated/found (default true). */
  tls?: boolean
  log?: (msg: string) => void
  /** Most live sessions (default 64). */
  maxSessions?: number
  /** Per-session log cap in bytes (default 64 MiB). */
  maxLogBytes?: number
  /** Socket send queue size at which the PTYs attached to a connection are paused (default 4 MiB). */
  sendHighWaterBytes?: number
  /** Queue size below which they resume (default 1 MiB). */
  sendLowWaterBytes?: number
  /** Queue size at which the socket is terminated without waiting (default 64 MiB). */
  sendHardCapBytes?: number
  /** A connection whose queue stays above the high-water mark this long is detached and closed (default 30 s). */
  stallTimeoutMs?: number
  /** How often a stalled connection's queue is checked (default 250 ms). */
  stallPollMs?: number
}

export interface TlsMaterial {
  cert: Buffer
  key: Buffer
  certPath: string
  /** SHA-256 of the certificate DER, colon separated hex. */
  fingerprint: string
  /** SHA-256 of the certificate DER, raw (channel binding of the auth payload). */
  certHash: Buffer
}

/** Generate a self-signed certificate with the openssl CLI on first start. Returns undefined when openssl is missing. */
export function ensureTls(dataDir: string, log: (msg: string) => void = () => {}): TlsMaterial | undefined {
  const dir = join(dataDir, 'tls')
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    const openssl = which('openssl')
    if (!openssl) return undefined
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      execFileSync(
        openssl,
        [
          'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
          '-keyout', keyPath, '-out', certPath, '-days', '3650', '-subj', '/CN=somed',
          '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
      log(`Generated self-signed TLS certificate at ${certPath}`)
    } catch (err) {
      log(`openssl failed: ${(err as Error).message}`)
      return undefined
    }
  }
  const cert = readFileSync(certPath)
  const key = readFileSync(keyPath)
  return { cert, key, certPath, fingerprint: certFingerprint(cert), certHash: certHash(cert) }
}

/** DER bytes of the first certificate in a PEM file. */
export function certDer(pem: Buffer): Buffer {
  const b64 = pem
    .toString('utf8')
    .replace(/[\s\S]*?-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----[\s\S]*$/, '')
    .replace(/\s+/g, '')
  return Buffer.from(b64, 'base64')
}

/** SHA-256 of the certificate DER. */
export function certHash(pem: Buffer): Buffer {
  return createHash('sha256').update(certDer(pem)).digest()
}

/** SHA-256 fingerprint of a PEM certificate (colon separated hex, like browsers show it). */
export function certFingerprint(pem: Buffer): string {
  return certHash(pem).toString('hex').toUpperCase().match(/.{2}/g)!.join(':')
}

type Params = Record<string, unknown>

export class RpcFailure extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

function str(params: Params, key: string, required = true, maxLength = 1 << 20): string {
  const v = params[key]
  if (typeof v === 'string') {
    if (v.length > maxLength) throw new RpcFailure(ErrorCodes.invalidParams, `param "${key}" is too long`)
    return v
  }
  if (!required && v === undefined) return ''
  throw new RpcFailure(ErrorCodes.invalidParams, `param "${key}" must be a string`)
}

function int(params: Params, key: string, fallback?: number): number {
  const v = params[key]
  if (v === undefined && fallback !== undefined) return fallback
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new RpcFailure(ErrorCodes.invalidParams, `param "${key}" must be a safe integer`)
  return v
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/

function sessionId(params: Params): string {
  const id = str(params, 'id', true, 64)
  if (!SESSION_ID.test(id)) throw new RpcFailure(ErrorCodes.invalidParams, 'invalid session id')
  return id
}

/**
 * Resolve `p` (absolute, or relative to `root`) and make sure it lives inside `root`: the longest
 * existing prefix is passed through realpath, so symlinks pointing out of the root are rejected
 * even when the final component does not exist yet. `root` must itself be a realpath.
 */
export function safePath(root: string, p: string): string {
  if (p.includes('\0')) throw new RpcFailure(ErrorCodes.invalidParams, 'path contains NUL')
  const abs = resolve(root, p)
  const missing: string[] = []
  let existing = abs
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    missing.unshift(basename(existing))
    existing = parent
  }
  let real: string
  try {
    real = realpathSync(existing)
  } catch (err) {
    throw new RpcFailure(ErrorCodes.forbidden, `cannot resolve path: ${(err as Error).message}`)
  }
  const full = missing.length > 0 ? join(real, ...missing) : real
  if (!isInside(root, full)) throw new RpcFailure(ErrorCodes.forbidden, 'path outside the daemon root')
  return full
}

/** Is `path` equal to `dir` or below it? Both must be normalised absolute paths. */
function isInside(dir: string, path: string): boolean {
  if (path === dir) return true
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  return path.startsWith(prefix)
}

interface FlowLimits {
  highWater: number
  lowWater: number
  hardCap: number
  stallTimeoutMs: number
  pollMs: number
}

class Connection {
  readonly ws: WebSocket
  readonly auth: Authenticator
  readonly remote: string
  readonly attached = new Map<string, { session: Session; off: () => void }>()
  readonly watchers = new Map<string, FSWatcher>()
  /** Set by a handler that wants the socket closed once its reply went out (pairing failures). */
  closeAfterReply: { code: number; reason: string } | undefined
  #watchCounter = 0
  #stalledSince: number | undefined
  #stallTimer: NodeJS.Timeout | undefined
  readonly #limits: FlowLimits
  readonly #log: (msg: string) => void

  constructor(ws: WebSocket, registry: DeviceRegistry, certHash: Buffer | undefined, remote: string, limits: FlowLimits, log: (msg: string) => void) {
    this.ws = ws
    this.auth = new Authenticator(registry, certHash)
    this.remote = remote
    this.#limits = limits
    this.#log = log
  }

  /**
   * Serialise and queue a frame; never throws. Applies send-queue backpressure to attached PTYs
   * and terminates the socket once the queue passes the hard cap.
   */
  send(frame: unknown): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    if (this.ws.bufferedAmount > this.#limits.hardCap) {
      this.#overflow()
      return
    }
    try {
      this.ws.send(JSON.stringify(frame))
    } catch (err) {
      this.#log(`send to ${this.remote} failed: ${(err as Error).message}`)
      return
    }
    const queued = this.ws.bufferedAmount
    if (queued > this.#limits.hardCap) this.#overflow()
    else if (queued > this.#limits.highWater) this.#stall()
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params })
  }

  /** Close the socket (the frame queues behind any backlog; ws destroys the socket after 30 s if it never drains). */
  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason)
    } catch {
      this.ws.terminate()
    }
  }

  get stalled(): boolean {
    return this.#stalledSince !== undefined
  }

  /**
   * The client is not reading its socket: its requests are refused instead of executed, so that
   * replies (a 16 MiB `fs.read`, a replay page) do not pile up in memory on top of PTY output.
   */
  get overloaded(): boolean {
    return this.stalled || this.ws.bufferedAmount > this.#limits.highWater
  }

  attach(session: Session): { scrollback: string } {
    this.detach(session.id)
    const offEvent = session.onEvent((ev) => this.notify(ev.type, { sessionId: session.id, ...ev }))
    const offData = session.onData((data) => this.notify('session.data', { id: session.id, data }))
    const offExit = session.onExit(() => this.detach(session.id))
    this.attached.set(session.id, {
      session,
      off: () => {
        offEvent()
        offData()
        offExit()
      },
    })
    if (this.stalled) session.pause(this)
    return { scrollback: session.rawScrollback }
  }

  detach(sessionId: string): boolean {
    const a = this.attached.get(sessionId)
    if (!a) return false
    a.off()
    a.session.resume(this)
    this.attached.delete(sessionId)
    return true
  }

  /** The socket's send queue passed the high-water mark: stop reading from every attached PTY. */
  #stall(): void {
    if (this.stalled) return
    this.#stalledSince = Date.now()
    for (const { session } of this.attached.values()) session.pause(this)
    this.#stallTimer = setInterval(() => this.#checkStall(), this.#limits.pollMs)
    this.#stallTimer.unref()
  }

  #checkStall(): void {
    if (!this.stalled) return
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.#unstall()
      return
    }
    if (this.ws.bufferedAmount <= this.#limits.lowWater) {
      this.#unstall()
      return
    }
    const stalledMs = Date.now() - (this.#stalledSince ?? 0)
    if (stalledMs > this.#limits.stallTimeoutMs) {
      const ids = [...this.attached.keys()]
      this.#log(`client ${this.remote} did not read for ${Math.round(stalledMs / 1000)} s (${this.ws.bufferedAmount} bytes queued): detaching ${ids.length} session(s) and closing the connection`)
      for (const id of ids) this.detach(id)
      // Both queue behind the backlog: a client that drains learns what happened and gets a clean
      // close; one that never drains is destroyed by ws's close timeout, which frees the queue.
      for (const id of ids) this.notify('session.detached', { id, reason: 'slow-consumer' })
      this.#unstall()
      this.close(1013, 'slow consumer')
    }
  }

  /** The send queue passed the hard cap: the client is not reading at all; drop it and free the queue now. */
  #overflow(): void {
    this.#log(`client ${this.remote} has ${this.ws.bufferedAmount} bytes queued (hard cap ${this.#limits.hardCap}): terminating the connection`)
    this.ws.terminate()
  }

  #unstall(): void {
    this.#stalledSince = undefined
    if (this.#stallTimer) clearInterval(this.#stallTimer)
    this.#stallTimer = undefined
    for (const { session } of this.attached.values()) session.resume(this)
  }

  watch(path: string, recursive: boolean): string {
    if (this.watchers.size >= MAX_WATCHERS_PER_CONNECTION) throw new RpcFailure(ErrorCodes.limit, `too many watchers (limit ${MAX_WATCHERS_PER_CONNECTION})`)
    const id = `w${++this.#watchCounter}`
    const watcher = fsWatch(path, { recursive, persistent: false }, (eventType, filename) => {
      this.notify('fs.event', { watchId: id, path, eventType, filename: filename === null ? undefined : String(filename) })
    })
    watcher.on('error', (err) => {
      this.notify('fs.event', { watchId: id, path, eventType: 'error', message: (err as Error).message })
      this.unwatch(id)
    })
    this.watchers.set(id, watcher)
    return id
  }

  unwatch(id: string): boolean {
    const w = this.watchers.get(id)
    if (!w) return false
    w.close()
    this.watchers.delete(id)
    return true
  }

  dispose(): void {
    this.#unstall()
    for (const id of [...this.attached.keys()]) this.detach(id)
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
  }
}

/**
 * Keep the daemon alive on errors nobody caught: log them and carry on serving. Returns a
 * function that removes the handlers again (tests).
 */
export function installCrashGuards(log: (msg: string) => void = (m) => console.error(m)): () => void {
  const describe = (reason: unknown): string => (reason instanceof Error ? reason.stack ?? reason.message : String(reason))
  const onRejection = (reason: unknown) => log(`unhandled rejection (daemon keeps serving): ${describe(reason)}`)
  const onException = (err: Error) => log(`uncaught exception (daemon keeps serving): ${describe(err)}`)
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  return () => {
    process.off('unhandledRejection', onRejection)
    process.off('uncaughtException', onException)
  }
}

export interface Daemon {
  httpServer: HttpServer
  wss: WebSocketServer
  sessions: SessionManager
  registry: DeviceRegistry
  pairing: Pairing
  tls: TlsMaterial | undefined
  /** Realpath of the directory fs.* and session cwds are confined to. */
  root: string
  /** ws:// or wss:// URL of the listening socket. */
  url: string
  port: number
  close(): Promise<void>
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((m: string) => console.log(m))
  const dataDir = options.dataDir
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const realDataDir = realpathSync(dataDir)
  const root = realpathSync(resolve(options.root ?? process.cwd()))
  if (!statSync(root).isDirectory()) throw new Error(`root is not a directory: ${root}`)
  const registry = new DeviceRegistry(dataDir)
  const pairing = new Pairing(dataDir, registry, log)
  const sessions = new SessionManager(dataDir, { maxSessions: options.maxSessions, maxLogBytes: options.maxLogBytes })
  const flow: FlowLimits = {
    highWater: options.sendHighWaterBytes ?? DEFAULT_SEND_HIGH_WATER,
    lowWater: options.sendLowWaterBytes ?? DEFAULT_SEND_LOW_WATER,
    hardCap: options.sendHardCapBytes ?? DEFAULT_SEND_HARD_CAP,
    stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    pollMs: options.stallPollMs ?? 250,
  }

  const tls = options.tls === false ? undefined : ensureTls(dataDir, log)
  if (!tls) {
    const why = options.tls === false ? 'TLS disabled with --no-tls' : 'openssl not available, no certificate could be generated'
    log(`!!! WARNING: ${why} - serving PLAIN ws:// without TLS. Anyone on the network can read this traffic. !!!`)
  }
  const httpServer = tls ? createHttpsServer({ cert: tls.cert, key: tls.key }) : createHttpServer()
  httpServer.on('request', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`somed ${req.url === '/health' ? 'ok' : '- connect with a WebSocket client'}\n`)
  })
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 * 1024 })

  /** A path for fs.* / session cwd: inside root and not inside the daemon's own state directory. */
  const guardedPath = (p: string): string => {
    const full = safePath(root, p)
    if (isInside(realDataDir, full)) throw new RpcFailure(ErrorCodes.forbidden, 'path inside the daemon state directory')
    return full
  }

  const handle = async (conn: Connection, method: string, params: Params): Promise<unknown> => {
    switch (method) {
      case 'ping':
        return { time: Date.now(), tls: Boolean(tls) }
      case 'pair.start': {
        // Reporting only: codes are created on the host (`somed pair`, `somed serve --pair`).
        const s = pairing.status()
        return { pending: s.pending, expiresAt: s.expiresAt, lockedForMs: s.lockedForMs, hint: 'run `somed pair` on the host to get a code' }
      }
      case 'pair.complete': {
        const r = pairing.complete(str(params, 'code', true, 64), str(params, 'devicePublicKey', true, 4096), str(params, 'deviceName', false, 256))
        if (!r.ok) {
          log(`pairing failed from ${conn.remote}: ${r.error}`)
          conn.closeAfterReply = { code: 1008, reason: 'pairing failed' }
          throw new RpcFailure(ErrorCodes.pairing, r.error)
        }
        log(`paired device "${r.device.name}" from ${conn.remote}`)
        return { device: r.device }
      }
      case 'auth.challenge': {
        const r = conn.auth.challenge(str(params, 'devicePublicKey', true, 4096))
        if (!r.ok) throw new RpcFailure(ErrorCodes.unauthorized, r.error)
        return { nonce: r.nonce }
      }
      case 'auth.verify': {
        const r = conn.auth.verify(str(params, 'signature', true, 1024))
        if (!r.ok) {
          log(`authentication failed from ${conn.remote}: ${r.error}`)
          throw new RpcFailure(ErrorCodes.unauthorized, r.error)
        }
        return { device: r.device }
      }
      default:
        break
    }
    if (!conn.auth.authenticated) throw new RpcFailure(ErrorCodes.unauthorized, 'not authenticated')

    switch (method) {
      case 'server.info':
        return {
          version: '0.1.0',
          pid: process.pid,
          platform: process.platform,
          tls: Boolean(tls),
          fingerprint: tls?.fingerprint,
          shells: ['bash', 'zsh', 'fish', 'pwsh'].filter((s) => which(s)),
          defaultShell: process.env.SHELL ?? 'bash',
          home: process.env.HOME,
          dataDir,
          root,
          limits: {
            maxSessions: sessions.maxSessions,
            cols: [SIZE_LIMITS.minCols, SIZE_LIMITS.maxCols],
            rows: [SIZE_LIMITS.minRows, SIZE_LIMITS.maxRows],
            fileBytes: MAX_FILE_BYTES,
            replayChunk: MAX_REPLAY_CHUNK,
          },
        }
      case 'session.create': {
        const cols = int(params, 'cols', 80)
        const rows = int(params, 'rows', 24)
        const sizeError = checkSize(cols, rows)
        if (sizeError) throw new RpcFailure(ErrorCodes.invalidParams, sizeError)
        const cwd = params.cwd === undefined ? root : guardedPath(str(params, 'cwd', true, 4096))
        let cwdStat
        try {
          cwdStat = statSync(cwd)
        } catch {
          throw new RpcFailure(ErrorCodes.invalidParams, 'cwd does not exist')
        }
        if (!cwdStat.isDirectory()) throw new RpcFailure(ErrorCodes.invalidParams, 'cwd is not a directory')
        let session: Session
        try {
          session = sessions.create({
            shell: typeof params.shell === 'string' ? params.shell.slice(0, 256) : undefined,
            cwd,
            cols,
            rows,
          })
        } catch (err) {
          if (err instanceof SessionLimitError) throw new RpcFailure(ErrorCodes.limit, err.message)
          if (err instanceof RangeError) throw new RpcFailure(ErrorCodes.invalidParams, err.message)
          throw err
        }
        conn.attach(session)
        return session.info
      }
      case 'session.input': {
        const s = sessions.get(sessionId(params))
        if (!s) throw new RpcFailure(ErrorCodes.notFound, 'no such session')
        s.write(str(params, 'data'))
        return { ok: true }
      }
      case 'session.resize': {
        const s = sessions.get(sessionId(params))
        if (!s) throw new RpcFailure(ErrorCodes.notFound, 'no such session')
        const cols = int(params, 'cols')
        const rows = int(params, 'rows')
        const sizeError = checkSize(cols, rows)
        if (sizeError) throw new RpcFailure(ErrorCodes.invalidParams, sizeError)
        s.resize(cols, rows)
        return { ok: true }
      }
      case 'session.list':
        return { sessions: sessions.list(), persisted: sessions.listPersisted() }
      case 'session.attach':
      case 'session.replay': {
        const id = sessionId(params)
        const fromSeq = int(params, 'fromSeq', 0)
        const limit = Math.max(1, Math.min(int(params, 'limit', MAX_REPLAY_CHUNK), MAX_REPLAY_CHUNK))
        const s = sessions.get(id)
        if (!s && !existsSync(sessions.store.pathFor(id))) throw new RpcFailure(ErrorCodes.notFound, 'no such session')
        const { events, more } = sessions.replayPage(id, fromSeq, limit)
        const nextSeq = events.length > 0 ? events[events.length - 1]!.seq : fromSeq
        if (method === 'session.replay') return { events, more, nextSeq }
        const live = s ? conn.attach(s) : undefined
        return { info: sessions.describe(id), alive: Boolean(s?.alive), events, more, nextSeq, scrollback: live?.scrollback ?? '' }
      }
      case 'session.detach':
        conn.detach(sessionId(params))
        return { ok: true }
      case 'session.kill': {
        if (!sessions.kill(sessionId(params))) throw new RpcFailure(ErrorCodes.notFound, 'no such session')
        return { ok: true }
      }
      case 'fs.list': {
        const path = guardedPath(str(params, 'path', true, 4096))
        const entries = await readdir(path, { withFileTypes: true })
        const out = await Promise.all(
          entries.map(async (e) => {
            let size: number | undefined
            let mtime: number | undefined
            try {
              // lstat: a symlink reports itself, not what it points to (which may be outside root).
              const st = await lstat(join(path, e.name))
              size = st.size
              mtime = st.mtimeMs
            } catch {
              /* vanished meanwhile */
            }
            return { name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other', size, mtime }
          }),
        )
        return { path, entries: out }
      }
      case 'fs.read': {
        const path = guardedPath(str(params, 'path', true, 4096))
        const encoding = params.encoding === 'base64' ? 'base64' : 'utf8'
        // safePath resolved symlinks, so the final component is a real file system object; lstat
        // (not stat) makes sure it is a regular file: FIFOs, devices (/dev/zero) and sockets would
        // block or never end. O_NOFOLLOW | O_NONBLOCK close the window between the check and the open.
        const st = await lstat(path)
        if (!st.isFile()) throw new RpcFailure(ErrorCodes.invalidParams, 'not a regular file')
        if (st.size > MAX_FILE_BYTES) throw new RpcFailure(ErrorCodes.invalidParams, `file too large (${MAX_FILE_BYTES} byte limit)`)
        const fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0))
        try {
          const st2 = await fh.stat()
          if (!st2.isFile()) throw new RpcFailure(ErrorCodes.invalidParams, 'not a regular file')
          if (st2.size > MAX_FILE_BYTES) throw new RpcFailure(ErrorCodes.invalidParams, `file too large (${MAX_FILE_BYTES} byte limit)`)
          const buf = Buffer.allocUnsafe(st2.size)
          let read = 0
          while (read < st2.size) {
            const r = await fh.read(buf, read, st2.size - read, read)
            if (r.bytesRead === 0) break
            read += r.bytesRead
          }
          const content = buf.subarray(0, read)
          return { path, encoding, size: read, mtime: st2.mtimeMs, content: content.toString(encoding) }
        } finally {
          await fh.close()
        }
      }
      case 'fs.write': {
        const path = guardedPath(str(params, 'path', true, 4096))
        const encoding = params.encoding === 'base64' ? 'base64' : 'utf8'
        const data = Buffer.from(str(params, 'content', true, MAX_FILE_BYTES * 2), encoding)
        if (data.length > MAX_FILE_BYTES) throw new RpcFailure(ErrorCodes.invalidParams, `content too large (${MAX_FILE_BYTES} byte limit)`)
        if (params.mkdir === true) await mkdir(dirname(path), { recursive: true })
        let mode: number | undefined
        try {
          const st = await lstat(path)
          if (st.isSymbolicLink()) throw new RpcFailure(ErrorCodes.forbidden, 'refusing to write through a symlink')
          if (!st.isFile()) throw new RpcFailure(ErrorCodes.invalidParams, 'not a regular file')
          mode = st.mode & 0o7777
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
        // Atomic replace: write a sibling temp file, fsync, rename over the target (keeps its mode).
        const tmp = join(dirname(path), `.tmp-${randomBytes(8).toString('hex')}`)
        const fh = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode ?? 0o666)
        try {
          try {
            await fh.writeFile(data)
            await fh.sync()
          } finally {
            await fh.close()
          }
          if (mode !== undefined) await chmod(tmp, mode)
          await rename(tmp, path)
        } catch (err) {
          await unlink(tmp).catch(() => {})
          throw err
        }
        return { path, size: data.length }
      }
      case 'fs.watch': {
        const path = guardedPath(str(params, 'path', true, 4096))
        const st = statSync(path)
        const recursive = params.recursive === true && st.isDirectory()
        return { watchId: conn.watch(path, recursive), path }
      }
      case 'fs.unwatch':
        return { ok: conn.unwatch(str(params, 'watchId', true, 64)) }
      default:
        throw new RpcFailure(ErrorCodes.methodNotFound, `unknown method ${method}`)
    }
  }

  const toRpcError = (err: unknown): RpcError =>
    err instanceof RpcFailure ? { code: err.code, message: err.message } : { code: ErrorCodes.internal, message: (err as Error)?.message ?? String(err) }

  /** One inbound frame. Everything is validated before use; nothing in here may throw past the caller. */
  const onMessage = async (conn: Connection, raw: RawData): Promise<void> => {
    let msg: unknown
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      conn.send({ id: null, error: { code: ErrorCodes.parse, message: 'invalid JSON' } })
      return
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      conn.send({ id: null, error: { code: ErrorCodes.invalidRequest, message: 'request must be a JSON object' } })
      return
    }
    const req = msg as { id?: unknown; method?: unknown; params?: unknown }
    // Only echo scalar ids; anything else is replaced by null (no reflection of large objects).
    const id = req.id === undefined ? undefined : typeof req.id === 'number' || typeof req.id === 'string' ? req.id : null
    if (typeof req.method !== 'string') {
      conn.send({ id: id ?? null, error: { code: ErrorCodes.invalidRequest, message: 'missing method' } })
      return
    }
    const params = req.params && typeof req.params === 'object' && !Array.isArray(req.params) ? (req.params as Params) : {}
    if (conn.overloaded) {
      // The client is not reading its socket. Nothing is executed on its behalf (no 16 MiB read
      // whose reply would only sit in memory, no write it would not learn about): requests get a
      // small error, notifications are dropped.
      if (id !== undefined) conn.send({ id, error: { code: ErrorCodes.limit, message: 'slow consumer: read your socket before sending more requests' } })
      return
    }
    try {
      const result = await handle(conn, req.method, params)
      if (id !== undefined) conn.send({ id, result })
    } catch (err) {
      if (!(err instanceof RpcFailure)) log(`error in ${req.method} from ${conn.remote}: ${(err as Error)?.stack ?? String(err)}`)
      if (id !== undefined) conn.send({ id, error: toRpcError(err) })
    }
    if (conn.closeAfterReply) {
      const { code, reason } = conn.closeAfterReply
      conn.closeAfterReply = undefined
      conn.close(code, reason)
    }
  }

  wss.on('connection', (ws, req) => {
    const remote = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`
    const conn = new Connection(ws, registry, tls?.certHash, remote, flow, log)
    log(`client connected from ${remote}`)
    // Frames of a connection are handled one at a time, in the order they arrived: the reply to one
    // request is queued before the next frame is looked at, so the slow-consumer gate above sees
    // the queue that reply created (80 `fs.read` requests from one TCP chunk used to start 80
    // concurrent 16 MiB reads before the first reply existed), and requests cannot overtake each
    // other. Other connections are not affected: each has its own chain.
    let chain: Promise<void> = Promise.resolve()
    ws.on('message', (raw) => {
      chain = chain.then(() => onMessage(conn, raw)).catch((err) => log(`internal error handling a frame from ${remote}: ${(err as Error)?.stack ?? String(err)}`))
    })
    ws.on('close', () => {
      conn.dispose()
      log(`client ${remote} disconnected (sessions keep running)`)
    })
    ws.on('error', (err) => {
      log(`socket error from ${remote}: ${err.message}`)
      conn.dispose()
    })
  })
  wss.on('error', (err) => log(`websocket server error: ${err.message}`))

  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((res, rej) => {
    httpServer.once('error', rej)
    httpServer.listen(options.port ?? 7700, host, () => res())
  })
  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 7700)
  const url = `${tls ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:${port}`
  log(`somed listening on ${url}${tls ? `  (TLS fingerprint sha256 ${tls.fingerprint})` : ''}`)
  log(`fs.* and session cwds are confined to ${root}`)

  return {
    httpServer,
    wss,
    sessions,
    registry,
    pairing,
    tls,
    root,
    url,
    port,
    async close() {
      for (const client of wss.clients) client.terminate()
      await sessions.disposeAll()
      await new Promise<void>((res) => wss.close(() => res()))
      await new Promise<void>((res) => httpServer.close(() => res()))
    },
  }
}

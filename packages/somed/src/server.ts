/**
 * WebSocket JSON-RPC-style server.
 *
 *   request:      { id, method, params }
 *   response:     { id, result } | { id, error: { code, message } }
 *   notification: { method, params }            (server -> client, no id)
 *
 * Unauthenticated methods: ping, pair.start, pair.complete, auth.challenge, auth.verify.
 * Everything else requires a completed Ed25519 challenge/response on this connection.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { dirname, join, resolve } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { Authenticator, DeviceRegistry, Pairing } from './auth.ts'
import { SessionManager, type Session, type SessionInfo } from './session.ts'
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
} as const

export interface DaemonOptions {
  port?: number
  host?: string
  dataDir: string
  /** Use TLS when a certificate can be generated/found (default true). */
  tls?: boolean
  log?: (msg: string) => void
}

export interface TlsMaterial {
  cert: Buffer
  key: Buffer
  certPath: string
  fingerprint: string
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
  return { cert, key, certPath, fingerprint: certFingerprint(cert) }
}

/** SHA-256 fingerprint of a PEM certificate (colon separated hex, like browsers show it). */
export function certFingerprint(pem: Buffer): string {
  const b64 = pem
    .toString('utf8')
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----[\s\S]*$/, '')
    .replace(/\s+/g, '')
  const der = Buffer.from(b64, 'base64')
  return createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g)!.join(':')
}

type Params = Record<string, unknown>

class RpcFailure extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

function str(params: Params, key: string, required = true): string {
  const v = params[key]
  if (typeof v === 'string') return v
  if (!required && v === undefined) return ''
  throw new RpcFailure(ErrorCodes.invalidParams, `param "${key}" must be a string`)
}

function num(params: Params, key: string, fallback?: number): number {
  const v = params[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (fallback !== undefined) return fallback
  throw new RpcFailure(ErrorCodes.invalidParams, `param "${key}" must be a number`)
}

class Connection {
  readonly ws: WebSocket
  readonly auth: Authenticator
  readonly attached = new Map<string, () => void>()
  readonly watchers = new Map<string, FSWatcher>()
  #watchCounter = 0

  constructor(ws: WebSocket, registry: DeviceRegistry) {
    this.ws = ws
    this.auth = new Authenticator(registry)
  }

  notify(method: string, params: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method, params }))
  }

  attach(session: Session): { scrollback: string } {
    this.detach(session.id)
    const offEvent = session.onEvent((ev) => this.notify(ev.type, { sessionId: session.id, ...ev }))
    const offData = session.onData((data) => this.notify('session.data', { id: session.id, data }))
    const offExit = session.onExit(() => this.detach(session.id))
    this.attached.set(session.id, () => {
      offEvent()
      offData()
      offExit()
    })
    return { scrollback: session.rawScrollback }
  }

  detach(sessionId: string): void {
    this.attached.get(sessionId)?.()
    this.attached.delete(sessionId)
  }

  watch(path: string, recursive: boolean): string {
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
    for (const off of this.attached.values()) off()
    this.attached.clear()
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
  }
}

export interface Daemon {
  httpServer: HttpServer
  wss: WebSocketServer
  sessions: SessionManager
  registry: DeviceRegistry
  pairing: Pairing
  tls: TlsMaterial | undefined
  /** ws:// or wss:// URL of the listening socket. */
  url: string
  port: number
  close(): Promise<void>
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((m: string) => console.log(m))
  const dataDir = options.dataDir
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const registry = new DeviceRegistry(dataDir)
  const pairing = new Pairing(dataDir, registry, log)
  const sessions = new SessionManager(dataDir)

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

  const handle = async (conn: Connection, method: string, params: Params): Promise<unknown> => {
    switch (method) {
      case 'ping':
        return { time: Date.now(), tls: Boolean(tls) }
      case 'pair.start': {
        const code = pairing.start()
        return { expiresAt: code.expiresAt, hint: 'the 6-digit code is printed on the daemon console' }
      }
      case 'pair.complete': {
        const r = pairing.complete(str(params, 'code'), str(params, 'devicePublicKey'), str(params, 'deviceName', false))
        if (!r.ok) throw new RpcFailure(ErrorCodes.pairing, r.error)
        return { device: r.device }
      }
      case 'auth.challenge': {
        const r = conn.auth.challenge(str(params, 'devicePublicKey'))
        if (!r.ok) throw new RpcFailure(ErrorCodes.unauthorized, r.error)
        return { nonce: r.nonce }
      }
      case 'auth.verify': {
        const r = conn.auth.verify(str(params, 'signature'))
        if (!r.ok) throw new RpcFailure(ErrorCodes.unauthorized, r.error)
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
        }
      case 'session.create': {
        const session = sessions.create({
          shell: typeof params.shell === 'string' ? params.shell : undefined,
          cwd: typeof params.cwd === 'string' ? params.cwd : undefined,
          cols: num(params, 'cols', 80),
          rows: num(params, 'rows', 24),
        })
        conn.attach(session)
        return session.info satisfies SessionInfo
      }
      case 'session.input': {
        const s = sessions.get(str(params, 'id'))
        if (!s) throw new RpcFailure(ErrorCodes.notFound, 'no such session')
        s.write(str(params, 'data'))
        return { ok: true }
      }
      case 'session.resize': {
        const s = sessions.get(str(params, 'id'))
        if (!s) throw new RpcFailure(ErrorCodes.notFound, 'no such session')
        s.resize(num(params, 'cols'), num(params, 'rows'))
        return { ok: true }
      }
      case 'session.list':
        return { sessions: sessions.list(), persisted: sessions.listPersisted() }
      case 'session.attach': {
        const id = str(params, 'id')
        const fromSeq = num(params, 'fromSeq', 0)
        const events = sessions.replay(id, fromSeq)
        const s = sessions.get(id)
        if (!s && events.length === 0) throw new RpcFailure(ErrorCodes.notFound, 'no such session')
        const live = s ? conn.attach(s) : undefined
        return { info: s?.info, alive: Boolean(s?.alive), events, scrollback: live?.scrollback ?? '' }
      }
      case 'session.detach':
        conn.detach(str(params, 'id'))
        return { ok: true }
      case 'session.kill': {
        const id = str(params, 'id')
        if (!sessions.kill(id)) throw new RpcFailure(ErrorCodes.notFound, 'no such session')
        return { ok: true }
      }
      case 'fs.list': {
        const path = resolve(str(params, 'path'))
        const entries = await readdir(path, { withFileTypes: true })
        const out = await Promise.all(
          entries.map(async (e) => {
            const full = join(path, e.name)
            let size: number | undefined
            let mtime: number | undefined
            try {
              const st = await stat(full)
              size = st.size
              mtime = st.mtimeMs
            } catch {
              /* broken symlink etc. */
            }
            return { name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other', size, mtime }
          }),
        )
        return { path, entries: out }
      }
      case 'fs.read': {
        const path = resolve(str(params, 'path'))
        const encoding = params.encoding === 'base64' ? 'base64' : 'utf8'
        const st = await stat(path)
        if (st.size > 16 * 1024 * 1024) throw new RpcFailure(ErrorCodes.invalidParams, 'file too large (16 MiB limit)')
        const buf = await readFile(path)
        return { path, encoding, size: st.size, mtime: st.mtimeMs, content: buf.toString(encoding) }
      }
      case 'fs.write': {
        const path = resolve(str(params, 'path'))
        const encoding = params.encoding === 'base64' ? 'base64' : 'utf8'
        const data = Buffer.from(str(params, 'content'), encoding)
        if (params.mkdir === true) await mkdir(dirname(path), { recursive: true })
        await writeFile(path, data)
        return { path, size: data.length }
      }
      case 'fs.watch': {
        const path = resolve(str(params, 'path'))
        const st = statSync(path)
        const recursive = params.recursive === true && st.isDirectory()
        return { watchId: conn.watch(path, recursive), path }
      }
      case 'fs.unwatch':
        return { ok: conn.unwatch(str(params, 'watchId')) }
      default:
        throw new RpcFailure(ErrorCodes.methodNotFound, `unknown method ${method}`)
    }
  }

  wss.on('connection', (ws, req) => {
    const conn = new Connection(ws, registry)
    log(`client connected from ${req.socket.remoteAddress}`)
    ws.on('message', async (raw) => {
      let msg: { id?: unknown; method?: unknown; params?: unknown }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        ws.send(JSON.stringify({ id: null, error: { code: ErrorCodes.parse, message: 'invalid JSON' } }))
        return
      }
      if (typeof msg.method !== 'string') {
        ws.send(JSON.stringify({ id: msg.id ?? null, error: { code: ErrorCodes.invalidRequest, message: 'missing method' } }))
        return
      }
      const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Params
      const id = msg.id
      try {
        const result = await handle(conn, msg.method, params)
        if (id !== undefined) ws.send(JSON.stringify({ id, result }))
      } catch (err) {
        const rpcErr: RpcError =
          err instanceof RpcFailure
            ? { code: err.code, message: err.message }
            : { code: ErrorCodes.internal, message: (err as Error).message ?? String(err) }
        if (id !== undefined) ws.send(JSON.stringify({ id, error: rpcErr }))
      }
    })
    ws.on('close', () => {
      conn.dispose()
      log('client disconnected (sessions keep running)')
    })
    ws.on('error', () => conn.dispose())
  })

  const host = options.host ?? '127.0.0.1'
  await new Promise<void>((res, rej) => {
    httpServer.once('error', rej)
    httpServer.listen(options.port ?? 7700, host, () => res())
  })
  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 7700)
  const url = `${tls ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:${port}`
  log(`somed listening on ${url}${tls ? `  (TLS fingerprint sha256 ${tls.fingerprint})` : ''}`)

  return {
    httpServer,
    wss,
    sessions,
    registry,
    pairing,
    tls,
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

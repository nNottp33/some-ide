#!/usr/bin/env node
/**
 * somed command line.
 *
 *   node packages/somed/src/cli.ts serve [--port 7700] [--host 127.0.0.1] [--no-tls]
 *   node packages/somed/src/cli.ts pair
 *   node packages/somed/src/cli.ts client --host wss://localhost:7700 [--code 123456] [--fingerprint AB:CD…] [--shell bash]
 *   node packages/somed/src/cli.ts replay <sessionId>
 *   node packages/somed/src/cli.ts devices
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeviceRegistry, generatePairingCode, readPairingFile, writePairingFile } from './auth.ts'
import { loadOrCreateDevice, RpcClientError, SomedClient } from './client.ts'
import { certFingerprint, startDaemon } from './server.ts'
import { SessionStore, foldBlocks } from './store.ts'
import { dataDir } from './util.ts'

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string | boolean> } {
  const [cmd = 'help', ...rest] = argv
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (i + 1 < rest.length && !rest[i + 1]!.startsWith('--')) flags[a.slice(2)] = rest[++i]!
      else flags[a.slice(2)] = true
    } else positional.push(a)
  }
  return { cmd, positional, flags }
}

function usage(): void {
  console.log(`somed - per-user host daemon for the IDE (prototype)

  serve   [--port 7700] [--host 127.0.0.1] [--no-tls]       start the daemon
  pair                                                      print (or create) the current pairing code
  client  --host wss://localhost:7700 [--code 123456]       demo client: pair, authenticate, run commands
          [--fingerprint AB:CD:..] [--shell bash] [--raw]
  replay  <sessionId>                                       print the persisted blocks of a session
  devices                                                   list paired devices

Data directory: ${dataDir()}  (override with $SOMED_HOME)`)
}

async function serve(flags: Record<string, string | boolean>): Promise<void> {
  const daemon = await startDaemon({
    port: Number(flags.port ?? 7700),
    host: typeof flags.host === 'string' ? flags.host : '127.0.0.1',
    dataDir: dataDir(),
    tls: flags['no-tls'] !== true,
  })
  console.log(`Data directory: ${dataDir()}`)
  console.log('Press Ctrl+C to stop. Sessions survive client disconnects but not a daemon restart (block logs do).')
  const shutdown = async () => {
    console.log('\nshutting down…')
    await daemon.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // Report memory periodically so the README numbers can be reproduced.
  if (flags.stats === true) {
    setInterval(() => {
      const m = process.memoryUsage()
      console.log(`[stats] rss=${(m.rss / 1048576).toFixed(1)}MiB heap=${(m.heapUsed / 1048576).toFixed(1)}MiB sessions=${daemon.sessions.list().length}`)
    }, 5000).unref()
  }
}

function pair(): void {
  const dir = dataDir()
  let code = readPairingFile(dir)
  if (!code) {
    code = { code: generatePairingCode(), expiresAt: Date.now() + 5 * 60 * 1000 }
    writePairingFile(dir, code)
  }
  console.log(`Pairing code: ${code.code}  (valid until ${new Date(code.expiresAt).toLocaleTimeString()})`)
  const certPath = join(dir, 'tls', 'cert.pem')
  if (existsSync(certPath)) console.log(`TLS fingerprint (sha256): ${certFingerprint(readFileSync(certPath))}`)
}

function devices(): void {
  const registry = new DeviceRegistry(dataDir())
  const list = registry.list()
  if (list.length === 0) {
    console.log('no paired devices')
    return
  }
  for (const d of list) console.log(`${d.name}\n  key: ${d.publicKey}\n  paired: ${new Date(d.pairedAt).toISOString()}${d.lastSeenAt ? `  last seen: ${new Date(d.lastSeenAt).toISOString()}` : ''}`)
}

function replay(sessionId: string | undefined): void {
  const store = new SessionStore(dataDir())
  if (!sessionId) {
    const ids = store.list()
    console.log(ids.length ? `sessions:\n  ${ids.join('\n  ')}` : 'no persisted sessions')
    return
  }
  const events = store.read(sessionId)
  if (events.length === 0) {
    console.log(`no events for session ${sessionId}`)
    return
  }
  const meta = events.find((e) => e.type === 'session.meta')
  if (meta && meta.type === 'session.meta') console.log(`session ${meta.id}  shell=${meta.shell}  cwd=${meta.cwd}  created=${new Date(meta.createdAt).toISOString()}`)
  for (const b of foldBlocks(events)) {
    const status = b.exitCode === undefined ? '?' : String(b.exitCode)
    console.log(`\n┌─ [${b.id}] ${b.cwd} $ ${b.commandLine}${b.tui ? '   (tui)' : ''}`)
    if (b.output) console.log(b.output.replace(/\n$/, '').split('\n').map((l) => `│ ${l}`).join('\n'))
    console.log(`└─ exit ${status}  ${b.durationMs ?? '?'} ms`)
  }
  const exit = events.find((e) => e.type === 'session.exit')
  if (exit && exit.type === 'session.exit') console.log(`\nsession exited with code ${exit.exitCode}`)
  console.log(`\n${events.length} events, last seq ${events.at(-1)?.seq}`)
}

async function client(flags: Record<string, string | boolean>): Promise<void> {
  const url = typeof flags.host === 'string' ? flags.host : 'wss://localhost:7700'
  const device = loadOrCreateDevice(join(dataDir(), 'client'))
  const fingerprint = typeof flags.fingerprint === 'string' ? flags.fingerprint : undefined
  console.log(`connecting to ${url} as device "${device.name}"${fingerprint ? ' (pinned certificate)' : ''}`)
  const c = await SomedClient.connect(url, { insecure: true, fingerprint })
  const raw = flags.raw === true
  c.onNotification((method, params) => {
    if (method === 'session.data') {
      if (raw) process.stdout.write(String(params.data))
      return
    }
    if (method.startsWith('block.') || method === 'cwd' || method === 'session.exit') {
      const { sessionId: _s, seq, ...rest } = params as { sessionId: string; seq: number } & Record<string, unknown>
      console.log(`  #${seq} ${JSON.stringify(rest)}`)
    }
  })
  try {
    if (typeof flags.code === 'string' || typeof flags.code === 'number') {
      await c.pair(device, String(flags.code))
      console.log('paired')
    }
    await c.authenticate(device)
    console.log('authenticated')
    const info = await c.call<{ shells: string[]; tls: boolean; fingerprint?: string }>('server.info')
    console.log(`server: tls=${info.tls} shells=${info.shells.join(',')}${info.fingerprint ? ` fingerprint=${info.fingerprint}` : ''}`)
    const session = await c.call<{ id: string }>('session.create', { shell: typeof flags.shell === 'string' ? flags.shell : 'bash', cols: 100, rows: 30 })
    console.log(`session ${session.id} created; waiting for the first prompt`)
    const exited = c.waitFor((m, p) => m === 'session.exit' && p.sessionId === session.id, 30_000)
    // The shell reports its cwd once before the first prompt and after every command (after D).
    await c.waitFor((m, p) => m === 'cwd' && p.sessionId === session.id, 15_000)
    const commands = ['echo hello from somed', 'uname -a', 'cd /tmp && pwd', 'false', "printf 'no newline'", 'seq 3', 'exit']
    for (const cmd of commands) {
      const done = cmd === 'exit' ? exited : c.waitFor((m, p) => m === 'cwd' && p.sessionId === session.id, 10_000)
      await c.call('session.input', { id: session.id, data: cmd + '\r' })
      await done
    }
    const replayed = await c.call<{ events: unknown[] }>('session.attach', { id: session.id, fromSeq: 0 })
    console.log(`replay of ${session.id}: ${replayed.events.length} persisted events`)
  } catch (err) {
    if (err instanceof RpcClientError) console.error(`rpc error ${err.code}: ${err.message}`)
    else throw err
    process.exitCode = 1
  } finally {
    c.close()
  }
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2))
  switch (cmd) {
    case 'serve':
      await serve(flags)
      break
    case 'pair':
      pair()
      break
    case 'client':
      await client(flags)
      break
    case 'replay':
      replay(positional[0])
      break
    case 'devices':
      devices()
      break
    default:
      usage()
      if (cmd !== 'help') process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

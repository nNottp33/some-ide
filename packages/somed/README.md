# @some/somed — per-user host daemon (P0 prototype)

`somed` runs on the machine that owns the files and the shells. The web IDE (`apps/classic`) will
talk to it over a WebSocket to get **real terminals split into blocks** (prompt + command + output +
exit code, the way Warp renders them), a **file system API**, and **sessions that survive the
browser tab**. Everything in this package is plain Node 22 TypeScript (run directly with type
stripping, no build step).

```
packages/somed
├── src/pty.ts        node-pty spawn + VS Code shell-integration injection (bash/zsh/fish/pwsh)
├── src/blocks.ts     OSC 633 block detector on top of @xterm/headless
├── src/session.ts    Session (pty + detector + log) and SessionManager
├── src/store.ts      JSONL persistence + replay folding
├── src/auth.ts       pairing codes, devices.json, Ed25519 challenge/response
├── src/server.ts     wss JSON-RPC server, TLS bootstrap, fs.* methods
├── src/client.ts     small protocol client (demo CLI + tests)
├── src/cli.ts        serve | pair | client | replay | devices
├── shell-integration/   VS Code's scripts (MIT, tag 1.141.0) + NOTICE
└── tests/            vitest: blocks (real bash), server/auth, store
```

## Running

Requirements: Node 22.12+, a C++ toolchain for `node-pty` (installed with `npm install` at the repo
root), `bash`; `openssl` for TLS (optional but strongly recommended); `zsh` optional.

```bash
npm install                                   # repo root, builds node-pty
node packages/somed/src/cli.ts serve          # wss://127.0.0.1:7700 (--port, --host, --no-tls, --stats)
node packages/somed/src/cli.ts pair           # prints the current 6-digit pairing code (creates one if none)
node packages/somed/src/cli.ts client --host wss://localhost:7700 --code 123456
node packages/somed/src/cli.ts replay <sessionId>
node packages/somed/src/cli.ts devices
```

The demo client pairs (when `--code` is given), authenticates with its Ed25519 key, creates a bash
session, runs a few commands and prints every block event it receives, then re-attaches to show the
persisted replay. Pass `--fingerprint AB:CD:…` (printed by `serve` and `pair`) to pin the daemon's
self-signed certificate instead of trusting any certificate; `--raw` also prints the raw terminal
stream.

State lives in `~/.some-ide/somed/` (override with `$SOMED_HOME`):

| path | content |
| --- | --- |
| `tls/cert.pem`, `tls/key.pem` | self-signed P-256 certificate generated with the `openssl` CLI at first start |
| `devices.json` | paired devices (`publicKey` = base64 SPKI DER Ed25519, `name`, `pairedAt`, `lastSeenAt`) |
| `pairing.json` | the current pairing code and its expiry (shared between `serve` and `pair`) |
| `sessions/<id>.jsonl` | one JSON object per line: `session.meta`, block events, `cwd`, `session.exit`; each with `seq` and `ts` |
| `client/device.json` | the demo client's own key pair |

Tests: `npm test` from the repo root (vitest picks up `packages/somed/tests/*.test.ts`), typecheck
with `npm run typecheck`. The whole somed suite runs against a real `bash` in about 2 s.

## Protocol

One WebSocket, JSON text frames, JSON-RPC shaped:

```
client → server   { "id": 1, "method": "session.input", "params": { "id": "9a9f…", "data": "ls\r" } }
server → client   { "id": 1, "result": { "ok": true } }
                  { "id": 1, "error": { "code": -32001, "message": "not authenticated" } }
server → client   { "method": "block.output", "params": { "sessionId": "9a9f…", "seq": 15, "id": "9a9f…:3", "text": "/tmp\n", "ts": … } }
```

Error codes: `-32700` parse, `-32600` invalid request, `-32601` unknown method, `-32602` invalid
params, `-32603` internal, `-32001` unauthorized, `-32002` not found, `-32003` pairing failure.

### Unauthenticated methods

| method | params → result |
| --- | --- |
| `ping` | → `{ time, tls }` |
| `pair.start` | → `{ expiresAt }`; the 6-digit code is **printed on the daemon console only**, valid 5 minutes, 5 attempts, single use. `somed pair` writes an equivalent code to `pairing.json`. |
| `pair.complete` | `{ code, devicePublicKey, deviceName }` → `{ device }`; stores the device in `devices.json`. Pairing does not authenticate the connection. |
| `auth.challenge` | `{ devicePublicKey }` → `{ nonce }` (32 random bytes, base64; the key must be paired) |
| `auth.verify` | `{ signature }` (Ed25519 over the raw nonce bytes, base64) → `{ device }`. Verified with Node's `crypto.verify(null, …)`. |

### Authenticated methods

| method | params → result |
| --- | --- |
| `server.info` | → `{ version, pid, platform, tls, fingerprint, shells, defaultShell, home, dataDir }` |
| `session.create` | `{ shell?, cwd?, cols, rows }` → `SessionInfo`; the connection is attached automatically |
| `session.input` | `{ id, data }` |
| `session.resize` | `{ id, cols, rows }` |
| `session.list` | → `{ sessions: SessionInfo[], persisted: string[] }` |
| `session.attach` | `{ id, fromSeq }` → `{ info, alive, events, scrollback }` — `events` are the persisted events with `seq > fromSeq`, then live notifications follow; `scrollback` is the last 256 KiB of raw output for repainting a terminal |
| `session.detach` | `{ id }` |
| `session.kill` | `{ id }` (SIGHUP; the `session.exit` event is persisted) |
| `fs.list` | `{ path }` → `{ path, entries: [{ name, type: file/dir/symlink/other, size, mtime }] }` |
| `fs.read` | `{ path, encoding?: utf8/base64 }` → `{ content, encoding, size, mtime }` (16 MiB limit) |
| `fs.write` | `{ path, content, encoding?, mkdir? }` → `{ path, size }` |
| `fs.watch` | `{ path, recursive? }` → `{ watchId }`; `fs.unwatch { watchId }`. Watchers belong to the connection and are closed on disconnect. |

### Notifications (server → client)

All session notifications carry `sessionId` and, for persisted events, `seq`:

| method | fields |
| --- | --- |
| `block.start` | `id, ts` |
| `block.command` | `id, commandLine, cwd, trusted, prompt?` — `trusted` is true when the command line came from the shell with the right nonce (see below) |
| `block.output` | `id, text` — append; emitted as logical lines complete, final chunk at command end |
| `block.end` | `id, exitCode (undefined when unknown), durationMs, tui, ts` |
| `cwd` | `cwd` — reported by the shell at startup and after every command (`OSC 633 ; P ; Cwd=`) |
| `session.exit` | `exitCode, signal` |
| `session.data` | `id, data` — raw PTY output (not persisted), for an xterm.js renderer on the client |
| `fs.event` | `watchId, path, eventType, filename` |

A session is owned by the daemon, not by a connection: closing the socket leaves the shell running;
`session.attach {fromSeq}` replays what was missed. Because several frames can arrive in one TCP
chunk, a client should register its "wait for event X" listener **before** sending the input that
causes X (the demo client does this).

### Output text semantics

`block.output` text is what a user would see: SGR colours and cursor movement are resolved by the
headless terminal, `\r` progress updates collapse to their final state, wrapped lines are joined
back. Every logical line that was terminated ends with `\n`; a trailing partial line (e.g.
`printf 'no newline'`) has none. Concatenating all `block.output` chunks of a block gives the same
text whether it was streamed in one or many chunks.

## Shell integration injection

The daemon uses VS Code's own shell-integration scripts (MIT) and injects them the way
`getShellIntegrationInjection` in `src/vs/platform/terminal/node/terminalEnvironment.ts` (tag
1.141.0) does:

* **bash**: `bash --init-file <pkg>/shell-integration/shellIntegration-bash.sh`. The script itself
  sources `~/.bashrc` (or the login files when `VSCODE_SHELL_LOGIN=1`) because `--init-file`
  replaces the normal rc loading.
* **zsh**: `zsh -i` with `ZDOTDIR=$TMPDIR/<user>-somed-zsh` (created with mode `0o1700`, sticky
  bit, like VS Code) containing copies of `shellIntegration-rc.zsh → .zshrc`, `-profile.zsh →
  .zprofile`, `-env.zsh → .zshenv`, `-login.zsh → .zlogin`; `USER_ZDOTDIR` points at the user's
  real `$ZDOTDIR`/home so the scripts chain to the user's own files.
* **fish**: `fish --init-command 'source …/shellIntegration.fish'`; **pwsh**: `pwsh -noexit -command '. "…/shellIntegration.ps1"'` (both untested here, binaries not installed).
* Environment mixin: `VSCODE_INJECTION=1`, `VSCODE_NONCE=<per-session random>`, `VSCODE_STABLE=1`,
  `TERM_PROGRAM=vscode`, plus `VSCODE_SHELL_LOGIN=1` for login shells. `TERM` defaults to
  `xterm-256color`. Launch arguments other than `-l/--login` (and `-i`) make injection fail
  (`unsupported-args`), the same rule VS Code applies.

The scripts emit `OSC 633 ; A/B/C/D;exit/E;cmd;nonce/F/G/P;key=value` sequences. `blocks.ts`
registers an OSC 633 handler on an `@xterm/headless` terminal that receives everything the PTY
outputs, and uses terminal markers (which follow the buffer as it scrolls) to record where the
prompt, the typed command and the output begin:

* `A` → prompt marker; `B` → input marker (prompt text = buffer between A and B).
* `E` → command line, unescaped like VS Code's `deserializeVSCodeOscMessage` (`\\`, `\x3b`, `\xNN`);
  `trusted` iff the trailing nonce equals the session's `VSCODE_NONCE` (an attacker printing a fake
  `E` sequence cannot know it). When the shell reports only the first simple command (bash does
  that when `HISTCONTROL` contains `ignore*`, falling back to `$BASH_COMMAND`: `cd /tmp && pwd` →
  `cd /tmp`) and the typed text in the buffer extends it, the typed text is used and marked
  untrusted. Multi-line input is recognised through the `F`/`G` continuation-prompt markers.
* `C` → `block.start` + `block.command`; an output marker is placed at the cursor. If `E` was empty
  and nothing was typed (plain Enter — bash still fires the DEBUG trap for `PROMPT_COMMAND`), no
  block is created.
* While a command runs, every parsed chunk streams the logical lines above the cursor as
  `block.output`; `D` flushes the rest (including a partial last line), then emits `block.end` with
  the exit code and `durationMs = time(D) − time(C)`.
* `P;Cwd=` updates the cwd used by the next `block.command` and emits `cwd`.
* `buffer.onBufferChange` → alternate screen (`less`, `vi`, `htop`…): the block is flagged `tui`
  and no output is captured. `clear` (`ESC[H ESC[2J ESC[3J`) leaves the cursor above the output
  marker, which yields an empty output and keeps detection working for the next command.

## What works / known gaps

Works (all covered by tests against real bash): one-line and multi-line output, no trailing
newline, no output, non-zero exit, stderr, `cd` + cwd tracking, empty Enter, 2000-line bursts, `clear`,
ANSI colours, quoted/semicolon command lines, heredocs with continuation prompts, long wrapped
lines, `\r` progress output, `sleep` durations, `less` and raw `?1049h` alternate screen, sessions
surviving disconnect, replay from a `seq`, pairing/auth, TLS bootstrap and fingerprint pinning,
`fs.*` incl. watch notifications.

Gaps / to do next:

* **zsh/fish/pwsh untested** (not installed in the build environment); the zsh test is skipped
  automatically. zsh prints `%` + newline for partial lines before `precmd`, which would land in the
  output text.
* The headless terminal keeps 10 000 lines of scrollback. A single burst larger than that between two
  parses loses the oldest lines (streaming flushes per PTY chunk make this unlikely but possible).
* Output is captured as rendered text; a future `block.output` variant with the raw escape stream
  (for colours in the client) is not implemented. `session.data` carries the raw stream today.
* Typing ahead while a command runs is echoed by the tty into that command's output (inherent to
  terminals). The buffer-derived command-line heuristic ignores such lines, but output text keeps them.
* `session.attach` returns raw scrollback bytes, which may start mid escape sequence; serialising the
  headless buffer would be better.
* Sessions do not survive a daemon restart (their JSONL logs do and can be replayed; `session.list`
  reports them under `persisted`).
* No per-path sandboxing of `fs.*` — the daemon acts as its user, like a remote-SSH backend. Access
  is gated only by device pairing; there is no rate limiting beyond pairing attempts.
* Pairing codes are typed by a human; a QR/URL flow and device revocation UI are not built
  (`devices` only lists).
* Windows (ConPTY, pwsh) is not handled.

## Measurements

Environment: Linux x86_64 VM, Node 22.22, bash 5.2, `HISTCONTROL=ignoreboth` in the host `.bashrc`
(tests use a scratch `$HOME`).

**Block detection** — `npm test` runs 73 tests (1 skipped: zsh). The somed part: 24 block
detection tests, 12 server/auth tests, 3 store tests, all against a live `bash`, in ~2.2 s wall
time; the whole repo suite in ~3.0 s. All 17 scripted bash sequences produce the expected
`commandLine`, output text, `exitCode`, `cwd` and `tui` flag; the HISTCONTROL fallback produces the
full typed line (`cd /tmp && pwd`) marked untrusted.

**Latency** (in-process daemon + `ws` client over TLS on localhost, measured by a bench script;
means over 10 sessions / 20 commands):

| measurement | value |
| --- | --- |
| `session.create` → first prompt (`cwd` notification) | 15–17 ms avg (min 6, max 53) |
| Enter → `block.start` notification at the client (`echo hi`) | 5.7 ms avg |
| Enter → `block.end` at the client (`echo hi`) | 7.1 ms avg; 30–44 ms avg for the very first command of a fresh session |
| `seq 100000` (589 KB of output) | captured completely; block `durationMs` 581, 588 ms until `block.end` at the client |
| `sleep 0.2` | `durationMs` 203–204 |

**Memory** (RSS of the daemon process):

| state | RSS |
| --- | --- |
| `somed serve` idle, TLS, no sessions | ≈ 96 MiB (node + ws + xterm + node-pty loaded; heap ≈ 14 MiB) |
| 10 live bash sessions, one block each | ≈ 101 MiB (≈ 0.6 MiB per idle session for the headless terminal, PTY and log) |
| after a 100 000-line burst in one session | ≈ 142 MiB (10 000-line scrollback + raw ring buffer; V8 reclaims part later) |

Each bash process is additional (~3.5 MiB RSS each, outside the daemon).

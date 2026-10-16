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
├── src/auth.ts       pairing codes + lockout, devices.json, channel-bound Ed25519 challenge/response
├── src/server.ts     wss JSON-RPC server, TLS bootstrap, --root confinement, backpressure, fs.* methods
├── src/client.ts     small protocol client (demo CLI + tests), certificate pinning
├── src/cli.ts        serve | pair | client | replay | devices
├── shell-integration/   VS Code's scripts (MIT, tag 1.141.0) + NOTICE
└── tests/            vitest: blocks (real bash), server/auth, store, hardening probes
```

## Running

Requirements: Node 22.12+, a C++ toolchain for `node-pty` (installed with `npm install` at the repo
root), `bash`; `openssl` for TLS (optional but strongly recommended); `zsh` optional.

```bash
npm install                                   # repo root, builds node-pty
node packages/somed/src/cli.ts serve          # wss://127.0.0.1:7700 (--port, --host, --root <dir>, --pair, --no-tls, --stats)
node packages/somed/src/cli.ts pair           # prints the current 6-digit pairing code (creates one if none)
node packages/somed/src/cli.ts client --host wss://localhost:7700 --code 123456
node packages/somed/src/cli.ts replay <sessionId>
node packages/somed/src/cli.ts devices
```

`serve --root <dir>` (default: the directory `serve` was started in) is the only directory the
`fs.*` methods and session working directories may touch; `--pair` prints a pairing code at
startup (otherwise run `somed pair` in another terminal — codes are **never** created on request
of a network client).

The demo client pairs (when `--code` is given), authenticates with its Ed25519 key, creates a bash
session, runs a few commands and prints every block event it receives, then re-attaches to show the
persisted replay. TLS trust works like SSH: while pairing, the client accepts the certificate it
sees and **pins its SHA-256 fingerprint in `client/device.json`** (keyed by `host:port`); every later
connection must present the same certificate or the client refuses to connect (`--trust-new-fingerprint`
replaces the pin when the daemon's certificate legitimately changed). `--fingerprint AB:CD:…`
(printed by `serve` and `pair`) pins explicitly; `--insecure` accepts any certificate, prints a
warning, and should only be used for experiments. `--raw` also prints the raw terminal stream.

State lives in `~/.some-ide/somed/` (override with `$SOMED_HOME`):

| path | content |
| --- | --- |
| `tls/cert.pem`, `tls/key.pem` | self-signed P-256 certificate generated with the `openssl` CLI at first start |
| `devices.json` | paired devices (`publicKey` = base64 SPKI DER Ed25519, `name`, `pairedAt`, `lastSeenAt`) |
| `pairing.json` | the current pairing code and its expiry (shared between `serve` and `pair`) |
| `sessions/<id>.jsonl` | one JSON object per line: `session.meta`, block events, `cwd`, `session.exit`; each with `seq` and `ts` |
| `client/device.json` | the demo client's own key pair and the pinned daemon fingerprints (`pins`) |

Tests: `npm test` from the repo root (vitest picks up `packages/somed/tests/*.test.ts`), typecheck
with `npm run typecheck`. The whole somed suite (including the hardening probes, which drive real
daemons over the socket) runs against a real `bash` in about 4 s.

## Protocol

One WebSocket, JSON text frames, JSON-RPC shaped:

```
client → server   { "id": 1, "method": "session.input", "params": { "id": "9a9f…", "data": "ls\r" } }
server → client   { "id": 1, "result": { "ok": true } }
                  { "id": 1, "error": { "code": -32001, "message": "not authenticated" } }
server → client   { "method": "block.output", "params": { "sessionId": "9a9f…", "seq": 15, "id": "9a9f…:3", "text": "/tmp\n", "ts": … } }
```

Error codes: `-32700` parse, `-32600` invalid request, `-32601` unknown method, `-32602` invalid
params, `-32603` internal, `-32001` unauthorized, `-32002` not found, `-32003` pairing failure,
`-32004` forbidden (path outside `--root`), `-32005` resource limit (sessions, watchers).

Every frame is validated before it is touched: anything that is not a JSON object with a string
`method` gets `-32600` (a bare `null` used to crash the daemon through an unhandled rejection);
`params` that is not an object is treated as `{}`; only scalar `id`s are echoed back. Frames above
16 MiB are refused by the WebSocket layer (close code 1009). A handler that throws answers with
`-32603` and the daemon keeps serving; `serve` additionally installs `unhandledRejection` /
`uncaughtException` handlers that log and continue.

### Unauthenticated methods

| method | params → result |
| --- | --- |
| `ping` | → `{ time, tls }` |
| `pair.start` | → `{ pending, expiresAt?, lockedForMs, hint }` — **reporting only**: whether a code currently exists and until when. Codes are created on the host (`somed pair`, `somed serve --pair`), printed on the console and written to `pairing.json`; valid 5 minutes, single use, dead after 5 wrong guesses. A network client can never mint one. |
| `pair.complete` | `{ code, devicePublicKey, deviceName }` → `{ device }`; stores the device in `devices.json` (control characters stripped from the name). Pairing does not authenticate the connection. **Every failure** (wrong code, no code pending, bad key) is logged with the remote address, closes the socket (1008) and counts towards a global lockout: 5 failures within 5 minutes refuse `pair.complete` for 60 s, doubling on each further lockout (1 h cap); a successful pairing resets the streak. |
| `auth.challenge` | `{ devicePublicKey }` → `{ nonce }` (32 random bytes, base64; the key must be paired) |
| `auth.verify` | `{ signature }` → `{ device }`. The signature is Ed25519 over `"somed-auth-v1" ‖ sha256(server certificate DER) ‖ nonce`, where the certificate hash is what the client observed on **its own** TLS socket (`getPeerCertificate().raw`, i.e. `fingerprint256` as bytes) and the server uses its own certificate; without TLS both sides use 32 zero bytes. A signature over the old payload (raw nonce) is rejected. Verified with Node's `crypto.verify(null, …)`. |

### Authenticated methods

| method | params → result |
| --- | --- |
| `server.info` | → `{ version, pid, platform, tls, fingerprint, shells, defaultShell, home, dataDir, root, limits: { maxSessions, cols, rows, fileBytes, replayChunk } }` |
| `session.create` | `{ shell?, cwd?, cols, rows }` → `SessionInfo`; the connection is attached automatically. `cwd` defaults to `--root` and must resolve inside it (`-32004`) and be a directory; `cols` and `rows` must be safe integers in 2..1000 / 1..500 (`-32602`, nothing is clamped silently: `cols: 20000` used to allocate gigabytes). At most 64 live sessions (`-32005`). |
| `session.input` | `{ id, data }` |
| `session.resize` | `{ id, cols, rows }` — same size rules as `session.create` |
| `session.list` | → `{ sessions: SessionInfo[], persisted: string[] }`. Exited sessions are evicted from memory but still appear with `alive: false`, `exitCode` and `blockCount` read from the first and last line of their log. |
| `session.attach` | `{ id, fromSeq, limit? }` → `{ info, alive, events, more, nextSeq, scrollback }` — `events` are the persisted events with `seq > fromSeq`, **at most 1000 per call** (`limit` ≤ 1000) **and about 1 MiB of log lines** (a page ends early once it holds that much; a single larger event travels alone); when `more` is true fetch the rest with `session.replay { id, fromSeq: nextSeq }` (the demo client's `attach()` does the loop). Live notifications follow the attach immediately (their `seq` is higher than anything in the pages). `scrollback` is the last 256 KiB of raw output for repainting a terminal. |
| `session.replay` | `{ id, fromSeq, limit? }` → `{ events, more, nextSeq }` — one page of persisted events without attaching. Any page costs about the same: the log is bisected for `fromSeq` (seqs grow with the file offset), so paging through a 64 MiB log is one scan in total, not one per page. |
| `session.detach` | `{ id }` |
| `session.kill` | `{ id }` (SIGHUP; the `session.exit` event is persisted) |
| `fs.list` | `{ path }` → `{ path, entries: [{ name, type: file/dir/symlink/other, size, mtime }] }` (`size`/`mtime` from `lstat`: a symlink describes itself) |
| `fs.read` | `{ path, encoding?: utf8/base64 }` → `{ content, encoding, size, mtime }`. Regular files only (`lstat` after resolving symlinks inside root; FIFOs, devices and sockets are refused instead of hanging a thread-pool worker), opened with `O_NOFOLLOW | O_NONBLOCK`, 16 MiB limit. |
| `fs.write` | `{ path, content, encoding?, mkdir? }` → `{ path, size }`. Written atomically: `<dir>/.tmp-<random>` + `fsync` + `rename` over the target, preserving the existing file's mode. A symlink inside root is followed to its target (the link survives); one pointing outside root is refused (`-32004`); directories/FIFOs are refused (`-32602`). 16 MiB limit. |
| `fs.watch` | `{ path, recursive? }` → `{ watchId }`; `fs.unwatch { watchId }`. Watchers belong to the connection (64 per connection) and are closed on disconnect; `recursive` only inside root. |

All `path`s (and `session.create.cwd`) may be absolute or relative to `--root`; they are resolved,
the longest existing prefix is passed through `realpath`, and the result must be `root` or below it
(`-32004` otherwise). The daemon's own state directory (`$SOMED_HOME`) is refused even when it lies
inside the root, so `devices.json` cannot be rewritten through `fs.write`.

### Notifications (server → client)

All session notifications carry `sessionId` and, for persisted events, `seq`:

| method | fields |
| --- | --- |
| `block.start` | `id, ts` |
| `block.command` | `id, commandLine, cwd, trusted, prompt?` — `trusted` is true when the command line came from the shell with the right nonce (see below) |
| `block.output` | `id, text` — append; emitted as logical lines complete, final chunk at command end |
| `block.end` | `id, exitCode (undefined when unknown), durationMs, tui, ts, truncated?` — `truncated: true` when the block was closed by a stray `A`/`B`/`C` sequence that arrived while it was running (output that contained a forged prompt sequence, or a nested shell with its own integration), not by the shell's `D` |
| `cwd` | `cwd` — reported by the shell at startup and after every command (`OSC 633 ; P ; Cwd=`) |
| `session.exit` | `exitCode, signal, blockCount` |
| `session.data` | `id, data` — raw PTY output (not persisted), for an xterm.js renderer on the client |
| `session.detached` | `id, reason: 'slow-consumer'` — the daemon detached this connection from the session because it did not read for 30 s (see below) and is closing it (`1013 slow consumer`); reconnect and re-attach with `session.attach {fromSeq}` |
| `fs.event` | `watchId, path, eventType, filename` |

A session is owned by the daemon, not by a connection: closing the socket leaves the shell running;
`session.attach {fromSeq}` replays what was missed. Because several frames can arrive in one TCP
chunk, a client should register its "wait for event X" listener **before** sending the input that
causes X (the demo client does this).

**Ordering.** The frames of one connection are handled one at a time, in the order they arrived:
the reply to a request is queued before the next frame is looked at (`fs.write` followed by
`fs.read` of the same path returns the new content). Connections do not wait for each other.

**Backpressure.** Output is pushed, so a client that stops reading would make the daemon buffer PTY
output without bound. When a connection's send queue (`ws.bufferedAmount`) exceeds 4 MiB the daemon
pauses the PTYs of every session attached to that connection (`node-pty` `pause()`: the shell blocks
on its next write once the kernel buffer is full); it polls the queue and resumes below 1 MiB. While
the queue is over the mark the connection's **requests are refused** with `-32005 slow consumer:
read your socket …` and its notifications are dropped, before any handler runs: a client that is
not reading cannot make the daemon execute forty 16 MiB `fs.read`s, page a replay or write files
whose results it would never see. A connection that stays stalled for 30 s is detached from its
sessions (which resume for everybody else), receives `session.detached` and is closed with
`1013 slow consumer` (both queue behind the backlog; a socket that never drains is destroyed by the
close timeout). A queue over 64 MiB terminates the socket at once. Sessions use a reference count,
so a slow client never pauses a session for a fast one longer than its own stall.

**Session and log limits.** 64 live sessions per daemon; a session whose shell exited is evicted from
memory (its 256 KiB raw buffer and headless terminal are freed) and only its JSONL log remains. A log
stops recording `block.output` at 64 MiB (`SessionInfo.logTruncated`), while `block.start/command/end`,
`cwd` and `session.exit` are still appended so the block list stays complete; live streaming is not
affected. Replay bisects the log for `fromSeq`, then reads 64 KiB chunks and stops after 1000 events
or ~1 MiB of lines. The headless terminal's scrollback is budgeted in cells, not lines: 10 000 lines
up to 200 columns, `2 000 000 / cols` lines beyond that (2 000 at 1 000 columns), re-applied on
resize, so one session's buffer stays under ~24 MiB whatever its size.

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
* **zsh**: `zsh -i` with `ZDOTDIR` set to a fresh `mkdtemp` directory under `os.tmpdir()`
  (`somed-zsh-XXXXXX`, mode `0o700`, one per session, removed when the session exits) containing
  copies of `shellIntegration-rc.zsh → .zshrc`, `-profile.zsh → .zprofile`, `-env.zsh → .zshenv`,
  `-login.zsh → .zlogin`; `USER_ZDOTDIR` points at the user's real `$ZDOTDIR`/home so the scripts
  chain to the user's own files. (VS Code's fixed `$TMPDIR/<user>-somed-zsh` name could be
  pre-created by another local user, which made the spawn fail with `EPERM`, and was never cleaned.)
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
* `P;Cwd=` updates the cwd used by the next `block.command` and emits `cwd` — but only where the
  shells emit it: at startup and between `D` and `B` (bash/zsh/fish report it right after `D`,
  pwsh between `A` and `B`). `P` is ignored while a block is running, while the prompt is waiting
  for input (`B` seen, so a background job printing `printf '\e]633;P;Cwd=/x\a'` at the prompt
  changes nothing) and, after a stray `A`/`B`/`C` closed a block, until the shell's own `D`
  arrives — so output such as `ESC]633;A … ESC]633;P;Cwd=/forged` cannot re-open the gate by
  faking a prompt first.
* **Forged `A`/`B`/`C` in output** (`cat` of a file that contains `ESC ] 633 ; A BEL`): only `E`
  carries the nonce, so these cannot be told from a shell reset or a nested shell. The running block
  is closed with `exitCode: undefined, truncated: true` and parsing continues normally, so the next
  real command is detected with its real exit code. A forged `E`+`C` can at most produce an
  **untrusted** `block.command`. A forged `D` ends the block with the forged exit code (known gap).
* `buffer.onBufferChange` → alternate screen (`less`, `vi`, `htop`…): the block is flagged `tui`
  and no output is captured. `clear` (`ESC[H ESC[2J ESC[3J`) leaves the cursor above the output
  marker, which yields an empty output and keeps detection working for the next command.

## Threat model

**What pairing protects.** A device that was never paired can do nothing but `ping`, ask whether a
pairing code is pending, and guess codes — slowly: codes exist only when a human created one on the
host, die after 5 wrong guesses or 5 minutes, and five failed `pair.complete` calls from anywhere
lock pairing for 60 s with exponential backoff (a brute force that used to reach a 50 % hit in
about six minutes now needs the host operator to keep re-creating codes). Authentication is an
Ed25519 challenge/response whose signed payload includes the hash of the TLS certificate the client
actually saw, so a relay with its own certificate (the self-signed setup invites "accept anything"
clients) cannot forward signatures to the real daemon; the demo client pins the certificate it saw
at pairing time and refuses to talk to a different one afterwards. Malformed frames, oversized
frames, absurd terminal sizes, slow readers and runaway logs are bounded so one remote peer cannot
take the daemon (and with it every shell) down.

**What it does not protect.** A *paired* device is trusted like a logged-in user of the account the
daemon runs as. `--root` confines `fs.*` and the working directory of new sessions so a **buggy or
confused client** cannot read `~/.ssh` or rewrite `devices.json` by accident — but `session.*`
hands out a full interactive shell, and a shell can `cd` anywhere. The root restriction therefore
contains mistakes, not a malicious paired client; the only defence against a malicious device is
not pairing it (and removing it from `devices.json`). There is no per-device session ownership:
every paired device may attach to, type into and kill every session. Without TLS (`--no-tls`)
nothing on the wire is protected and the channel binding is a constant.

## What works / known gaps

Works (all covered by tests against real bash): one-line and multi-line output, no trailing
newline, no output, non-zero exit, stderr, `cd` + cwd tracking, empty Enter, 2000-line bursts, `clear`,
ANSI colours, quoted/semicolon command lines, heredocs with continuation prompts, long wrapped
lines, `\r` progress output, `sleep` durations, `less` and raw `?1049h` alternate screen, forged
`P;Cwd` / `A` / `B` / `C` sequences in command output, sessions surviving disconnect, chunked replay
from a `seq`, pairing (lockout, socket close, no network minting), channel-bound auth, TLS bootstrap,
fingerprint pinning (explicit and trust-on-first-use), malformed pre-auth frames, size limits,
send-queue backpressure, `--root` confinement incl. symlink escapes and the state directory, `fs.*`
edge cases (FIFO, device symlink, atomic write with mode preserved, 16 MiB caps), session cap and
eviction, log cap, watch notifications.

Gaps / to do next:

* **zsh/fish/pwsh untested** (not installed in the build environment); the zsh test is skipped
  automatically. zsh prints `%` + newline for partial lines before `precmd`, which would land in the
  output text.
* The headless terminal keeps up to 10 000 lines of scrollback (fewer at more than 200 columns, see
  "Session and log limits"). A single burst larger than that between two parses loses the oldest
  lines (streaming flushes per PTY chunk make this unlikely but possible).
* Output is captured as rendered text; a future `block.output` variant with the raw escape stream
  (for colours in the client) is not implemented. `session.data` carries the raw stream today.
* Typing ahead while a command runs is echoed by the tty into that command's output (inherent to
  terminals). The buffer-derived command-line heuristic ignores such lines, but output text keeps them.
* `session.attach` returns raw scrollback bytes, which may start mid escape sequence; serialising the
  headless buffer would be better.
* Sessions do not survive a daemon restart (their JSONL logs do and can be replayed; `session.list`
  reports them with `alive: false` and under `persisted`).
* `--root` only confines `fs.*` and the initial cwd; `session.*` is a full shell (see "Threat
  model"). There is no per-device session ownership and no revocation UI (`devices` only lists;
  edit `devices.json` and restart). Rate limiting exists for pairing only; an authenticated client
  can still create 64 sessions and 64 watchers per connection.
* `fs.read`/`fs.write` resolve symlinks once; a symlink swapped between the check and the open is
  caught by `O_NOFOLLOW` only for the final component. Hard links are not detected (an atomic
  rename replaces the inode, so other links keep the old content).
* A forged `OSC 633 ; D` in command output ends the block with the attacker's exit code; only `E`
  carries the nonce. A client should treat `trusted: false` command lines and `truncated: true`
  blocks with suspicion.
* The 30 s stall timeout and the 4 MiB/1 MiB/64 MiB marks are fixed in code (`DaemonOptions` exposes
  them for tests, the CLI does not). A stalled client's requests are refused rather than queued, so
  a UI must read its socket (or reconnect) before retrying.
* The lockout state lives in the daemon process: a restart clears it. Pairing codes are typed by a
  human; a QR/URL flow is not built.
* Windows (ConPTY, pwsh) is not handled.

## Measurements

Environment: Linux x86_64 VM, Node 22.22, bash 5.2, `HISTCONTROL=ignoreboth` in the host `.bashrc`
(tests use a scratch `$HOME`).

**Block detection** — `npm test` runs 93 tests (1 skipped: zsh). The somed part: 27 block
detection tests, 12 server/auth tests, 3 store tests and 17 hardening probes (real daemons over the
socket), all against a live `bash`, in ~4 s wall time; the whole repo suite in ~4 s. All 17 scripted bash sequences produce the expected
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
| a 1000×500 session after `seq 12000` | +24.7 MiB (2 000-line scrollback at 1 000 columns; was +117 MiB with 10 000 lines) |
| a client that paused its socket and sent 80 `fs.read`s of a 16 MiB file | +113 MiB (one reply queued, the rest refused; was +1.8 GiB), other clients' `ping` 1–2 ms |

Each bash process is additional (~3.5 MiB RSS each, outside the daemon).

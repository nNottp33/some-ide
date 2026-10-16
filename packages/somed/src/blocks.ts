/**
 * Block detection: feeds PTY output through a headless xterm.js instance, listens for the
 * `OSC 633` shell integration sequences emitted by VS Code's scripts and turns every executed
 * command into a "block" (prompt + command line + captured output + exit code), the unit a
 * Warp-like terminal UI renders.
 *
 * Sequence reference (shellIntegrationAddon.ts in microsoft/vscode 1.141.0):
 *   OSC 633 ; A ST                     prompt start
 *   OSC 633 ; B ST                     command start (prompt end, user input begins)
 *   OSC 633 ; C ST                     command executed (output start)
 *   OSC 633 ; D [; <exitCode>] ST      command finished
 *   OSC 633 ; E ; <cmdline> ; <nonce>  command line ('\' and ';' and control chars are escaped)
 *   OSC 633 ; P ; <key>=<value> ST     property (Cwd=…, HasRichCommandDetection=…, Prompt=…)
 *   OSC 633 ; F / G                    continuation prompt start/end (ignored here)
 *
 * Output text is read back from the terminal buffer between markers, so cursor movement, `\r`
 * progress bars and colours are resolved exactly as a user would see them. Commands that switch
 * to the alternate screen (less, vi, htop…) are flagged `tui` and their output is not captured.
 */
import xterm from '@xterm/headless'
import type { IMarker, Terminal } from '@xterm/headless'
import { Emitter } from './util.ts'

export type BlockEvent =
  | { type: 'block.start'; id: string; ts: number }
  | { type: 'block.command'; id: string; commandLine: string; cwd: string; trusted: boolean; prompt?: string }
  | { type: 'block.output'; id: string; text: string }
  | { type: 'block.end'; id: string; exitCode: number | undefined; durationMs: number; tui: boolean; ts: number }
  /** Working directory reported by the shell (`OSC 633 ; P ; Cwd=…`), after every command and at startup. */
  | { type: 'cwd'; cwd: string }

export type BlockEventType = BlockEvent['type']

export interface BlockDetectorOptions {
  cols: number
  rows: number
  /** Nonce passed to the shell as VSCODE_NONCE; command lines echoed back with it are trusted. */
  nonce: string
  /** Lines of scrollback kept in the headless terminal (bounds how much of a single burst can be captured). */
  scrollback?: number
  /** Prefix for block ids, e.g. the session id. */
  idPrefix?: string
  /** Block counter start (used when a session is restored). */
  firstBlockNumber?: number
}

interface ActiveBlock {
  id: string
  ts: number
  startedAt: number
  commandLine: string
  trusted: boolean
  cwd: string
  /** First line of the output (marker tracks scrolling). */
  outputMarker: IMarker | undefined
  /** Column at which output started on its first line. */
  outputStartX: number
  /** First line that has not been streamed yet. */
  streamMarker: IMarker | undefined
  /** Whether the first (partial) output line has been streamed already. */
  firstLineDone: boolean
  tui: boolean
  outputChars: number
}

/** Undo the escaping applied by `__vsc_escape_value` (same as VS Code's deserializeVSCodeOscMessage). */
export function deserializeOscMessage(message: string): string {
  return message.replaceAll(/\\(\\|x([0-9a-f]{2}))/gi, (_m: string, op: string, hex?: string) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : op,
  )
}

export function parseKeyValueAssignment(message: string): { key: string; value: string | undefined } {
  const i = message.indexOf('=')
  if (i === -1) return { key: message, value: undefined }
  return { key: message.substring(0, i), value: message.substring(i + 1) }
}

export class BlockDetector {
  readonly terminal: Terminal
  readonly #nonce: string
  readonly #idPrefix: string
  readonly #events = new Emitter<BlockEvent>()
  #blockCounter: number
  #cwd = ''
  #state: 'idle' | 'prompt' | 'input' | 'executing' = 'idle'
  #pendingCommandLine: { text: string; trusted: boolean } | undefined
  #promptMarker: IMarker | undefined
  #promptX = 0
  #inputMarker: IMarker | undefined
  #inputX = 0
  /** Continuation prompt (PS2) ranges printed while the user typed a multi-line command (F..G). */
  #continuations: { marker: IMarker; fromX: number; toX: number }[] = []
  #current: ActiveBlock | undefined
  #disposed = false
  #writes = 0
  #properties = new Map<string, string>()
  #seenOsc633 = false

  constructor(options: BlockDetectorOptions) {
    this.#nonce = options.nonce
    this.#idPrefix = options.idPrefix ?? ''
    this.#blockCounter = options.firstBlockNumber ?? 0
    this.terminal = new xterm.Terminal({
      cols: options.cols,
      rows: options.rows,
      allowProposedApi: true,
      scrollback: options.scrollback ?? 10_000,
    })
    this.terminal.parser.registerOscHandler(633, (data) => this.#handleOsc633(data))
    this.terminal.buffer.onBufferChange((buffer) => {
      if (buffer.type === 'alternate' && this.#current) this.#current.tui = true
    })
  }

  /** Subscribe to block events. Returns an unsubscribe function. */
  onEvent(listener: (event: BlockEvent) => void): () => void {
    return this.#events.on(listener)
  }

  get cwd(): string {
    return this.#cwd
  }

  get state(): string {
    return this.#state
  }

  /** Whether any `OSC 633` sequence has been seen (shell integration active). */
  get shellIntegrationActive(): boolean {
    return this.#seenOsc633
  }

  get currentBlockId(): string | undefined {
    return this.#current?.id
  }

  /** Properties reported through `OSC 633 ; P` (Cwd, Prompt, HasRichCommandDetection, …). */
  get properties(): ReadonlyMap<string, string> {
    return this.#properties
  }

  /** Feed raw PTY output. Resolves once xterm has parsed the chunk and streamed any complete output lines. */
  write(data: string): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    this.#writes++
    return new Promise((resolve) => {
      this.terminal.write(data, () => {
        this.#flushOutput(false)
        resolve()
      })
    })
  }

  resize(cols: number, rows: number): void {
    if (!this.#disposed) this.terminal.resize(cols, rows)
  }

  /** Dispose the detector; a block still running is ended with `exitCode` (e.g. the shell's exit code). */
  dispose(exitCode?: number): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#current) this.#finish(exitCode)
    this.#events.clear()
    this.terminal.dispose()
  }

  get writeCount(): number {
    return this.#writes
  }

  // ---- OSC 633 ------------------------------------------------------------------------------

  #handleOsc633(data: string): boolean {
    this.#seenOsc633 = true
    const [command, ...args] = data.split(';')
    switch (command) {
      case 'A':
        return this.#handlePromptStart()
      case 'B':
        return this.#handleCommandStart()
      case 'C':
        return this.#handleCommandExecuted()
      case 'D':
        return this.#handleCommandFinished(args[0])
      case 'E': {
        const text = args[0] !== undefined ? deserializeOscMessage(args[0]) : ''
        this.#pendingCommandLine = { text, trusted: args[1] === this.#nonce }
        return true
      }
      case 'P': {
        const { key, value } = parseKeyValueAssignment(args[0] !== undefined ? deserializeOscMessage(args[0]) : '')
        if (value === undefined) return true
        this.#properties.set(key, value)
        if (key === 'Cwd') {
          this.#cwd = value
          this.#events.fire({ type: 'cwd', cwd: value })
        }
        return true
      }
      case 'F': {
        const marker = this.terminal.registerMarker(0)
        if (marker) this.#continuations.push({ marker, fromX: this.terminal.buffer.active.cursorX, toX: -1 })
        return true
      }
      case 'G': {
        const last = this.#continuations[this.#continuations.length - 1]
        if (last && last.toX === -1) last.toX = this.terminal.buffer.active.cursorX
        return true
      }
      default:
        // H, I (right prompt), SetMark, Env* — accepted and ignored.
        return true
    }
  }

  #handlePromptStart(): boolean {
    // A prompt while a command is still "executing" means we missed D (e.g. shell was reset).
    if (this.#current) this.#finish(undefined)
    this.#state = 'prompt'
    this.#promptMarker?.dispose()
    this.#promptMarker = this.terminal.registerMarker(0)
    this.#promptX = this.terminal.buffer.active.cursorX
    return true
  }

  #handleCommandStart(): boolean {
    this.#state = 'input'
    this.#inputMarker?.dispose()
    this.#inputMarker = this.terminal.registerMarker(0)
    this.#inputX = this.terminal.buffer.active.cursorX
    for (const c of this.#continuations) c.marker.dispose()
    this.#continuations = []
    return true
  }

  #handleCommandExecuted(): boolean {
    if (this.#current) return true // duplicate C — keep the running block
    const buf = this.terminal.buffer.active
    const pending = this.#pendingCommandLine
    this.#pendingCommandLine = undefined
    const typed = this.#typedText().replace(/\s+$/, '')
    let commandLine: string
    let trusted: boolean
    if (pending?.trusted) {
      const fromShell = pending.text.replace(/\n$/, '')
      if (fromShell.length > 0 && typed.length > fromShell.length && typed.startsWith(fromShell)) {
        // bash reports only the first simple command ($BASH_COMMAND) when HISTCONTROL contains
        // ignore*/erasedups; what the user typed is the better description of the block then.
        commandLine = typed
        trusted = false
      } else {
        commandLine = fromShell
        trusted = true
      }
    } else {
      commandLine = pending?.text.replace(/\n$/, '') || typed
      trusted = false
    }
    if (commandLine.trim().length === 0) {
      // Enter on an empty line: bash still runs PROMPT_COMMAND through the DEBUG trap, which emits
      // E (empty) + C + D. That is not a block.
      this.#state = 'executing'
      return true
    }
    const id = `${this.#idPrefix}${++this.#blockCounter}`
    const ts = Date.now()
    const prompt = this.#textBetween(this.#promptMarker, this.#promptX, this.#inputMarker?.line ?? -1, this.#inputX)
    this.#current = {
      id,
      ts,
      startedAt: performance.now(),
      commandLine,
      trusted,
      cwd: this.#cwd,
      outputMarker: this.terminal.registerMarker(0),
      outputStartX: buf.cursorX,
      streamMarker: this.terminal.registerMarker(0),
      firstLineDone: false,
      tui: buf.type === 'alternate',
      outputChars: 0,
    }
    this.#state = 'executing'
    this.#events.fire({ type: 'block.start', id, ts })
    this.#events.fire({ type: 'block.command', id, commandLine, cwd: this.#cwd, trusted, prompt: prompt || undefined })
    return true
  }

  /** What the user typed after the prompt (between B and the cursor), continuation prompts removed. */
  #typedText(): string {
    const buf = this.terminal.buffer.active
    const startLine = this.#inputMarker?.line ?? -1
    const cursorLine = buf.baseY + buf.cursorY
    if (startLine < 0 || cursorLine < startLine) return ''
    const parts: string[] = []
    for (let y = startLine; y <= cursorLine; y++) {
      const line = buf.getLine(y)
      if (!line) break
      const continuation = this.#continuations.find((c) => c.marker.line === y && c.toX > c.fromX)
      // A line belongs to the typed command only if it wraps from the previous one or starts with a
      // continuation prompt (PS2). Anything else (e.g. type-ahead echoed by the tty) is not the command.
      if (y > startLine && !line.isWrapped && !continuation) break
      const next = buf.getLine(y + 1)
      const continues = y < cursorLine && next?.isWrapped === true
      let text =
        y === cursorLine ? line.translateToString(true, 0, buf.cursorX) : line.translateToString(!continues, 0)
      if (continuation) text = text.slice(0, continuation.fromX) + text.slice(continuation.toX)
      if (y === startLine) text = text.slice(this.#inputX)
      parts.push(text)
      if (y < cursorLine && !continues) parts.push('\n')
    }
    return parts.join('')
  }

  #handleCommandFinished(exitCodeArg: string | undefined): boolean {
    this.#pendingCommandLine = undefined
    if (!this.#current) {
      // D without C: an empty command line (just Enter) — nothing to report.
      this.#state = 'idle'
      return true
    }
    const exitCode = exitCodeArg !== undefined && exitCodeArg !== '' ? parseInt(exitCodeArg, 10) : undefined
    this.#finish(Number.isNaN(exitCode) ? undefined : exitCode)
    return true
  }

  #finish(exitCode: number | undefined): void {
    const block = this.#current
    if (!block) return
    this.#flushOutput(true)
    this.#current = undefined
    this.#state = 'idle'
    block.outputMarker?.dispose()
    block.streamMarker?.dispose()
    this.#events.fire({
      type: 'block.end',
      id: block.id,
      exitCode,
      durationMs: Math.round(performance.now() - block.startedAt),
      tui: block.tui,
      ts: Date.now(),
    })
  }

  // ---- buffer helpers -------------------------------------------------------------------------

  /**
   * Text from (marker line, startX) up to (endLine, endX) exclusive. Wrapped buffer lines are
   * joined; every terminated logical line ends with '\n'.
   */
  #textBetween(startMarker: IMarker | undefined, startX: number, endLine: number, endX: number): string {
    const startLine = startMarker?.line ?? -1
    if (startLine < 0 || endLine < startLine) return ''
    return this.#collectLines(startLine, startX, endLine, endX)
  }

  /** Lines [startLine, endLine) completely, plus the partial line endLine up to endX (undefined = none). */
  #collectLines(startLine: number, startX: number, endLine: number, endX: number | undefined): string {
    const buf = this.terminal.buffer.active
    const parts: string[] = []
    for (let y = startLine; y < endLine; y++) {
      const line = buf.getLine(y)
      if (!line) break
      const next = buf.getLine(y + 1)
      const continues = next?.isWrapped === true
      parts.push(line.translateToString(!continues, y === startLine ? startX : 0))
      if (!continues) parts.push('\n')
    }
    if (endX !== undefined && endX > 0) {
      const line = buf.getLine(endLine)
      if (line) parts.push(line.translateToString(true, endLine === startLine ? startX : 0, endX))
    }
    return parts.join('')
  }

  /**
   * Emit output captured so far. When `final` is false only complete logical lines (the cursor has
   * moved below them) are streamed; when true everything up to the cursor is emitted.
   */
  #flushOutput(final: boolean): void {
    const block = this.#current
    if (!block || block.tui) return
    const buf = this.terminal.buffer.active
    if (buf.type !== 'normal') return
    let from = block.streamMarker?.line ?? -1
    if (from < 0) {
      // The marker scrolled out of the scrollback: the burst was larger than the buffer. Continue
      // from the oldest line we still have.
      from = 0
    }
    const cursorLine = buf.baseY + buf.cursorY
    if (cursorLine < from) return // screen was cleared (e.g. `clear`): nothing new to report
    // First buffer line of the logical (possibly wrapped) line the cursor is on.
    let endLine = cursorLine
    while (endLine > from && buf.getLine(endLine)?.isWrapped) endLine--
    const startX = block.firstLineDone ? 0 : block.outputStartX

    if (!final) {
      if (endLine <= from) return
      const text = this.#collectLines(from, startX, endLine, undefined)
      block.streamMarker?.dispose()
      block.streamMarker = this.terminal.registerMarker(endLine - cursorLine)
      block.firstLineDone = true
      this.#emitOutput(block, text)
      return
    }
    // Final: complete lines plus the partial logical line the cursor is on (wrapped parts included).
    const parts = [this.#collectLines(from, startX, endLine, undefined)]
    for (let y = endLine; y <= cursorLine; y++) {
      const line = buf.getLine(y)
      if (!line) break
      const fromX = y === from ? startX : 0
      const toX = y === cursorLine ? buf.cursorX : undefined
      if (toX !== undefined && toX <= fromX) break
      parts.push(toX === undefined ? line.translateToString(false, fromX) : line.translateToString(true, fromX, toX))
    }
    const text = parts.join('')
    if (text.length > 0) this.#emitOutput(block, text)
  }

  #emitOutput(block: ActiveBlock, text: string): void {
    block.outputChars += text.length
    this.#events.fire({ type: 'block.output', id: block.id, text })
  }
}

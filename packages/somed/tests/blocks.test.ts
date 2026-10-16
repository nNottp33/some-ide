import { existsSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BlockDetector, SCROLLBACK_CELLS, SCROLLBACK_LINES, deserializeOscMessage, parseKeyValueAssignment, scrollbackFor } from '../src/blocks.ts'
import { cleanupInjection, getShellIntegrationInjection } from '../src/pty.ts'
import { hasShell, startShell, type Harness } from './helpers.ts'

describe('OSC 633 message decoding', () => {
  it('deserializes escaped command lines like VS Code', () => {
    expect(deserializeOscMessage('echo\\x20a\\x3bb')).toBe('echo a;b')
    expect(deserializeOscMessage('C:\\\\path')).toBe('C:\\path')
    expect(deserializeOscMessage('plain')).toBe('plain')
  })
  it('parses key=value properties', () => {
    expect(parseKeyValueAssignment('Cwd=/tmp/a=b')).toEqual({ key: 'Cwd', value: '/tmp/a=b' })
    expect(parseKeyValueAssignment('NoValue')).toEqual({ key: 'NoValue', value: undefined })
  })
})

describe('shell integration injection', () => {
  it('bash uses --init-file and VSCODE_* env like VS Code', () => {
    const r = getShellIntegrationInjection('/bin/bash', [], { nonce: 'abc' })
    expect(r.type).toBe('injection')
    if (r.type !== 'injection') return
    expect(r.newArgs[0]).toBe('--init-file')
    expect(r.newArgs[1]).toMatch(/shell-integration\/shellIntegration-bash\.sh$/)
    expect(r.envMixin).toMatchObject({ VSCODE_INJECTION: '1', VSCODE_NONCE: 'abc', VSCODE_STABLE: '1' })
    expect(r.envMixin.VSCODE_SHELL_LOGIN).toBeUndefined()
    const login = getShellIntegrationInjection('bash', ['-l'], { nonce: 'abc' })
    expect(login.type === 'injection' && login.envMixin.VSCODE_SHELL_LOGIN).toBe('1')
  })
  it('zsh uses a private, unpredictable, per-session ZDOTDIR with the rc files copied (removed by cleanup)', () => {
    const r = getShellIntegrationInjection('/usr/bin/zsh', undefined, { nonce: 'n', userZdotdir: '/home/x' })
    expect(r.type).toBe('injection')
    if (r.type !== 'injection') return
    expect(r.newArgs).toEqual(['-i'])
    expect(r.envMixin.ZDOTDIR).toMatch(/somed-zsh-[A-Za-z0-9]{6}$/)
    expect(r.envMixin.ZDOTDIR.startsWith(tmpdir())).toBe(true)
    expect(r.zdotdir).toBe(r.envMixin.ZDOTDIR)
    expect(statSync(r.zdotdir!).mode & 0o777).toBe(0o700)
    expect(r.envMixin.USER_ZDOTDIR).toBe('/home/x')
    expect(r.filesToCopy?.map((f) => f.dest.split('/').pop())).toEqual(['.zshrc', '.zprofile', '.zshenv', '.zlogin'])
    // A second session gets a different directory (no fixed $TMPDIR/<user>-somed-zsh name to squat on).
    const r2 = getShellIntegrationInjection('/usr/bin/zsh', undefined, { nonce: 'n' })
    expect(r2.type === 'injection' && r2.zdotdir).not.toBe(r.zdotdir)
    cleanupInjection(r)
    cleanupInjection(r2)
    cleanupInjection(r) // idempotent
    expect(existsSync(r.zdotdir!)).toBe(false)
    expect(existsSync((r2 as { zdotdir?: string }).zdotdir!)).toBe(false)
  })
  it('rejects unsupported shells and args', () => {
    expect(getShellIntegrationInjection('sh', [], { nonce: 'n' })).toEqual({ type: 'failure', reason: 'unsupported-shell' })
    expect(getShellIntegrationInjection('bash', ['-c', 'ls'], { nonce: 'n' })).toEqual({ type: 'failure', reason: 'unsupported-args' })
  })
})

describe('block detection with real bash', () => {
  let h: Harness
  const timings: Record<string, number> = {}

  beforeAll(async () => {
    const t0 = performance.now()
    h = await startShell({ shell: 'bash' })
    timings.spawnToFirstPrompt = performance.now() - t0
  }, 20_000)

  afterAll(async () => {
    const r = await h.exit()
    expect(r.exitCode).toBe(0)
    h.detector.dispose()
    // eslint-disable-next-line no-console
    console.log('timings(ms):', JSON.stringify(timings))
  })

  it('startup reports the cwd and rich command detection', () => {
    expect(h.detector.cwd).toBe(h.home)
    expect(h.detector.properties.get('HasRichCommandDetection')).toBe('True')
    expect(h.detector.shellIntegrationActive).toBe(true)
  })

  it('1. echo one line', async () => {
    const t0 = performance.now()
    const end = h.next('block.end')
    await h.run('echo hello')
    await end
    timings.firstBlock = performance.now() - t0
    const b = h.blocks().at(-1)!
    expect(b.commandLine).toBe('echo hello')
    expect(b.output).toBe('hello\n')
    expect(b.exitCode).toBe(0)
    expect(b.tui).toBe(false)
    const cmd = h.events.find((e) => e.type === 'block.command')
    expect(cmd && cmd.type === 'block.command' && cmd.trusted).toBe(true)
    expect(cmd && cmd.type === 'block.command' && cmd.prompt).toBe('$ ')
  })

  it('2. printf with no newline', async () => {
    await h.run("printf 'no newline'")
    const b = h.blocks().at(-1)!
    expect(b.commandLine).toBe("printf 'no newline'")
    expect(b.output).toBe('no newline')
    expect(b.exitCode).toBe(0)
  })

  it('3. multi-line output', async () => {
    await h.run("printf 'a\\nb\\nc\\n'")
    const b = h.blocks().at(-1)!
    expect(b.output).toBe('a\nb\nc\n')
  })

  it('4. false exits 1 with no output', async () => {
    await h.run('false')
    const b = h.blocks().at(-1)!
    expect(b.commandLine).toBe('false')
    expect(b.output).toBe('')
    expect(b.exitCode).toBe(1)
  })

  it('5. cd /tmp && pwd updates the cwd property', async () => {
    const before = h.blocks().length
    await h.run('cd /tmp && pwd')
    const b = h.blocks().at(-1)!
    expect(h.blocks().length).toBe(before + 1)
    expect(b.commandLine).toBe('cd /tmp && pwd')
    expect(b.output).toBe('/tmp\n')
    expect(b.cwd).toBe(h.home) // cwd where the command started
    expect(h.detector.cwd).toBe('/tmp')
    const last = h.events.at(-1)
    expect(last).toEqual({ type: 'cwd', cwd: '/tmp' })
    await h.run('echo here')
    expect(h.blocks().at(-1)!.cwd).toBe('/tmp')
  })

  it('6. empty command (Enter) creates no block', async () => {
    const before = h.blocks().length
    await h.run('')
    await h.run('   ')
    expect(h.blocks().length).toBe(before)
  })

  it('7. a 2000-line seq is captured completely and streamed', async () => {
    const before = h.events.length
    await h.run('seq 2000')
    const b = h.blocks().at(-1)!
    expect(b.commandLine).toBe('seq 2000')
    const expected = Array.from({ length: 2000 }, (_, i) => `${i + 1}`).join('\n') + '\n'
    expect(b.output).toBe(expected)
    expect(b.exitCode).toBe(0)
    const outputs = h.events.slice(before).filter((e) => e.type === 'block.output')
    expect(outputs.length).toBeGreaterThanOrEqual(1)
  })

  it('8. clear produces no output and keeps detecting afterwards', async () => {
    await h.run('clear')
    const b = h.blocks().at(-1)!
    expect(b.commandLine).toBe('clear')
    expect(b.output).toBe('')
    expect(b.exitCode).toBe(0)
    await h.run('echo after-clear')
    expect(h.blocks().at(-1)!.output).toBe('after-clear\n')
  })

  it('9. ANSI colours are stripped from captured text', async () => {
    await h.run("printf '\\e[31mred\\e[0m \\e[1;32mbold green\\e[0m\\n'")
    const b = h.blocks().at(-1)!
    expect(b.output).toBe('red bold green\n')
    expect(h.raw).toContain('\x1b[31mred')
  })

  it('10. quoted command line with spaces and semicolons', async () => {
    await h.run('echo "a  b" \'c;d\'')
    const b = h.blocks().at(-1)!
    expect(b.commandLine).toBe('echo "a  b" \'c;d\'')
    expect(b.output).toBe('a  b c;d\n')
  })

  it('11. heredoc (multi-line command with continuation prompts)', async () => {
    const end = h.next('block.end')
    h.shell.pty.write('cat <<EOF\r')
    await new Promise((r) => setTimeout(r, 100))
    h.shell.pty.write('hello\r')
    h.shell.pty.write('world\r')
    const cwd = h.next('cwd')
    h.shell.pty.write('EOF\r')
    await end
    await cwd
    const b = h.blocks().at(-1)!
    expect(b.commandLine).toBe('cat <<EOF\nhello\nworld\nEOF')
    expect(b.output).toBe('hello\nworld\n')
    expect(b.exitCode).toBe(0)
  })

  it('12. sleep 0.2 reports a plausible duration', async () => {
    await h.run('sleep 0.2')
    const b = h.blocks().at(-1)!
    expect(b.exitCode).toBe(0)
    expect(b.durationMs).toBeGreaterThanOrEqual(150)
    expect(b.durationMs).toBeLessThan(3000)
  })

  it('13. non-zero exit codes and stderr', async () => {
    await h.run('ls /definitely/not/here')
    const b = h.blocks().at(-1)!
    expect(b.exitCode).toBe(2)
    expect(b.output).toMatch(/No such file or directory/)
    await h.run('exit 42 | true; (exit 7)')
    expect(h.blocks().at(-1)!.exitCode).toBe(7)
  })

  it('14. alternate screen (less) is flagged tui and output is not captured', async () => {
    const end = h.next('block.end')
    h.shell.pty.write('less /etc/passwd\r')
    await new Promise((r) => setTimeout(r, 300))
    const cwd = h.next('cwd')
    h.shell.pty.write('q')
    await end
    await cwd
    const b = h.blocks().at(-1)!
    expect(b.commandLine).toBe('less /etc/passwd')
    expect(b.tui).toBe(true)
    expect(b.output).toBe('')
    expect(b.exitCode).toBe(0)
  })

  it('15. raw escape alternate screen switch is flagged tui', async () => {
    await h.run("printf '\\e[?1049h'; sleep 0.05; printf 'hidden'; printf '\\e[?1049l'")
    const b = h.blocks().at(-1)!
    expect(b.tui).toBe(true)
    expect(b.output).toBe('')
  })

  it('16. long lines that wrap are joined back', async () => {
    await h.run("printf '%0200d\\n' 7")
    const b = h.blocks().at(-1)!
    expect(b.output).toBe('0'.repeat(199) + '7\n')
  })

  it('17. carriage-return progress output is captured as rendered', async () => {
    await h.run("printf '10%%\\r50%%\\r100%%\\n'")
    const b = h.blocks().at(-1)!
    expect(b.output).toBe('100%\n')
  })

  it('18. a forged OSC 633 P;Cwd printed by a command does not change the cwd', async () => {
    const before = h.events.length
    await h.run("printf '\\e]633;P;Cwd=/forged\\a\\e]633;P;HasRichCommandDetection=False\\a'; echo done")
    expect(h.detector.cwd).toBe('/tmp')
    expect(h.detector.properties.get('HasRichCommandDetection')).toBe('True')
    const cwdEvents = h.events.slice(before).filter((e) => e.type === 'cwd')
    expect(cwdEvents).toEqual([{ type: 'cwd', cwd: '/tmp' }])
    const b = h.blocks().at(-1)!
    expect(b.output).toBe('done\n')
    expect(b.exitCode).toBe(0)
    expect(b.truncated).toBeUndefined()
  })

  it('19. a forged OSC 633 A in the output closes the block as truncated and detection continues', async () => {
    const before = h.blocks().length
    await h.run("printf 'before\\n\\e]633;A\\a'; echo after")
    expect(h.blocks().length).toBe(before + 1)
    const b = h.blocks().at(-1)!
    expect(b.commandLine).toBe("printf 'before\\n\\e]633;A\\a'; echo after")
    expect(b.output).toBe('before\n')
    expect(b.exitCode).toBeUndefined()
    expect(b.truncated).toBe(true)
    // The next real command is detected normally, with its exit code.
    await h.run('echo next')
    expect(h.blocks().length).toBe(before + 2)
    expect(h.blocks().at(-1)).toMatchObject({ commandLine: 'echo next', output: 'next\n', exitCode: 0 })
    expect(h.blocks().at(-1)!.truncated).toBeUndefined()
  })

  it('20. forged B and C sequences behave the same way (no fake block, no stuck state)', async () => {
    const before = h.blocks().length
    await h.run("printf 'x\\n\\e]633;B\\a'; false")
    expect(h.blocks().at(-1)).toMatchObject({ output: 'x\n', exitCode: undefined, truncated: true })
    await h.run("printf 'y\\n\\e]633;C\\a'; false")
    expect(h.blocks().at(-1)).toMatchObject({ output: 'y\n', exitCode: undefined, truncated: true })
    // A forged prompt+command sequence cannot produce a trusted command line.
    await h.run("printf '\\e]633;A\\a\\e]633;B\\aecho forged\\e]633;E;echo forged\\a\\e]633;C\\a'")
    const forged = h.events.filter((e) => e.type === 'block.command' && e.commandLine === 'echo forged')
    for (const e of forged) expect(e.type === 'block.command' && e.trusted).toBe(false)
    expect(h.blocks().length).toBeGreaterThanOrEqual(before + 3)
    await h.run('echo still-fine')
    expect(h.blocks().at(-1)).toMatchObject({ commandLine: 'echo still-fine', output: 'still-fine\n', exitCode: 0 })
  })

  it('21. a forged A followed by P;Cwd does not change the cwd (P stays blocked until the real D)', async () => {
    const cwd = h.detector.cwd
    const before = h.events.length
    await h.run("printf 'out\\n\\e]633;A\\a\\e]633;P;Cwd=/forged2\\a'; echo after")
    expect(h.detector.cwd).toBe(cwd)
    expect(h.events.slice(before).filter((e) => e.type === 'cwd')).toEqual([{ type: 'cwd', cwd }])
    expect(h.blocks().at(-1)).toMatchObject({ output: 'out\n', exitCode: undefined, truncated: true })
    await h.run('echo next')
    expect(h.blocks().at(-1)).toMatchObject({ commandLine: 'echo next', cwd, output: 'next\n', exitCode: 0 })
  })

  it('22. a forged C followed by P leaves the cwd and the other properties untouched', async () => {
    const cwd = h.detector.cwd
    const before = h.events.length
    await h.run("printf 'out\\n\\e]633;C\\a\\e]633;P;Cwd=/forged3\\a\\e]633;P;HasRichCommandDetection=False\\a'; echo after")
    expect(h.detector.cwd).toBe(cwd)
    expect(h.detector.properties.get('HasRichCommandDetection')).toBe('True')
    expect(h.events.slice(before).filter((e) => e.type === 'cwd')).toEqual([{ type: 'cwd', cwd }])
    expect(h.blocks().at(-1)).toMatchObject({ output: 'out\n', exitCode: undefined, truncated: true })
  })

  it('23. a forged B followed by P;Cwd is ignored too', async () => {
    const cwd = h.detector.cwd
    const before = h.events.length
    await h.run("printf 'out\\n\\e]633;B\\a\\e]633;P;Cwd=/forged4\\a'; echo after")
    expect(h.detector.cwd).toBe(cwd)
    expect(h.events.slice(before).filter((e) => e.type === 'cwd')).toEqual([{ type: 'cwd', cwd }])
    expect(h.blocks().at(-1)).toMatchObject({ output: 'out\n', exitCode: undefined, truncated: true })
  })

  it('24. a file holding a whole forged prompt (A, P;Cwd, B, E, C) cannot plant a cwd into the next block', async () => {
    const cwd = h.detector.cwd
    const before = h.events.length
    const nb = h.blocks().length
    const evil = join(h.home, 'evil.txt')
    writeFileSync(evil, 'line1\n\x1b]633;A\x07\x1b]633;P;Cwd=/forged7\x07\x1b]633;B\x07fake\x1b]633;E;fake;\x07\x1b]633;C\x07fake-output\n')
    await h.run(`cat ${evil}; echo real-tail`)
    expect(h.detector.cwd).toBe(cwd)
    expect(h.events.slice(before).filter((e) => e.type === 'cwd')).toEqual([{ type: 'cwd', cwd }])
    // The real block is closed as truncated by the forged A; the forged E+C yields an untrusted
    // block (documented), which carries the real cwd, not the forged one.
    expect(h.blocks()[nb]).toMatchObject({ output: 'line1\n', exitCode: undefined, truncated: true })
    const forged = h.events.slice(before).filter((e) => e.type === 'block.command' && e.commandLine === 'fake')
    expect(forged).toHaveLength(1)
    expect(forged[0]).toMatchObject({ cwd, trusted: false })
    await h.run('echo still-fine')
    expect(h.blocks().at(-1)).toMatchObject({ commandLine: 'echo still-fine', cwd, output: 'still-fine\n', exitCode: 0 })
  })

  it('25. a background job printing P;Cwd at the prompt (after B) is ignored', async () => {
    const cwd = h.detector.cwd
    const before = h.events.length
    await h.run("(sleep 0.3; printf '\\e]633;P;Cwd=/forged6\\a') & disown")
    // The typed command is echoed with a literal "\e"; wait for the real escape sequence.
    await vi.waitFor(() => expect(h.raw).toContain('\x1b]633;P;Cwd=/forged6\x07'), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, 100)) // let the detector parse that chunk
    expect(h.detector.state).toBe('input')
    expect(h.detector.cwd).toBe(cwd)
    expect(h.events.slice(before).filter((e) => e.type === 'cwd')).toEqual([{ type: 'cwd', cwd }])
    await h.run('echo next')
    expect(h.blocks().at(-1)).toMatchObject({ commandLine: 'echo next', cwd, output: 'next\n', exitCode: 0 })
  })
})

describe('scrollback budget', () => {
  it('keeps 10 000 lines for narrow terminals and fewer for wide ones (2 M cells), re-budgeted on resize', async () => {
    expect(SCROLLBACK_LINES).toBe(10_000)
    expect(SCROLLBACK_CELLS).toBe(2_000_000)
    expect(scrollbackFor(80)).toBe(10_000)
    expect(scrollbackFor(200)).toBe(10_000)
    expect(scrollbackFor(400)).toBe(5000)
    expect(scrollbackFor(1000)).toBe(2000)
    const d = new BlockDetector({ cols: 80, rows: 24, nonce: 'n' })
    try {
      expect(d.terminal.options.scrollback).toBe(10_000)
      await d.write('x\r\n'.repeat(12_000))
      expect(d.terminal.buffer.active.length).toBe(10_024)
      // Widening to the maximum trims the scrollback first, so the buffer never holds 10 000 lines of 1 000 cells.
      d.resize(1000, 500)
      expect(d.terminal.options.scrollback).toBe(2000)
      expect(d.terminal.buffer.active.length).toBeLessThanOrEqual(2500)
      d.resize(80, 24)
      expect(d.terminal.options.scrollback).toBe(10_000)
    } finally {
      d.dispose()
    }
    const wide = new BlockDetector({ cols: 1000, rows: 500, nonce: 'n' })
    expect(wide.terminal.options.scrollback).toBe(2000)
    wide.dispose()
    // An explicit scrollback is kept as given.
    const fixed = new BlockDetector({ cols: 1000, rows: 24, nonce: 'n', scrollback: 50 })
    fixed.resize(80, 24)
    expect(fixed.terminal.options.scrollback).toBe(50)
    fixed.dispose()
  })
})

describe('block detection with HISTCONTROL=ignoreboth (BASH_COMMAND path)', () => {
  it('uses the typed line when the shell only reports the first simple command', async () => {
    const h = await startShell({ shell: 'bash', rc: 'HISTCONTROL=ignoreboth' })
    try {
      await h.run('cd /tmp && pwd')
      const b = h.blocks().at(-1)!
      expect(b.commandLine).toBe('cd /tmp && pwd')
      expect(b.output).toBe('/tmp\n')
      const cmd = h.events.find((e) => e.type === 'block.command')
      expect(cmd && cmd.type === 'block.command' && cmd.trusted).toBe(false)
    } finally {
      await h.exit()
      h.detector.dispose()
    }
  }, 20_000)
})

describe('block detection with zsh', () => {
  const run = hasShell('zsh') ? it : it.skip
  run('detects blocks in zsh via ZDOTDIR injection', async () => {
    const h = await startShell({ shell: 'zsh' })
    try {
      await h.run('echo from-zsh')
      const b = h.blocks().at(-1)!
      expect(b.commandLine).toBe('echo from-zsh')
      expect(b.output).toBe('from-zsh\n')
      expect(b.exitCode).toBe(0)
      await h.run('false')
      expect(h.blocks().at(-1)!.exitCode).toBe(1)
    } finally {
      await h.exit()
      h.detector.dispose()
    }
  }, 20_000)
})

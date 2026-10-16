import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deserializeOscMessage, parseKeyValueAssignment } from '../src/blocks.ts'
import { getShellIntegrationInjection } from '../src/pty.ts'
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
  it('zsh uses a private ZDOTDIR with the rc files copied', () => {
    const r = getShellIntegrationInjection('/usr/bin/zsh', undefined, { nonce: 'n', userZdotdir: '/home/x' })
    expect(r.type).toBe('injection')
    if (r.type !== 'injection') return
    expect(r.newArgs).toEqual(['-i'])
    expect(r.envMixin.ZDOTDIR).toMatch(/-somed-zsh$/)
    expect(r.envMixin.USER_ZDOTDIR).toBe('/home/x')
    expect(r.filesToCopy?.map((f) => f.dest.split('/').pop())).toEqual(['.zshrc', '.zprofile', '.zshenv', '.zlogin'])
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

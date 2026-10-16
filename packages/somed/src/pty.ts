/**
 * PTY spawning with VS Code's shell integration scripts injected.
 *
 * The injection mirrors `getShellIntegrationInjection` in
 * microsoft/vscode `src/vs/platform/terminal/node/terminalEnvironment.ts` (tag 1.141.0):
 *  - bash: `bash --init-file <scripts>/shellIntegration-bash.sh`; the script sources
 *    ~/.bashrc itself when VSCODE_INJECTION=1 (or ~/.bash_profile & co. when VSCODE_SHELL_LOGIN=1).
 *  - zsh:  `zsh -i` with ZDOTDIR pointing to a private, sticky-bit temp directory that holds
 *    copies of the rc/profile/env/login scripts as .zshrc/.zprofile/.zshenv/.zlogin; the
 *    scripts restore the user's own ZDOTDIR (USER_ZDOTDIR) and source the user's files.
 *  - fish: `fish --init-command 'source <scripts>/shellIntegration.fish'`.
 *  - pwsh: `pwsh -noexit -command '. "<scripts>/shellIntegration.ps1"'`.
 * Environment mixin: VSCODE_INJECTION=1, VSCODE_NONCE=<nonce>, VSCODE_STABLE=1 and
 * TERM_PROGRAM=vscode (the scripts check TERM_PROGRAM for a few features).
 */
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { chmodSync, copyFileSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { which } from './util.ts'

export const SHELL_INTEGRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'shell-integration')

export interface ShellIntegrationInjection {
  readonly type: 'injection'
  readonly newArgs: string[]
  readonly envMixin: Record<string, string>
  readonly filesToCopy?: { source: string; dest: string }[]
}

export interface ShellIntegrationFailure {
  readonly type: 'failure'
  readonly reason: 'unsupported-shell' | 'unsupported-args'
}

const shLoginArgs = ['--login', '-l']
const shInteractiveArgs = ['-i', '--interactive']

function areLoginArgs(args: string[]): boolean {
  const rest = args.filter((a) => !shInteractiveArgs.includes(a.toLowerCase()))
  return rest.length === 1 && shLoginArgs.includes(rest[0]!.toLowerCase())
}

export interface InjectionOptions {
  /** Per-session nonce, echoed back by the script in `OSC 633 ; E` so command lines can be trusted. */
  nonce: string
  /** Login shell requested (`-l`). */
  login?: boolean
  /** Directory holding the shell integration scripts (defaults to packages/somed/shell-integration). */
  scriptRoot?: string
  /** Existing ZDOTDIR of the user (zsh only). */
  userZdotdir?: string
  /** Mark the daemon as "stable" quality; VS Code gates some work-in-progress reporting behind VSCODE_STABLE=0. */
  stable?: boolean
}

/**
 * Compute the replacement arguments and environment mixin that turn a plain shell launch into a
 * shell-integrated one. Pure (apart from the zsh ZDOTDIR directory creation) so it can be unit tested.
 */
export function getShellIntegrationInjection(
  executable: string,
  originalArgs: string[] | undefined,
  options: InjectionOptions,
): ShellIntegrationInjection | ShellIntegrationFailure {
  const shell = basename(executable)
  const root = options.scriptRoot ?? SHELL_INTEGRATION_DIR
  const args = originalArgs ?? []
  const envMixin: Record<string, string> = {
    VSCODE_INJECTION: '1',
    VSCODE_NONCE: options.nonce,
    VSCODE_STABLE: options.stable === false ? '0' : '1',
    TERM_PROGRAM: 'vscode',
    TERM_PROGRAM_VERSION: '1.141.0-somed',
  }
  const login = options.login || areLoginArgs(args)

  switch (shell) {
    case 'bash': {
      if (args.length !== 0 && !areLoginArgs(args)) return { type: 'failure', reason: 'unsupported-args' }
      if (login) envMixin.VSCODE_SHELL_LOGIN = '1'
      return { type: 'injection', newArgs: ['--init-file', join(root, 'shellIntegration-bash.sh')], envMixin }
    }
    case 'zsh': {
      if (args.length !== 0 && !areLoginArgs(args)) return { type: 'failure', reason: 'unsupported-args' }
      let username: string
      try {
        username = userInfo().username
      } catch {
        username = 'unknown'
      }
      const realTmpDir = realpathSync(tmpdir())
      const zdotdir = join(realTmpDir, `${username}-somed-zsh`)
      mkdirSync(zdotdir, { recursive: true })
      // 0o1700: sticky bit, owner rwx, nobody else — same as VS Code.
      chmodSync(zdotdir, 0o1700)
      envMixin.ZDOTDIR = zdotdir
      envMixin.USER_ZDOTDIR = options.userZdotdir ?? process.env.ZDOTDIR ?? homedir()
      const filesToCopy = [
        { source: join(root, 'shellIntegration-rc.zsh'), dest: join(zdotdir, '.zshrc') },
        { source: join(root, 'shellIntegration-profile.zsh'), dest: join(zdotdir, '.zprofile') },
        { source: join(root, 'shellIntegration-env.zsh'), dest: join(zdotdir, '.zshenv') },
        { source: join(root, 'shellIntegration-login.zsh'), dest: join(zdotdir, '.zlogin') },
      ]
      return { type: 'injection', newArgs: [login ? '-il' : '-i'], envMixin, filesToCopy }
    }
    case 'fish': {
      if (args.length !== 0 && !areLoginArgs(args)) return { type: 'failure', reason: 'unsupported-args' }
      const initArgs = ['--init-command', `source "${join(root, 'shellIntegration.fish')}"`]
      return { type: 'injection', newArgs: login ? ['-l', ...initArgs] : initArgs, envMixin }
    }
    case 'pwsh': {
      const cmd = ['-noexit', '-command', `. "${join(root, 'shellIntegration.ps1')}"`]
      return { type: 'injection', newArgs: login ? ['-l', ...cmd] : cmd, envMixin }
    }
    default:
      return { type: 'failure', reason: 'unsupported-shell' }
  }
}

export interface SpawnShellOptions {
  /** Shell name or absolute path. Defaults to $SHELL or bash. */
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  env?: NodeJS.ProcessEnv
  nonce?: string
  login?: boolean
  /** Disable shell integration injection (plain shell). */
  noShellIntegration?: boolean
}

export interface SpawnedShell {
  pty: IPty
  executable: string
  args: string[]
  nonce: string
  injection: ShellIntegrationInjection | ShellIntegrationFailure
}

export function resolveShell(shell: string | undefined): string {
  const wanted = shell && shell.length > 0 ? shell : process.env.SHELL || 'bash'
  if (wanted.includes('/')) return wanted
  return which(wanted) ?? wanted
}

export function generateNonce(): string {
  return randomBytes(16).toString('hex')
}

/** Spawn a shell in a pseudo terminal with shell integration injected. */
export function spawnShell(options: SpawnShellOptions = {}): SpawnedShell {
  const executable = resolveShell(options.shell)
  const nonce = options.nonce ?? generateNonce()
  const baseEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) }
  // These would make the injected script think it is already loaded / nested.
  delete baseEnv.VSCODE_SHELL_INTEGRATION
  delete baseEnv.VSCODE_INJECTION
  baseEnv.TERM = baseEnv.TERM && baseEnv.TERM !== 'dumb' ? baseEnv.TERM : 'xterm-256color'
  baseEnv.COLORTERM = baseEnv.COLORTERM ?? 'truecolor'

  let args = options.args ?? []
  const injection = options.noShellIntegration
    ? ({ type: 'failure', reason: 'unsupported-args' } as const)
    : getShellIntegrationInjection(executable, args, { nonce, login: options.login })
  if (injection.type === 'injection') {
    args = injection.newArgs
    Object.assign(baseEnv, injection.envMixin)
    for (const f of injection.filesToCopy ?? []) copyFileSync(f.source, f.dest)
  }

  const pty = ptySpawn(executable, args, {
    name: baseEnv.TERM!,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.cwd ?? process.cwd(),
    env: baseEnv as Record<string, string>,
  })
  return { pty, executable, args, nonce, injection }
}

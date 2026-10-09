import { isMac } from './ui/dom'

export interface Command {
  id: string
  title: string
  category?: string
  /** e.g. "Ctrl+Shift+P" (Ctrl means ⌘ on macOS). */
  keybinding?: string
  /** Also handle the keybinding while typing in inputs (e.g. Save, Quick Open). */
  global?: boolean
  run: () => unknown
  enabled?: () => boolean
  /** Hidden commands still work by keybinding/id but are not listed in the palette. */
  hidden?: boolean
}

const CODE_NAMES: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  NumpadAdd: '=',
  NumpadSubtract: '-',
}

/** Turns a keyboard event into the same "Ctrl+Shift+K" form commands use. */
export function keybindingOf(event: KeyboardEvent): string | null {
  const { code } = event
  let key: string
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^F\d{1,2}$/.test(code)) key = code
  else if (CODE_NAMES[code]) key = CODE_NAMES[code]
  else if (['Enter', 'Escape', 'Tab', 'Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) key = code
  else return null
  const ctrl = isMac ? event.metaKey : event.ctrlKey
  return [ctrl && 'Ctrl', event.shiftKey && 'Shift', event.altKey && 'Alt', key].filter(Boolean).join('+')
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()

  register(...commands: Command[]): void {
    for (const command of commands) this.commands.set(command.id, command)
  }

  get(id: string): Command | undefined {
    return this.commands.get(id)
  }

  all(): Command[] {
    return [...this.commands.values()]
  }

  run(id: string): void {
    const command = this.commands.get(id)
    if (command && (command.enabled?.() ?? true)) void command.run()
  }

  /** Runs the command bound to this key event. Returns true when one was found. */
  handleKeydown(event: KeyboardEvent): boolean {
    const binding = keybindingOf(event)
    if (!binding) return false
    const target = event.target as HTMLElement | null
    const inTextField =
      !!target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') &&
      !target.closest('.monaco-editor') // Monaco's hidden textarea counts as the editor
    for (const command of this.commands.values()) {
      if (command.keybinding !== binding) continue
      if (inTextField && !command.global) continue
      if (!(command.enabled?.() ?? true)) continue
      event.preventDefault()
      event.stopPropagation()
      void command.run()
      return true
    }
    return false
  }
}

import type { ConsoleLevel } from '@some/runtime-core/runner/protocol'
import { h } from './dom'

const MAX_LINES = 5000

/**
 * Matches "/src/main.ts:12:5" (JS stack frames, syntax errors) and
 * 'File "/hello.py", line 3' (Python tracebacks) so they can become links.
 */
const LOCATION = /(\/[\w.\-/@]*?\.[\w]+):(\d+)(?::(\d+))?|File "(\/[^"]+)", line (\d+)/g

export interface ConsoleViewOptions {
  exists: (path: string) => boolean
  onOpenLocation: (path: string, line: number, column: number) => void
}

/** Output of programs run from the IDE, with clickable file locations. */
export class ConsoleView {
  readonly element: HTMLElement
  private readonly output: HTMLElement
  private stickToBottom = true
  private count = 0

  constructor(private readonly options: ConsoleViewOptions) {
    this.output = h('div', {
      class: 'console-output',
      attrs: { role: 'log', 'aria-live': 'polite', tabindex: '0' },
      onscroll: () => {
        const el = this.output
        this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      },
    })
    this.element = h('div', { class: 'console' }, this.output)
    this.showPlaceholder()
  }

  append(level: ConsoleLevel, text: string, indent = 0): void {
    this.output.querySelector('.console-placeholder')?.remove()
    const line = h('div', { class: `console-line level-${level}`, style: indent ? { paddingLeft: `${indent * 16 + 12}px` } : undefined })
    line.append(this.linkify(text))
    this.output.append(line)
    if (++this.count > MAX_LINES) {
      this.output.firstElementChild?.remove()
      this.count--
    }
    if (this.stickToBottom) this.output.scrollTop = this.output.scrollHeight
  }

  clear(): void {
    this.output.replaceChildren()
    this.count = 0
    this.stickToBottom = true
  }

  /** Text of every line, used by tests and "Copy Output". */
  text(): string {
    return [...this.output.querySelectorAll('.console-line')].map((l) => l.textContent).join('\n')
  }

  private showPlaceholder(): void {
    this.output.append(
      h('div', { class: 'console-placeholder' }, 'Run a file with F5 (or the ▶ button) to see its output here.'),
    )
  }

  private linkify(text: string): DocumentFragment {
    const fragment = document.createDocumentFragment()
    let last = 0
    for (const m of text.matchAll(LOCATION)) {
      const path = m[1] ?? m[4]
      const line = Number(m[2] ?? m[5])
      const column = Number(m[3] ?? 1)
      if (!this.options.exists(path)) continue
      fragment.append(text.slice(last, m.index))
      fragment.append(
        h(
          'a',
          {
            class: 'console-link',
            attrs: { href: '#', title: 'Open in editor' },
            onclick: (e: MouseEvent) => {
              e.preventDefault()
              this.options.onOpenLocation(path, line, column)
            },
          },
          m[0],
        ),
      )
      last = m.index + m[0].length
    }
    fragment.append(text.slice(last))
    return fragment
  }
}

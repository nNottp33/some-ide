type Child = Node | string | number | null | undefined | false
type Props = {
  class?: string
  title?: string
  style?: Partial<CSSStyleDeclaration>
  dataset?: Record<string, string>
  attrs?: Record<string, string | boolean>
} & { [K in `on${string}`]?: (event: never) => void }

/** Tiny hyperscript helper: h('button', { class: 'x', onclick: fn }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue
    if (key === 'class') el.className = value as string
    else if (key === 'title') el.title = value as string
    else if (key === 'style') Object.assign(el.style, value)
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else if (key === 'attrs') {
      for (const [name, v] of Object.entries(value as Record<string, string | boolean>)) {
        if (v === false) continue
        el.setAttribute(name, v === true ? '' : v)
      }
    } else if (key.startsWith('on')) {
      el.addEventListener(key.slice(2), value as EventListener)
    }
  }
  append(el, children)
  return el
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
}

/** Codicon (VS Code's icon font, bundled with Monaco). */
export function icon(name: string, extraClass = ''): HTMLSpanElement {
  return h('span', { class: `codicon codicon-${name} ${extraClass}`.trim(), attrs: { 'aria-hidden': 'true' } })
}

export function iconButton(name: string, title: string, onclick: (event: MouseEvent) => void, extraClass = ''): HTMLButtonElement {
  return h(
    'button',
    { class: `icon-button ${extraClass}`.trim(), title, attrs: { type: 'button', 'aria-label': title }, onclick },
    icon(name),
  )
}

/** Renders `text` with the characters at `positions` wrapped in <mark>. */
export function highlighted(text: string, positions: number[], offset = 0): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const set = new Set(positions.map((p) => p - offset).filter((p) => p >= 0 && p < text.length))
  let run = ''
  let marked = false
  const flush = () => {
    if (!run) return
    fragment.append(marked ? h('mark', {}, run) : document.createTextNode(run))
    run = ''
  }
  for (let i = 0; i < text.length; i++) {
    const isMarked = set.has(i)
    if (isMarked !== marked) {
      flush()
      marked = isMarked
    }
    run += text[i]
  }
  flush()
  return fragment
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** "Ctrl+Shift+P" → "⇧⌘P" on macOS, unchanged elsewhere. */
export function formatKeybinding(binding: string): string {
  if (!isMac) return binding
  return binding
    .replace(/Ctrl\+/g, '⌘')
    .replace(/Shift\+/g, '⇧')
    .replace(/Alt\+/g, '⌥')
}

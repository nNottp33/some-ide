import { formatKeybinding, h, highlighted } from './dom'

export interface QuickItem {
  label: string
  labelHighlights?: number[]
  description?: string
  descriptionHighlights?: number[]
  /** Offset of `description` inside the string the highlights were computed against. */
  descriptionOffset?: number
  icon?: () => Node
  keybinding?: string
  run: () => void
}

export interface QuickProvider {
  /** Typed prefix that activates this provider ('' for the default one). */
  prefix: string
  placeholder: string
  items(query: string): QuickItem[] | string
}

const MAX_ITEMS = 200

/** VS Code style quick input: Ctrl+P files, ">" commands, ":" go to line. */
export class QuickInput {
  private readonly overlay: HTMLElement
  private readonly input: HTMLInputElement
  private readonly list: HTMLElement
  private items: QuickItem[] = []
  private selected = 0
  private restoreFocus: (() => void) | null = null

  constructor(private readonly providers: QuickProvider[]) {
    this.input = h('input', {
      class: 'quick-input-box',
      attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Quick open', role: 'combobox' },
      oninput: () => this.update(),
      onkeydown: (e: KeyboardEvent) => this.onKeydown(e),
    })
    this.list = h('div', { class: 'quick-input-list', attrs: { role: 'listbox' } })
    const widget = h('div', { class: 'quick-input' }, this.input, this.list)
    this.overlay = h(
      'div',
      { class: 'quick-input-overlay', onmousedown: (e: MouseEvent) => e.target === this.overlay && this.hide() },
      widget,
    )
  }

  get visible(): boolean {
    return this.overlay.isConnected
  }

  show(value = '', restoreFocus?: () => void): void {
    this.restoreFocus = restoreFocus ?? null
    if (!this.visible) document.body.append(this.overlay)
    this.input.value = value
    this.input.focus()
    this.input.setSelectionRange(value.length, value.length)
    this.update()
  }

  hide(refocus = true): void {
    if (!this.visible) return
    this.overlay.remove()
    if (refocus) this.restoreFocus?.()
  }

  private provider(): QuickProvider {
    const value = this.input.value
    return (
      this.providers
        .filter((p) => value.startsWith(p.prefix))
        .sort((a, b) => b.prefix.length - a.prefix.length)[0] ?? this.providers[0]
    )
  }

  private update(): void {
    const provider = this.provider()
    this.input.placeholder = provider.placeholder
    const result = provider.items(this.input.value.slice(provider.prefix.length))
    this.list.replaceChildren()
    if (typeof result === 'string') {
      this.items = []
      this.list.append(h('div', { class: 'quick-input-message' }, result))
      return
    }
    this.items = result.slice(0, MAX_ITEMS)
    this.selected = 0
    if (!this.items.length) {
      this.list.append(h('div', { class: 'quick-input-message' }, 'No matching results'))
      return
    }
    this.items.forEach((item, index) => {
      const row = h(
        'div',
        {
          class: 'quick-input-item',
          attrs: { role: 'option' },
          onmousedown: (e: MouseEvent) => e.preventDefault(),
          onclick: () => this.accept(index),
          onmousemove: () => this.select(index, false),
        },
        item.icon ? h('span', { class: 'quick-input-icon' }, item.icon()) : null,
        h('span', { class: 'quick-input-label' }, highlighted(item.label, item.labelHighlights ?? [])),
        item.description
          ? h(
              'span',
              { class: 'quick-input-description' },
              highlighted(item.description, item.descriptionHighlights ?? [], item.descriptionOffset ?? 0),
            )
          : null,
        item.keybinding ? h('kbd', { class: 'quick-input-keybinding' }, formatKeybinding(item.keybinding)) : null,
      )
      this.list.append(row)
    })
    this.select(0)
  }

  private select(index: number, scroll = true): void {
    const rows = this.list.querySelectorAll<HTMLElement>('.quick-input-item')
    if (!rows.length) return
    this.selected = (index + rows.length) % rows.length
    rows.forEach((row, i) => {
      row.classList.toggle('selected', i === this.selected)
      row.setAttribute('aria-selected', String(i === this.selected))
    })
    if (scroll) rows[this.selected].scrollIntoView({ block: 'nearest' })
  }

  private accept(index = this.selected): void {
    const item = this.items[index]
    if (!item) return
    this.hide(false)
    item.run()
  }

  private onKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        this.select(this.selected + 1)
        break
      case 'ArrowUp':
        this.select(this.selected - 1)
        break
      case 'PageDown':
        this.select(Math.min(this.items.length - 1, this.selected + 10))
        break
      case 'PageUp':
        this.select(Math.max(0, this.selected - 10))
        break
      case 'Enter':
        this.accept()
        break
      case 'Escape':
        this.hide()
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }
}

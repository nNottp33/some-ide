import { formatKeybinding, h, icon } from './dom'

export interface DialogButton {
  id: string
  label: string
  primary?: boolean
  danger?: boolean
}

/** Modal dialog. Resolves with the id of the clicked button (`cancelId` on Escape). */
export function showDialog(options: {
  title: string
  message?: string
  buttons: DialogButton[]
  cancelId: string
}): Promise<string> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null
    const close = (id: string) => {
      overlay.remove()
      previousFocus?.focus?.()
      resolve(id)
    }
    const buttons = options.buttons.map((b) =>
      h(
        'button',
        {
          class: `button ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
          attrs: { type: 'button' },
          onclick: () => close(b.id),
        },
        b.label,
      ),
    )
    const dialog = h(
      'div',
      { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title } },
      h('div', { class: 'dialog-title' }, options.title),
      options.message ? h('div', { class: 'dialog-message' }, options.message) : null,
      h('div', { class: 'dialog-buttons' }, ...buttons),
    )
    const overlay = h(
      'div',
      {
        class: 'overlay',
        onmousedown: (e: MouseEvent) => e.target === overlay && close(options.cancelId),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            close(options.cancelId)
          }
        },
      },
      dialog,
    )
    document.body.append(overlay)
    ;(buttons.find((_, i) => options.buttons[i].primary) ?? buttons[0])?.focus()
  })
}

export async function confirmDialog(title: string, message: string, confirmLabel = 'OK', danger = false): Promise<boolean> {
  const id = await showDialog({
    title,
    message,
    cancelId: 'cancel',
    buttons: [
      { id: 'ok', label: confirmLabel, primary: !danger, danger },
      { id: 'cancel', label: 'Cancel' },
    ],
  })
  return id === 'ok'
}

export type MenuItem =
  | { label: string; icon?: string; keybinding?: string; checked?: boolean; disabled?: boolean; run: () => void }
  | 'separator'

let openMenu: HTMLElement | null = null

export function closeContextMenu(): void {
  openMenu?.remove()
  openMenu = null
}

/** Shows a context menu at the pointer (or below an anchor element). */
export function showContextMenu(at: MouseEvent | HTMLElement, items: MenuItem[]): void {
  closeContextMenu()
  const buttons: HTMLButtonElement[] = []
  const menu = h(
    'div',
    { class: 'context-menu', attrs: { role: 'menu' } },
    ...items.map((item) => {
      if (item === 'separator') return h('div', { class: 'menu-separator', attrs: { role: 'separator' } })
      const button = h(
        'button',
        {
          class: 'menu-item',
          attrs: { type: 'button', role: 'menuitem', disabled: !!item.disabled },
          onclick: () => {
            closeContextMenu()
            item.run()
          },
        },
        h('span', { class: 'menu-icon' }, item.checked ? icon('check') : item.icon ? icon(item.icon) : null),
        h('span', { class: 'menu-label' }, item.label),
        item.keybinding ? h('span', { class: 'menu-keybinding' }, formatKeybinding(item.keybinding)) : null,
      )
      buttons.push(button)
      return button
    }),
  )
  menu.addEventListener('keydown', (e) => {
    const enabled = buttons.filter((b) => !b.disabled)
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') enabled[(index + 1) % enabled.length]?.focus()
    else if (e.key === 'ArrowUp') enabled[(index - 1 + enabled.length) % enabled.length]?.focus()
    else if (e.key === 'Escape') closeContextMenu()
    else return
    e.preventDefault()
    e.stopPropagation()
  })
  document.body.append(menu)
  openMenu = menu

  const rect = menu.getBoundingClientRect()
  let x: number
  let y: number
  if (at instanceof HTMLElement) {
    const anchor = at.getBoundingClientRect()
    x = anchor.left
    y = anchor.bottom + 2
  } else {
    x = at.clientX
    y = at.clientY
  }
  x = Math.max(4, Math.min(x, innerWidth - rect.width - 4))
  y = Math.max(4, y + rect.height > innerHeight - 4 ? y - rect.height : y)
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  buttons.find((b) => !b.disabled)?.focus({ preventScroll: true })
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeContextMenu()
})
window.addEventListener('blur', closeContextMenu)
window.addEventListener('resize', closeContextMenu)

export type ToastLevel = 'info' | 'warning' | 'error'

let toastHost: HTMLElement | null = null

/** Small notification in the bottom-right corner. */
export function notify(message: string, level: ToastLevel = 'info', timeout = 4000): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', attrs: { 'aria-live': 'polite' } })
    document.body.append(toastHost)
  }
  const glyph = level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info'
  const toast = h('div', { class: `toast toast-${level}`, attrs: { role: level === 'error' ? 'alert' : 'status' } }, icon(glyph), h('span', {}, message))
  const remove = () => toast.remove()
  toast.addEventListener('click', remove)
  toastHost.append(toast)
  setTimeout(remove, timeout)
}

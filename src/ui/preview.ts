import { Emitter } from '../core/emitter'
import type { VirtualFS } from '../core/vfs'
import { buildPreview } from '../runner/html'
import type { ConsoleLevel, PreviewMessage } from '../runner/protocol'
import { h, iconButton } from './dom'

const PREVIEW_SANDBOX = 'allow-scripts allow-modals allow-forms allow-popups allow-pointer-lock allow-downloads'

const CONSOLE_LEVELS: ReadonlySet<string> = new Set<ConsoleLevel>(['log', 'info', 'warn', 'error', 'debug'])

/** Shortcuts the preview may forward: navigation and layout only, nothing that saves or runs. */
const FORWARDED_KEYS = new Set(
  ['Ctrl', 'Meta'].flatMap((mod) => [
    `${mod}+KeyP`,
    `${mod}+Shift+KeyP`,
    `${mod}+Shift+KeyF`,
    `${mod}+Shift+KeyE`,
    `${mod}+KeyB`,
    `${mod}+KeyJ`,
    `${mod}+Backquote`,
  ]).concat(['F1']),
)

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface PreviewOptions {
  fs: VirtualFS
  onConsole: (level: ConsoleLevel, text: string) => void
  /** A key pressed inside the preview, forwarded so IDE shortcuts keep working. */
  onKeydown: (event: KeyboardEvent) => void
  onClose: () => void
}

/** Live preview of an HTML page in a sandboxed iframe; reloads when project files are saved. */
export class PreviewPane {
  readonly element: HTMLElement
  readonly onDidChangeEntry = new Emitter<string | null>()
  private readonly frameHost: HTMLElement
  private readonly title: HTMLElement
  private frame: HTMLIFrameElement | null = null
  private entry: string | null = null
  private lastHtml = ''
  private reloadTimer: ReturnType<typeof setTimeout> | undefined
  private building = 0

  constructor(private readonly options: PreviewOptions) {
    this.title = h('span', { class: 'preview-title' })
    this.frameHost = h('div', { class: 'preview-frame-host' })
    this.element = h(
      'section',
      { class: 'preview', attrs: { 'aria-label': 'Preview' } },
      h(
        'div',
        { class: 'preview-toolbar' },
        h('span', { class: 'codicon codicon-globe' }),
        this.title,
        iconButton('refresh', 'Reload Preview', () => void this.reload()),
        iconButton('link-external', 'Open in New Window', () => this.openExternal()),
        iconButton('close', 'Close Preview', () => options.onClose()),
      ),
      this.frameHost,
    )

    options.fs.onDidChange.on(() => {
      if (!this.entry) return
      clearTimeout(this.reloadTimer)
      this.reloadTimer = setTimeout(() => void this.reload(false), 300)
    })

    // Messages come from untrusted page code: check every field, and only forward key
    // presses that cannot change the project (no Save, no Run: a page could fake them in a loop).
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (!this.frame || event.source !== this.frame.contentWindow) return
      const data = event.data as Partial<PreviewMessage & { type: string; path: string } & KeyboardEventInit> | null
      if (!data || typeof data !== 'object' || data.source !== 'some-ide-preview') return
      if (data.type === 'navigate') {
        if (typeof data.path === 'string' && options.fs.isFile(data.path)) void this.show(data.path)
      } else if (data.type === 'keydown') {
        if (document.activeElement !== this.frame || typeof data.code !== 'string') return
        const binding = [data.ctrlKey && 'Ctrl', data.metaKey && 'Meta', data.shiftKey && 'Shift', data.altKey && 'Alt', data.code]
          .filter(Boolean)
          .join('+')
        if (!FORWARDED_KEYS.has(binding)) return
        const { code, key, ctrlKey, metaKey, shiftKey, altKey } = data
        this.options.onKeydown(new KeyboardEvent('keydown', { code, key: String(key ?? ''), ctrlKey: !!ctrlKey, metaKey: !!metaKey, shiftKey: !!shiftKey, altKey: !!altKey }))
      } else if (typeof data.level === 'string' && CONSOLE_LEVELS.has(data.level) && typeof data.text === 'string') {
        this.options.onConsole(data.level, data.text.slice(0, 100_000))
      }
    })
  }

  get currentEntry(): string | null {
    return this.entry
  }

  async show(entry: string): Promise<void> {
    this.entry = entry
    this.title.textContent = entry
    this.title.title = entry
    this.onDidChangeEntry.emit(entry)
    await this.reload(true)
  }

  hide(): void {
    this.entry = null
    clearTimeout(this.reloadTimer)
    this.frame?.remove()
    this.frame = null
    this.lastHtml = ''
    this.onDidChangeEntry.emit(null)
  }

  async reload(force = true): Promise<void> {
    const entry = this.entry
    if (!entry) return
    if (!this.options.fs.isFile(entry)) {
      this.hide()
      return
    }
    const build = ++this.building
    let html: string
    try {
      const result = await buildPreview(new Map(this.options.fs.entries()), entry)
      result.warnings.forEach((w) => this.options.onConsole('warn', w))
      html = result.html
    } catch (err) {
      this.options.onConsole('error', (err as Error).message)
      return
    }
    if (build !== this.building || this.entry !== entry) return
    if (!force && html === this.lastHtml) return
    this.lastHtml = html

    // A fresh iframe each time resets all page state (timers, globals, listeners).
    const frame = h('iframe', {
      class: 'preview-frame',
      title: `Preview of ${entry}`,
      attrs: { sandbox: PREVIEW_SANDBOX, allow: 'clipboard-write' },
    })
    frame.srcdoc = html
    this.frame?.remove()
    this.frame = frame
    this.frameHost.append(frame)
  }

  /**
   * Opens the preview in a new window. The page is wrapped in a sandboxed iframe there too:
   * a bare blob: URL would run the project's scripts on the IDE's own origin, with access
   * to every stored project.
   */
  private openExternal(): void {
    if (!this.lastHtml || !this.entry) return
    const title = `Preview of ${this.entry}`
    const wrapper =
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      `<title>${escapeHtml(title)}</title>` +
      '<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style>' +
      '</head><body>' +
      `<iframe sandbox="${PREVIEW_SANDBOX}" title="${escapeHtml(title)}" srcdoc="${escapeHtml(this.lastHtml)}"></iframe>` +
      '</body></html>'
    const url = URL.createObjectURL(new Blob([wrapper], { type: 'text/html' }))
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

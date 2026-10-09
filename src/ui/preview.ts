import { Emitter } from '../core/emitter'
import type { VirtualFS } from '../core/vfs'
import { buildPreview } from '../runner/html'
import type { ConsoleLevel, PreviewMessage } from '../runner/protocol'
import { h, iconButton } from './dom'

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

    window.addEventListener('message', (event: MessageEvent<PreviewMessage & { type?: string; path?: string } & KeyboardEventInit>) => {
      if (!this.frame || event.source !== this.frame.contentWindow) return
      const data = event.data
      if (data?.source !== 'some-ide-preview') return
      if (data.type === 'navigate' && data.path) void this.show(data.path)
      else if (data.type === 'keydown') this.options.onKeydown(new KeyboardEvent('keydown', data))
      else if (data.level) this.options.onConsole(data.level, data.text)
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
      attrs: {
        sandbox: 'allow-scripts allow-modals allow-forms allow-popups allow-pointer-lock allow-downloads',
        allow: 'clipboard-write',
      },
    })
    frame.srcdoc = html
    this.frame?.remove()
    this.frame = frame
    this.frameHost.append(frame)
  }

  private openExternal(): void {
    if (!this.lastHtml) return
    const url = URL.createObjectURL(new Blob([this.lastHtml], { type: 'text/html' }))
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

import { Emitter } from '../core/emitter'
import { languageForPath } from '../core/languages'
import { basename, dirname } from '../core/path'
import type { Settings, SettingsStore } from '../core/settings'
import { showContextMenu, showDialog } from '../ui/dialogs'
import { formatKeybinding, h, icon } from '../ui/dom'
import { fileIcon } from '../ui/file-icon'
import type { DocumentManager } from './documents'
import { MONACO_THEMES, monaco } from './monaco'

export interface OpenOptions {
  line?: number
  column?: number
  /** Selects this many characters from line/column (used by search results). */
  length?: number
  focus?: boolean
}

export interface EditorAreaOptions {
  docs: DocumentManager
  settings: SettingsStore
  /** Buttons shown at the right end of the tab bar (Run, Preview…). */
  actions: HTMLElement
  welcome: HTMLElement
  onRevealInExplorer: (path: string) => void
}

/** Tab bar + breadcrumbs + a single Monaco editor that swaps models between tabs. */
export class EditorArea {
  readonly element: HTMLElement
  readonly editor: monaco.editor.IStandaloneCodeEditor
  readonly onDidChangeActive = new Emitter<string | null>()
  readonly onDidChangeTabs = new Emitter<string[]>()

  private tabs: string[] = []
  private active: string | null = null
  private readonly viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>()
  private readonly tabBar: HTMLElement
  private readonly breadcrumbs: HTMLElement
  private readonly editorHost: HTMLElement
  private readonly docs: DocumentManager

  constructor(private readonly options: EditorAreaOptions) {
    const { docs, settings } = options
    this.docs = docs
    this.tabBar = h('div', { class: 'tabs', attrs: { role: 'tablist' }, onwheel: (e: WheelEvent) => this.onWheel(e) })
    this.breadcrumbs = h('div', { class: 'breadcrumbs' })
    this.editorHost = h('div', { class: 'editor-host' })
    this.element = h(
      'section',
      { class: 'editor-group' },
      h('div', { class: 'tab-strip' }, this.tabBar, h('div', { class: 'editor-actions' }, options.actions)),
      this.breadcrumbs,
      h('div', { class: 'editor-body' }, this.editorHost, options.welcome),
    )

    this.editor = monaco.editor.create(this.editorHost, {
      model: null,
      automaticLayout: true,
      fixedOverflowWidgets: true,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      stickyScroll: { enabled: true },
      renderWhitespace: 'selection',
      scrollBeyondLastLine: false,
      padding: { top: 6 },
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Menlo, Consolas, 'Liberation Mono', monospace",
      fontLigatures: true,
      ...this.editorOptions(settings.get()),
    })
    monaco.editor.setTheme(MONACO_THEMES[settings.get().theme])
    docs.setTabSize(settings.get().tabSize)
    settings.onDidChange.on((s) => {
      this.editor.updateOptions(this.editorOptions(s))
      monaco.editor.setTheme(MONACO_THEMES[s.theme])
      docs.setTabSize(s.tabSize)
    })

    docs.onDidChangeDirty.on(({ path }) => {
      if (this.tabs.includes(path)) this.renderTabs()
    })
    docs.onDidMove.on((moves) => {
      for (const { from, to } of moves) {
        const i = this.tabs.indexOf(from)
        if (i === -1) continue
        this.tabs[i] = to
        this.viewStates.set(to, this.viewStates.get(from) ?? null)
        this.viewStates.delete(from)
        if (this.active === from) {
          this.active = null
          this.activate(to)
        }
      }
      this.renderTabs()
      this.onDidChangeTabs.emit(this.tabs)
    })
    docs.onDidRemove.on((paths) => paths.forEach((p) => this.forceClose(p)))
    docs.onDidReset.on(() => {
      const previous = [...this.tabs]
      const active = this.active
      this.tabs = []
      this.active = null
      this.editor.setModel(null)
      for (const p of previous) if (docs.get(p)) this.tabs.push(p)
      this.activate(active && docs.get(active) ? active : (this.tabs[0] ?? null))
    })

    this.renderTabs()
    this.updateWelcome()
    // The strip narrows when the preview or sidebar opens; keep the active tab in view.
    new ResizeObserver(() => this.revealActiveTab()).observe(this.tabBar)
  }

  get activePath(): string | null {
    return this.active
  }

  get openPaths(): string[] {
    return [...this.tabs]
  }

  open(path: string, options: OpenOptions = {}): void {
    if (!this.docs.get(path)) return
    if (!this.tabs.includes(path)) {
      const at = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length
      this.tabs.splice(at, 0, path)
      this.onDidChangeTabs.emit(this.tabs)
    }
    this.activate(path)
    if (options.line) {
      const column = options.column ?? 1
      const end = column + (options.length ?? 0)
      const range = new monaco.Range(options.line, column, options.line, end)
      this.editor.setSelection(range)
      this.editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth)
    }
    if (options.focus !== false) this.editor.focus()
  }

  /** Closes a tab, asking what to do with unsaved changes. Resolves false if cancelled. */
  async close(path: string): Promise<boolean> {
    if (!this.tabs.includes(path)) return true
    if (this.docs.isDirty(path)) {
      this.activate(path)
      const choice = await showDialog({
        title: `Save changes to ${basename(path)}?`,
        message: "Your changes will be lost if you don't save them.",
        cancelId: 'cancel',
        buttons: [
          { id: 'save', label: 'Save', primary: true },
          { id: 'discard', label: "Don't Save" },
          { id: 'cancel', label: 'Cancel' },
        ],
      })
      if (choice === 'cancel') return false
      if (choice === 'save') this.docs.save(path)
      else this.docs.revert(path)
    }
    this.forceClose(path)
    return true
  }

  async closeAll(except?: string): Promise<void> {
    for (const path of [...this.tabs]) {
      if (path === except) continue
      if (!(await this.close(path))) return
    }
  }

  async closeSaved(): Promise<void> {
    for (const path of [...this.tabs]) if (!this.docs.isDirty(path)) this.forceClose(path)
  }

  cycle(delta: number): void {
    if (!this.tabs.length) return
    const i = this.active ? this.tabs.indexOf(this.active) : 0
    this.open(this.tabs[(i + delta + this.tabs.length) % this.tabs.length])
  }

  /** Restores tabs from a previous session (missing files are skipped). */
  restore(paths: string[], active: string | null): void {
    this.tabs = paths.filter((p) => this.docs.get(p))
    this.renderTabs()
    const target = active && this.tabs.includes(active) ? active : (this.tabs[0] ?? null)
    if (target) this.activate(target)
    this.updateWelcome()
  }

  private forceClose(path: string): void {
    const index = this.tabs.indexOf(path)
    if (index === -1) return
    this.tabs.splice(index, 1)
    this.viewStates.delete(path)
    if (this.active === path) {
      this.active = null
      const next = this.tabs[Math.min(index, this.tabs.length - 1)] ?? null
      if (next) this.activate(next)
      else {
        this.editor.setModel(null)
        this.onDidChangeActive.emit(null)
      }
    }
    this.renderTabs()
    this.updateWelcome()
    this.onDidChangeTabs.emit(this.tabs)
  }

  private activate(path: string | null): void {
    if (path === this.active) {
      this.renderTabs()
      return
    }
    if (this.active && this.docs.get(this.active)) this.viewStates.set(this.active, this.editor.saveViewState())
    this.active = path
    const doc = path ? this.docs.get(path) : undefined
    this.editor.setModel(doc?.model ?? null)
    if (path) {
      const state = this.viewStates.get(path)
      if (state) this.editor.restoreViewState(state)
    }
    this.renderTabs()
    this.updateWelcome()
    this.onDidChangeActive.emit(path)
  }

  private editorOptions(s: Settings): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
    return {
      fontSize: s.fontSize,
      tabSize: s.tabSize,
      insertSpaces: true,
      detectIndentation: false,
      wordWrap: s.wordWrap ? 'on' : 'off',
      minimap: { enabled: s.minimap && innerWidth > 720 },
    }
  }

  private updateWelcome(): void {
    const empty = this.tabs.length === 0
    this.options.welcome.hidden = !empty
    this.editorHost.hidden = empty
    this.breadcrumbs.hidden = empty
  }

  private renderTabs(): void {
    const names = new Map<string, number>()
    for (const p of this.tabs) names.set(basename(p), (names.get(basename(p)) ?? 0) + 1)

    this.tabBar.replaceChildren(
      ...this.tabs.map((path) => {
        const dirty = this.docs.isDirty(path)
        const active = path === this.active
        const duplicate = (names.get(basename(path)) ?? 0) > 1
        const closeButton = h(
          'button',
          {
            class: 'tab-close',
            title: `Close (${formatKeybinding('Alt+W')})`,
            attrs: { type: 'button', 'aria-label': `Close ${basename(path)}` },
            onclick: (e: MouseEvent) => {
              e.stopPropagation()
              void this.close(path)
            },
          },
          icon('close'),
        )
        const tab = h(
          'div',
          {
            class: `tab ${active ? 'active' : ''} ${dirty ? 'dirty' : ''}`,
            title: path,
            dataset: { path },
            attrs: { role: 'tab', 'aria-selected': String(active), tabindex: active ? '0' : '-1' },
            onclick: () => this.open(path),
            onauxclick: (e: MouseEvent) => {
              if (e.button === 1) {
                e.preventDefault()
                void this.close(path)
              }
            },
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault()
              showContextMenu(e, [
                { label: 'Close', keybinding: 'Alt+W', run: () => void this.close(path) },
                { label: 'Close Others', run: () => void this.closeAll(path) },
                { label: 'Close Saved', run: () => void this.closeSaved() },
                { label: 'Close All', run: () => void this.closeAll() },
                'separator',
                { label: 'Copy Path', icon: 'copy', run: () => void navigator.clipboard?.writeText(path) },
                { label: 'Reveal in Explorer', icon: 'list-tree', run: () => this.options.onRevealInExplorer(path) },
              ])
            },
          },
          fileIcon(path),
          h('span', { class: 'tab-label' }, basename(path)),
          duplicate ? h('span', { class: 'tab-description' }, dirname(path).slice(1) || '/') : null,
          closeButton,
        )
        return tab
      }),
    )
    this.revealActiveTab()
    this.renderBreadcrumbs()
  }

  /** Scrolls the tab strip (only) so the active tab is fully visible. */
  private revealActiveTab(): void {
    const tab = this.tabBar.querySelector<HTMLElement>('.tab.active')
    if (!tab) return
    const bar = this.tabBar
    if (tab.offsetLeft < bar.scrollLeft) bar.scrollLeft = tab.offsetLeft
    else if (tab.offsetLeft + tab.offsetWidth > bar.scrollLeft + bar.clientWidth) {
      bar.scrollLeft = tab.offsetLeft + tab.offsetWidth - bar.clientWidth
    }
  }

  private renderBreadcrumbs(): void {
    if (!this.active) {
      this.breadcrumbs.replaceChildren()
      return
    }
    const parts = this.active.split('/').filter(Boolean)
    const crumbs: Node[] = []
    parts.forEach((part, i) => {
      if (i > 0) crumbs.push(icon('chevron-right', 'crumb-separator'))
      const isFile = i === parts.length - 1
      crumbs.push(
        h(
          'button',
          {
            class: 'crumb',
            attrs: { type: 'button' },
            onclick: () => this.options.onRevealInExplorer('/' + parts.slice(0, i + 1).join('/')),
          },
          isFile ? fileIcon(this.active!) : null,
          part,
        ),
      )
    })
    crumbs.push(h('span', { class: 'crumb-language' }, languageForPath(this.active).label))
    this.breadcrumbs.replaceChildren(...crumbs)
  }

  private onWheel(e: WheelEvent): void {
    // Let a vertical mouse wheel scroll the tab strip horizontally.
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      this.tabBar.scrollLeft += e.deltaY
      e.preventDefault()
    }
  }
}

import { CommandRegistry, type Command } from './commands'
import { debounce } from '@some/runtime-core/core/emitter'
import { fuzzyFilter } from '@some/runtime-core/core/fuzzy'
import { languageForPath, runtimeForPath } from '@some/runtime-core/core/languages'
import { basename, dirname } from '@some/runtime-core/core/path'
import { loadWorkbenchState, saveWorkbenchState, SettingsStore, type WorkbenchState } from './core/settings'
import { openStore, type KeyValueStore } from './core/storage'
import { VirtualFS, type ProjectSnapshot } from '@some/runtime-core/core/vfs'
import { exportZip } from '@some/runtime-core/core/zip'
import { DocumentManager } from './editor/documents'
import { EditorArea } from './editor/editor-area'
import { configureMonaco } from './editor/monaco'
import { Runner, type RunEvent } from '@some/runtime-core/runner/runner'
import { sampleProject } from './sample-project'
import { ConsoleView } from './ui/console-view'
import { confirmDialog, notify, showContextMenu, type MenuItem } from './ui/dialogs'
import { formatKeybinding, h, icon, iconButton } from './ui/dom'
import { Explorer } from './ui/explorer'
import { fileIcon } from './ui/file-icon'
import { PreviewPane } from './ui/preview'
import { ProblemsView } from './ui/problems-view'
import { QuickInput, type QuickItem } from './ui/quick-input'
import { SearchView } from './ui/search-view'
import { downloadBlob, pickFiles, readUploads } from './ui/transfer'

const PROJECT_KEY = 'project:default'
const BUFFERS_KEY = 'buffers:default'
const NARROW = 720

type PanelView = 'console' | 'problems'

export class Workbench {
  private readonly settings = new SettingsStore()
  private readonly state: WorkbenchState = loadWorkbenchState()
  private readonly commands = new CommandRegistry()
  private readonly runner = new Runner()
  private readonly saveState = debounce(() => saveWorkbenchState(this.state), 300)

  private editors!: EditorArea
  private explorer!: Explorer
  private searchView!: SearchView
  private consoleView!: ConsoleView
  private problems!: ProblemsView
  private preview!: PreviewPane
  private quickInput!: QuickInput

  private root!: HTMLElement
  private sidebar!: HTMLElement
  private panel!: HTMLElement
  private panelView: PanelView = 'console'
  private stdinPane!: HTMLElement
  private runButton!: HTMLButtonElement
  private stopButton!: HTMLButtonElement
  private status: Record<string, HTMLElement> = {}

  private constructor(
    private readonly fs: VirtualFS,
    private readonly docs: DocumentManager,
    private readonly store: KeyValueStore,
    /** False when the saved project could not be read; nothing is written then, to protect it. */
    private readonly storageReadable: boolean,
  ) {}

  static async start(host: HTMLElement): Promise<Workbench> {
    configureMonaco()
    const store = await openStore()
    const fs = new VirtualFS()
    // A failed read must not look like a first run: writing the sample project over a
    // project that merely could not be read right now would destroy it.
    let saved: ProjectSnapshot | undefined
    let storageReadable = true
    try {
      saved = await store.get<ProjectSnapshot>(PROJECT_KEY)
    } catch {
      storageReadable = false
    }
    const firstRun = !saved && storageReadable
    fs.load(saved ?? sampleProject())
    if (firstRun) await store.set(PROJECT_KEY, fs.snapshot()).catch(() => {})
    const docs = new DocumentManager(fs)
    const buffers = storageReadable ? await store.get<Record<string, string>>(BUFFERS_KEY).catch(() => undefined) : undefined
    if (buffers) docs.restoreBuffers(buffers)

    const workbench = new Workbench(fs, docs, store, storageReadable)
    workbench.build(host)
    workbench.restore(firstRun)
    return workbench
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  private build(host: HTMLElement): void {
    const { fs, docs, settings, state } = this

    this.runButton = h(
      'button',
      { class: 'run-button', title: `Run File (${formatKeybinding('F5')})`, attrs: { type: 'button' }, onclick: () => this.run() },
      icon('play'),
      h('span', { class: 'run-label' }, 'Run'),
    )
    this.stopButton = iconButton('debug-stop', `Stop (${formatKeybinding('Shift+F5')})`, () => this.runner.stop(), 'stop-button')
    this.stopButton.hidden = true

    this.editors = new EditorArea({
      docs,
      settings,
      actions: h('div', { class: 'editor-action-group' }, this.stopButton, this.runButton),
      welcome: this.welcomePage(),
      onRevealInExplorer: (path) => this.revealInExplorer(path),
    })

    this.explorer = new Explorer({
      fs,
      docs,
      expanded: state.expanded,
      onOpen: (path, focus) => this.openFile(path, { focus }),
      onRun: (path) => this.run(path),
      onExpandedChange: (expanded) => this.updateState({ expanded }),
      onUpload: (dir, files) => void this.upload(dir, files),
      onMore: (anchor) => showContextMenu(anchor, this.projectMenu()),
      onDownloadFile: (path) => downloadBlob(basename(path), docs.read(path), 'text/plain'),
    })

    this.searchView = new SearchView({
      docs,
      onOpen: (path, line, column, length) => this.openFile(path, { line, column, length }),
    })

    this.consoleView = new ConsoleView({
      exists: (path) => fs.isFile(path),
      onOpenLocation: (path, line, column) => this.openFile(path, { line, column }),
    })
    this.problems = new ProblemsView(docs, (path, line, column) => this.openFile(path, { line, column }))
    this.preview = new PreviewPane({
      fs,
      onConsole: (level, text) => this.consoleView.append(level, text),
      onKeydown: (event) => this.commands.handleKeydown(event),
      onClose: () => this.closePreview(),
    })

    this.sidebar = h('aside', { class: 'sidebar', attrs: { 'aria-label': 'Side Bar' } }, this.explorer.element, this.searchView.element)
    this.panel = this.buildPanel()

    const activity = (view: 'explorer' | 'search', glyph: string, title: string) =>
      h(
        'button',
        {
          class: 'activity-item',
          dataset: { view },
          title,
          attrs: { type: 'button', 'aria-label': title },
          onclick: () => this.toggleSidebarView(view),
        },
        icon(glyph),
      )

    const editorRow = h(
      'div',
      { class: 'editor-row' },
      this.editors.element,
      this.sash('vertical', () => state.previewWidth, (w) => this.updateState({ previewWidth: w }), true, 420),
      this.preview.element,
    )

    this.root = h(
      'div',
      { class: 'workbench' },
      h(
        'header',
        { class: 'titlebar' },
        h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, '{ }'), h('span', { class: 'brand-name' }, 'some-ide')),
        h(
          'button',
          {
            class: 'command-center',
            attrs: { type: 'button' },
            title: 'Search files by name, or type > for commands',
            onclick: () => this.showQuickInput(''),
          },
          icon('search'),
          h('span', { class: 'command-center-label' }, 'Search files'),
          h('kbd', {}, formatKeybinding('Ctrl+P')),
        ),
        h(
          'div',
          { class: 'titlebar-actions' },
          iconButton('color-mode', 'Toggle Light/Dark Theme', () => this.commands.run('preferences.toggleTheme')),
          iconButton('layout-sidebar-left', `Toggle Sidebar (${formatKeybinding('Ctrl+B')})`, () => this.toggleSidebar()),
          iconButton('layout-panel', `Toggle Panel (${formatKeybinding('Ctrl+J')})`, () => this.togglePanel()),
        ),
      ),
      h(
        'div',
        { class: 'workbench-body' },
        h(
          'nav',
          { class: 'activitybar', attrs: { 'aria-label': 'Views' } },
          activity('explorer', 'files', `Explorer (${formatKeybinding('Ctrl+Shift+E')})`),
          activity('search', 'search', `Search (${formatKeybinding('Ctrl+Shift+F')})`),
          h('div', { class: 'activity-spacer' }),
          h(
            'button',
            {
              class: 'activity-item',
              title: 'Settings',
              attrs: { type: 'button', 'aria-label': 'Settings' },
              onclick: (e: MouseEvent) => showContextMenu(e.currentTarget as HTMLElement, this.settingsMenu()),
            },
            icon('settings-gear'),
          ),
        ),
        this.sidebar,
        this.sash('vertical', () => state.sidebarWidth, (w) => this.updateState({ sidebarWidth: w }), false, 260),
        h('div', { class: 'sidebar-backdrop', onclick: () => this.toggleSidebar(false) }),
        h(
          'main',
          { class: 'main' },
          editorRow,
          this.sash('horizontal', () => state.panelHeight, (v) => this.updateState({ panelHeight: v }), true, 220),
          this.panel,
        ),
      ),
      this.buildStatusbar(),
    )

    this.quickInput = new QuickInput([
      {
        prefix: '',
        placeholder: 'Search files by name (append : to go to a line, or start with > for commands)',
        items: (q) => this.fileItems(q),
      },
      { prefix: '>', placeholder: 'Type the name of a command to run', items: (q) => this.commandItems(q) },
      { prefix: ':', placeholder: 'Type a line number to go to', items: (q) => this.gotoLineItems(q) },
    ])

    host.replaceChildren(this.root)
    this.registerCommands()
    this.wireEvents()
    this.applyLayout()
    this.applyTheme()
  }

  private buildPanel(): HTMLElement {
    const stdin = h('textarea', {
      class: 'stdin-input',
      attrs: {
        spellcheck: 'false',
        placeholder: 'Program input — one line per input() / prompt() call',
        'aria-label': 'Program input',
      },
      oninput: () => this.updateState({ stdin: stdin.value }),
    })
    stdin.value = this.state.stdin
    this.stdinPane = h(
      'div',
      { class: 'stdin-pane' },
      h('div', { class: 'stdin-header' }, icon('keyboard'), 'Input'),
      stdin,
    )
    this.stdinPane.hidden = !this.state.stdin

    const tab = (view: PanelView, label: string) =>
      h(
        'button',
        { class: 'panel-tab', dataset: { view }, attrs: { type: 'button', role: 'tab' }, onclick: () => this.showPanel(view) },
        label,
        view === 'problems' ? h('span', { class: 'badge problems-badge', attrs: { hidden: true } }) : null,
      )

    return h(
      'section',
      { class: 'panel', attrs: { 'aria-label': 'Panel' } },
      h(
        'div',
        { class: 'panel-header' },
        h('div', { class: 'panel-tabs', attrs: { role: 'tablist' } }, tab('console', 'Console'), tab('problems', 'Problems')),
        h(
          'div',
          { class: 'panel-actions' },
          iconButton('keyboard', 'Toggle Program Input (stdin)', () => {
            this.stdinPane.hidden = !this.stdinPane.hidden
            if (!this.stdinPane.hidden) stdin.focus()
          }),
          iconButton('copy', 'Copy Output', () => void navigator.clipboard?.writeText(this.consoleView.text())),
          iconButton('clear-all', 'Clear Console', () => this.consoleView.clear()),
          iconButton('chevron-up', 'Maximize Panel', (e) => {
            this.root.classList.toggle('panel-maximized')
            const max = this.root.classList.contains('panel-maximized')
            ;(e.currentTarget as HTMLElement).replaceChildren(icon(max ? 'chevron-down' : 'chevron-up'))
          }),
          iconButton('close', 'Close Panel', () => this.togglePanel(false)),
        ),
      ),
      h(
        'div',
        { class: 'panel-body' },
        h('div', { class: 'panel-view', dataset: { view: 'console' } }, this.consoleView.element, this.stdinPane),
        h('div', { class: 'panel-view', dataset: { view: 'problems' } }, this.problems.element),
      ),
    )
  }

  private buildStatusbar(): HTMLElement {
    const item = (id: string, props: Parameters<typeof h>[1], ...children: Array<Node | string>) => {
      const el = h('button', { class: 'status-item', attrs: { type: 'button' }, ...props }, ...children)
      this.status[id] = el
      return el
    }
    return h(
      'footer',
      { class: 'statusbar' },
      h(
        'div',
        { class: 'status-left' },
        item('problems', { title: 'Problems', onclick: () => this.showPanel('problems') }),
        item('run', { title: 'Console', onclick: () => this.showPanel('console') }),
      ),
      h(
        'div',
        { class: 'status-right' },
        item('cursor', { title: 'Go to Line', onclick: () => this.showQuickInput(':') }),
        item('indent', {
          title: 'Select Indentation',
          onclick: (e: MouseEvent) =>
            showContextMenu(e.currentTarget as HTMLElement, [2, 4, 8].map((n) => ({
              label: `Spaces: ${n}`,
              checked: this.settings.get().tabSize === n,
              run: () => this.settings.update({ tabSize: n }),
            }))),
        }),
        item('encoding', { title: 'Encoding', class: 'status-item hide-narrow' }, 'UTF-8'),
        item('eol', { title: 'End of Line Sequence', class: 'status-item hide-narrow' }, 'LF'),
        item('language', { title: 'Language Mode' }),
        item('storage', { class: 'status-item hide-narrow', title: '' }),
      ),
    )
  }

  private welcomePage(): HTMLElement {
    const shortcut = (label: string, keys: string) =>
      h('div', { class: 'welcome-shortcut' }, h('span', {}, label), h('kbd', {}, formatKeybinding(keys)))
    return h(
      'div',
      { class: 'welcome' },
      h(
        'div',
        { class: 'welcome-inner' },
        h('div', { class: 'welcome-mark' }, '{ }'),
        h('h1', {}, 'some-ide'),
        h('p', { class: 'welcome-tagline' }, 'A code editor that runs entirely in your browser — TypeScript, JavaScript, Python and HTML.'),
        h(
          'div',
          { class: 'welcome-actions' },
          h('button', { class: 'button primary', attrs: { type: 'button' }, onclick: () => this.commands.run('file.newFile') }, icon('new-file'), 'New File'),
          h('button', { class: 'button', attrs: { type: 'button' }, onclick: () => this.showQuickInput('') }, icon('go-to-file'), 'Open File…'),
          h('button', { class: 'button', attrs: { type: 'button' }, onclick: () => void this.upload('/') }, icon('cloud-upload'), 'Upload…'),
        ),
        h(
          'div',
          { class: 'welcome-shortcuts' },
          shortcut('Go to File', 'Ctrl+P'),
          shortcut('Command Palette', 'Ctrl+Shift+P'),
          shortcut('Run File', 'F5'),
          shortcut('Search in Files', 'Ctrl+Shift+F'),
          shortcut('Toggle Panel', 'Ctrl+J'),
          shortcut('New File', 'Alt+N'),
        ),
      ),
    )
  }

  /** A drag handle that resizes a neighbouring area. `invert` when dragging toward it shrinks it. */
  private sash(
    direction: 'vertical' | 'horizontal',
    getSize: () => number,
    setSize: (size: number) => void,
    invert: boolean,
    defaultSize: number,
  ): HTMLElement {
    const el = h('div', {
      class: `sash sash-${direction}`,
      attrs: { role: 'separator', 'aria-orientation': direction === 'vertical' ? 'vertical' : 'horizontal' },
      ondblclick: () => {
        setSize(defaultSize)
        this.applyLayout()
      },
    })
    el.addEventListener('pointerdown', (start) => {
      if (start.button !== 0) return
      start.preventDefault()
      el.setPointerCapture(start.pointerId)
      const initial = getSize()
      const origin = direction === 'vertical' ? start.clientX : start.clientY
      el.classList.add('active')
      this.root.classList.add('resizing')
      const max = direction === 'vertical' ? innerWidth * 0.7 : innerHeight * 0.8
      const move = (e: PointerEvent) => {
        const delta = (direction === 'vertical' ? e.clientX : e.clientY) - origin
        setSize(Math.round(Math.min(max, Math.max(120, initial + (invert ? -delta : delta)))))
        this.applyLayout()
      }
      const end = () => {
        el.classList.remove('active')
        this.root.classList.remove('resizing')
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', end)
        el.removeEventListener('pointercancel', end)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', end)
      el.addEventListener('pointercancel', end)
    })
    return el
  }

  private applyLayout(): void {
    const { state } = this
    const style = this.root.style
    style.setProperty('--sidebar-width', `${state.sidebarWidth}px`)
    style.setProperty('--panel-height', `${state.panelHeight}px`)
    style.setProperty('--preview-width', `${state.previewWidth}px`)
    this.root.classList.toggle('sidebar-hidden', !state.sidebarVisible)
    this.root.classList.toggle('panel-hidden', !state.panelVisible)
    this.root.classList.toggle('preview-open', !!this.preview.currentEntry)
    this.root.classList.toggle('narrow', innerWidth <= NARROW)
    for (const view of [this.explorer.element, this.searchView.element]) {
      view.hidden = !(view === (state.sidebarView === 'explorer' ? this.explorer.element : this.searchView.element))
    }
    this.root.querySelectorAll<HTMLElement>('.activity-item[data-view]').forEach((el) => {
      el.classList.toggle('active', state.sidebarVisible && el.dataset.view === state.sidebarView)
    })
    this.panel.querySelectorAll<HTMLElement>('.panel-tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === this.panelView)
      el.setAttribute('aria-selected', String(el.dataset.view === this.panelView))
    })
    this.panel.querySelectorAll<HTMLElement>('.panel-view').forEach((el) => {
      el.hidden = el.dataset.view !== this.panelView
    })
  }

  private applyTheme(): void {
    const { theme } = this.settings.get()
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#18191d' : '#f5f6f8')
  }

  private updateState(patch: Partial<WorkbenchState>): void {
    Object.assign(this.state, patch)
    this.saveState()
  }

  // ---------------------------------------------------------------------------
  // Startup & events
  // ---------------------------------------------------------------------------

  private restore(firstRun: boolean): void {
    if (firstRun) {
      this.editors.restore(['/README.md', '/src/main.ts'], '/src/main.ts')
    } else {
      // Files with restored unsaved edits are always reopened so the edits are visible.
      const tabs = [...this.state.openTabs, ...this.docs.dirtyPaths().filter((p) => !this.state.openTabs.includes(p))]
      this.editors.restore(tabs, this.state.activeTab)
    }
    this.updateStatus()
    if (this.store.kind === 'memory') {
      notify('Browser storage is unavailable here, so files will not be kept after you close this page. Use “Download Project as .zip” to save your work.', 'warning', 10000)
    } else if (!this.storageReadable) {
      notify('The saved project could not be read, so this session will not be saved to protect it. Reload the page to try again, or download a .zip of this session.', 'error', 15000)
    }
  }

  private wireEvents(): void {
    const { fs, docs, editors, settings, runner } = this

    // Persist the project and unsaved edits.
    const persistProject = debounce(() => {
      if (!this.storageReadable) return
      this.store.set(PROJECT_KEY, fs.snapshot()).catch((err) => notify(`Could not save the project: ${(err as Error).message}`, 'error'))
    }, 250)
    const persistBuffers = debounce(() => {
      if (!this.storageReadable) return
      void this.store.set(BUFFERS_KEY, docs.dirtyBuffers()).catch(() => {})
    }, 400)
    fs.onDidChange.on(persistProject)
    docs.onDidChangeContent.on(persistBuffers)
    docs.onDidChangeDirty.on(persistBuffers)
    // Unsaved edits are keyed by path: re-save them when files move or disappear, or a
    // renamed file's edits would be lost (and a deleted file's edits could resurface).
    docs.onDidMove.on(persistBuffers)
    docs.onDidRemove.on(persistBuffers)
    docs.onDidReset.on(persistBuffers)
    addEventListener('pagehide', () => {
      persistProject.flush()
      persistBuffers.flush()
      saveWorkbenchState(this.state)
    })
    addEventListener('beforeunload', (e) => {
      if (this.store.kind === 'memory' && fs.fileCount) e.preventDefault()
    })

    // Auto save.
    const autoSave = debounce(() => settings.get().autoSave && docs.saveAll(), 1000)
    docs.onDidChangeContent.on(autoSave)

    editors.onDidChangeActive.on((path) => {
      this.explorer.setActiveFile(path)
      this.updateState({ activeTab: path })
      this.updateStatus()
    })
    editors.onDidChangeTabs.on((tabs) => this.updateState({ openTabs: [...tabs] }))
    editors.editor.onDidChangeCursorSelection(() => this.updateCursorStatus())
    docs.onDidChangeDirty.on(() => this.updateTitle())
    this.problems.onDidChangeCounts.on(() => this.updateProblemsStatus())

    settings.onDidChange.on(() => {
      this.applyTheme()
      this.updateStatus()
    })
    this.preview.onDidChangeEntry.on(() => {
      this.applyLayout()
      this.updateRunButton()
    })
    runner.onEvent.on((event) => this.onRunEvent(event))

    addEventListener('keydown', (e) => {
      if (this.quickInput.visible && e.key !== 'F1') return
      this.commands.handleKeydown(e)
    }, true)

    let wasNarrow = innerWidth <= NARROW
    addEventListener('resize', () => {
      const narrow = innerWidth <= NARROW
      if (narrow && !wasNarrow) this.updateState({ sidebarVisible: false })
      wasNarrow = narrow
      this.applyLayout()
      editors.editor.updateOptions({ minimap: { enabled: settings.get().minimap && !narrow } })
    })
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private openFile(path: string, options: { line?: number; column?: number; length?: number; focus?: boolean } = {}): void {
    if (!this.fs.isFile(path)) return
    this.editors.open(path, options)
    if (innerWidth <= NARROW && this.state.sidebarVisible) this.toggleSidebar(false)
  }

  private revealInExplorer(path: string): void {
    this.updateState({ sidebarVisible: true, sidebarView: 'explorer' })
    this.applyLayout()
    this.explorer.reveal(path)
  }

  private toggleSidebar(visible = !this.state.sidebarVisible): void {
    this.updateState({ sidebarVisible: visible })
    this.applyLayout()
  }

  private toggleSidebarView(view: 'explorer' | 'search'): void {
    if (this.state.sidebarVisible && this.state.sidebarView === view) {
      this.toggleSidebar(false)
      return
    }
    this.updateState({ sidebarVisible: true, sidebarView: view })
    this.applyLayout()
    if (view === 'search') {
      const editor = this.editors.editor
      const selection = editor.getSelection()
      const text = selection && editor.getModel() ? editor.getModel()!.getValueInRange(selection) : ''
      this.searchView.focus(text)
    } else {
      this.explorer.focus()
    }
  }

  private togglePanel(visible = !this.state.panelVisible): void {
    this.updateState({ panelVisible: visible })
    if (!visible) this.root.classList.remove('panel-maximized')
    this.applyLayout()
  }

  private showPanel(view: PanelView): void {
    this.panelView = view
    this.togglePanel(true)
  }

  private showQuickInput(value: string): void {
    const editor = this.editors.editor
    this.quickInput.show(value, () => (editor.getModel() ? editor.focus() : undefined))
  }

  private async save(path = this.editors.activePath): Promise<void> {
    if (!path) return
    const editor = this.editors.editor
    if (this.settings.get().formatOnSave && editor.getModel() === this.docs.get(path)?.model) {
      await editor.getAction('editor.action.formatDocument')?.run()
    }
    this.docs.save(path)
  }

  private closePreview(): void {
    this.preview.hide()
  }

  /** The active file if it can run, otherwise the last file that was run (e.g. F5 while editing CSS). */
  private runTarget(): string | null {
    const active = this.editors.activePath
    if (active && runtimeForPath(active)) return active
    const last = this.state.lastRun
    return last && this.fs.isFile(last) ? last : active
  }

  /** Runs a file: JS/TS/Python go to the console, HTML opens the live preview. */
  private run(path: string | null = this.runTarget()): void {
    if (!path || !this.fs.isFile(path)) {
      notify('Open a file to run it.', 'info')
      return
    }
    const runtime = runtimeForPath(path)
    if (!runtime) {
      notify(`Can't run ${basename(path)}. Supported: .js .ts .jsx .tsx .py .html`, 'warning')
      return
    }
    this.docs.saveAll()
    this.updateState({ lastRun: path })
    this.updateRunButton()
    if (runtime === 'html') {
      void this.preview.show(path)
      return
    }
    this.showPanel('console')
    this.consoleView.clear()
    this.runner.run(runtime, path, this.fs.snapshot().files, this.state.stdin)
  }

  private onRunEvent(event: RunEvent): void {
    const con = this.consoleView
    switch (event.type) {
      case 'start':
        con.append('system', `▶ ${event.runtime === 'python' ? 'Python' : 'JavaScript'} · ${event.entry}`)
        break
      case 'console':
        con.append(event.level, event.text, event.indent)
        break
      case 'clear':
        con.clear()
        break
      case 'status':
        con.append('system', event.text)
        this.status.run.replaceChildren(icon('loading', 'codicon-modifier-spin'), h('span', {}, event.text))
        return
      case 'done':
        con.append('system', event.ok ? `✓ Finished in ${formatDuration(event.ms)}` : `✗ Exited with errors after ${formatDuration(event.ms)}`)
        break
      case 'stopped':
        con.append('system', '■ Stopped')
        break
    }
    this.updateRunButton()
    this.updateRunStatus()
  }

  private async upload(dir: string, files?: File[]): Promise<void> {
    const chosen = files ?? (await pickFiles())
    if (!chosen.length) return
    const result = await readUploads(dir, chosen)
    const paths = Object.keys(result.files)
    const existing = paths.filter((p) => this.fs.isFile(p))
    if (existing.length) {
      const ok = await confirmDialog(
        'Replace existing files?',
        `${existing.length} file(s) already exist and will be overwritten: ${existing.slice(0, 5).map((p) => basename(p)).join(', ')}${existing.length > 5 ? '…' : ''}`,
        'Replace',
      )
      if (!ok) return
    }
    const failed: string[] = []
    for (const d of result.dirs) {
      try {
        this.fs.mkdir(d)
      } catch {
        failed.push(d)
      }
    }
    for (const [path, content] of Object.entries(result.files)) {
      try {
        this.fs.writeFile(path, content)
      } catch {
        failed.push(path)
      }
    }
    const added = paths.length - failed.filter((f) => paths.includes(f)).length
    let message = `Added ${added} file${added === 1 ? '' : 's'}.`
    if (result.skipped.length) message += ` Skipped ${result.skipped.length} binary file(s) — only text files are supported.`
    if (failed.length) message += ` ${failed.length} item(s) could not be written.`
    notify(message, failed.length || result.skipped.length ? 'warning' : 'info', 6000)
    if (paths[0]) this.revealInExplorer(paths[0])
  }

  private downloadProject(): void {
    const snapshot = this.fs.snapshot()
    for (const [path, text] of this.docs.contents()) snapshot.files[path] = text
    downloadBlob('some-ide-project.zip', exportZip(snapshot) as BlobPart, 'application/zip')
  }

  private async replaceProject(snapshot: ProjectSnapshot, title: string, message: string): Promise<void> {
    if (!(await confirmDialog(title, message, 'Continue', true))) return
    this.runner.stop()
    this.preview.hide()
    this.fs.load(snapshot)
    void this.store.set(BUFFERS_KEY, {})
    const first = ['/README.md', '/src/main.ts'].filter((p) => this.fs.isFile(p))
    this.editors.restore(first, first[first.length - 1] ?? null)
  }

  // ---------------------------------------------------------------------------
  // Menus, quick input, commands
  // ---------------------------------------------------------------------------

  private projectMenu(): MenuItem[] {
    const cmd = (id: string, iconName?: string): MenuItem => {
      const c = this.commands.get(id)!
      return { label: c.title, icon: iconName, keybinding: c.keybinding, run: () => this.commands.run(id) }
    }
    return [
      cmd('project.upload', 'cloud-upload'),
      cmd('project.uploadFolder', 'folder-opened'),
      cmd('project.importZip', 'file-zip'),
      cmd('project.downloadZip', 'desktop-download'),
      'separator',
      cmd('file.saveAll', 'save-all'),
      'separator',
      cmd('project.reset', 'discard'),
      cmd('project.clear', 'trash'),
    ]
  }

  private settingsMenu(): MenuItem[] {
    const s = this.settings.get()
    const toggle = (label: string, key: 'wordWrap' | 'minimap' | 'autoSave' | 'formatOnSave'): MenuItem => ({
      label,
      checked: s[key],
      run: () => this.settings.update({ [key]: !s[key] }),
    })
    return [
      { label: 'Dark Theme', checked: s.theme === 'dark', run: () => this.settings.update({ theme: 'dark' }) },
      { label: 'Light Theme', checked: s.theme === 'light', run: () => this.settings.update({ theme: 'light' }) },
      'separator',
      toggle('Word Wrap', 'wordWrap'),
      toggle('Minimap', 'minimap'),
      toggle('Auto Save', 'autoSave'),
      toggle('Format on Save', 'formatOnSave'),
      'separator',
      { label: `Increase Font Size (${s.fontSize}px)`, icon: 'zoom-in', keybinding: 'Ctrl+=', run: () => this.commands.run('view.fontBigger') },
      { label: 'Decrease Font Size', icon: 'zoom-out', keybinding: 'Ctrl+-', run: () => this.commands.run('view.fontSmaller') },
      'separator',
      { label: 'Keyboard Shortcuts', icon: 'keyboard', run: () => this.commands.run('help.shortcuts') },
      { label: 'Command Palette…', icon: 'terminal', keybinding: 'Ctrl+Shift+P', run: () => this.showQuickInput('>') },
    ]
  }

  private fileItems(query: string): QuickItem[] {
    const lineSuffix = /:(\d+)(?::(\d+))?$/.exec(query)
    const nameQuery = lineSuffix ? query.slice(0, lineSuffix.index) : query
    const open = (path: string) => () =>
      this.openFile(path, lineSuffix ? { line: Number(lineSuffix[1]), column: Number(lineSuffix[2] ?? 1) } : {})

    const files = this.fs.listFiles()
    if (!nameQuery.trim()) {
      // Most recent first: open tabs, then everything else.
      const tabs = this.editors.openPaths.filter((p) => p !== this.editors.activePath)
      const ordered = [...tabs, ...files.filter((p) => !tabs.includes(p))]
      return ordered.map((path) => ({
        label: basename(path),
        description: dirname(path).slice(1),
        icon: () => fileIcon(path),
        run: open(path),
      }))
    }
    return fuzzyFilter(nameQuery, files, (p) => p.slice(1)).map(({ item: path, positions }) => {
      const nameStart = path.lastIndexOf('/') // index in the slice(1) string where the name starts
      return {
        label: basename(path),
        labelHighlights: positions.filter((p) => p >= nameStart).map((p) => p - nameStart),
        description: dirname(path).slice(1),
        descriptionHighlights: positions.filter((p) => p < nameStart),
        icon: () => fileIcon(path),
        run: open(path),
      }
    })
  }

  private commandItems(query: string): QuickItem[] {
    const all: Array<{ title: string; keybinding?: string; run: () => void }> = this.commands
      .all()
      .filter((c) => !c.hidden && (c.enabled?.() ?? true))
      .map((c) => ({ title: c.category ? `${c.category}: ${c.title}` : c.title, keybinding: c.keybinding, run: () => this.commands.run(c.id) }))
    // Monaco's own editor actions (Toggle Line Comment, Fold All, Change All Occurrences…).
    const editor = this.editors.editor
    if (editor.getModel()) {
      for (const action of editor.getSupportedActions()) {
        if (!action.label) continue
        all.push({
          title: action.label,
          run: () => {
            editor.focus()
            void action.run()
          },
        })
      }
    }
    const items = query.trim()
      ? fuzzyFilter(query, all, (c) => c.title).map(({ item, positions }) => ({ ...item, positions }))
      : all.sort((a, b) => a.title.localeCompare(b.title)).map((item) => ({ ...item, positions: [] as number[] }))
    return items.map((c) => ({ label: c.title, labelHighlights: c.positions, keybinding: c.keybinding, run: c.run }))
  }

  private gotoLineItems(query: string): QuickItem[] | string {
    const model = this.editors.editor.getModel()
    if (!model) return 'Open a file first to go to a line.'
    const m = /^\s*(\d+)?(?::(\d+))?\s*$/.exec(query)
    const lines = model.getLineCount()
    if (!m || !m[1]) return `Current line: ${this.editors.editor.getPosition()?.lineNumber ?? 1}. Type a line number between 1 and ${lines}.`
    const line = Math.min(lines, Math.max(1, Number(m[1])))
    const column = Number(m[2] ?? 1)
    return [{ label: `Go to line ${line}${m[2] ? `, column ${column}` : ''}`, run: () => this.openFile(this.editors.activePath!, { line, column }) }]
  }

  private registerCommands(): void {
    const { docs, editors, settings } = this
    const hasEditor = () => !!editors.activePath
    const list: Command[] = [
      { id: 'workbench.quickOpen', title: 'Go to File…', keybinding: 'Ctrl+P', global: true, run: () => this.showQuickInput('') },
      { id: 'workbench.commandPalette', title: 'Show All Commands', keybinding: 'Ctrl+Shift+P', global: true, run: () => this.showQuickInput('>') },
      { id: 'workbench.commandPaletteF1', title: 'Show All Commands', keybinding: 'F1', global: true, hidden: true, run: () => this.showQuickInput('>') },
      { id: 'workbench.gotoLine', title: 'Go to Line…', keybinding: 'Ctrl+G', run: () => this.showQuickInput(':'), enabled: hasEditor },

      { id: 'file.newFile', category: 'File', title: 'New File…', keybinding: 'Alt+N', run: () => this.newItem('file') },
      { id: 'file.newFolder', category: 'File', title: 'New Folder…', run: () => this.newItem('folder') },
      { id: 'file.save', category: 'File', title: 'Save', keybinding: 'Ctrl+S', global: true, run: () => this.save() },
      { id: 'file.saveAll', category: 'File', title: 'Save All', keybinding: 'Ctrl+Alt+S', global: true, run: () => docs.saveAll() },
      { id: 'file.revert', category: 'File', title: 'Revert File', enabled: hasEditor, run: () => editors.activePath && docs.revert(editors.activePath) },
      { id: 'file.rename', category: 'File', title: 'Rename…', enabled: hasEditor, run: () => this.renameActive() },
      { id: 'file.delete', category: 'File', title: 'Delete File', enabled: hasEditor, run: () => editors.activePath && void this.explorer.delete(editors.activePath) },
      { id: 'file.download', category: 'File', title: 'Download File', enabled: hasEditor, run: () => editors.activePath && downloadBlob(basename(editors.activePath), docs.read(editors.activePath), 'text/plain') },
      { id: 'file.reveal', category: 'File', title: 'Reveal Active File in Explorer', enabled: hasEditor, run: () => editors.activePath && this.revealInExplorer(editors.activePath) },

      { id: 'editor.close', category: 'View', title: 'Close Editor', keybinding: 'Alt+W', enabled: hasEditor, run: () => editors.activePath && void editors.close(editors.activePath) },
      { id: 'editor.closeAll', category: 'View', title: 'Close All Editors', run: () => void editors.closeAll() },
      { id: 'editor.next', category: 'View', title: 'Open Next Editor', keybinding: 'Alt+]', run: () => editors.cycle(1) },
      { id: 'editor.previous', category: 'View', title: 'Open Previous Editor', keybinding: 'Alt+[', run: () => editors.cycle(-1) },
      { id: 'editor.format', category: 'Editor', title: 'Format Document', keybinding: 'Shift+Alt+F', enabled: hasEditor, run: () => void editors.editor.getAction('editor.action.formatDocument')?.run() },

      { id: 'run.start', category: 'Run', title: 'Run File', keybinding: 'F5', global: true, run: () => this.run() },
      { id: 'run.stop', category: 'Run', title: 'Stop', keybinding: 'Shift+F5', global: true, enabled: () => this.runner.running, run: () => this.runner.stop() },
      { id: 'run.preview', category: 'Run', title: 'Open Preview', run: () => this.openPreviewForActive() },
      { id: 'run.closePreview', category: 'Run', title: 'Close Preview', enabled: () => !!this.preview.currentEntry, run: () => this.closePreview() },
      { id: 'run.clearConsole', category: 'Run', title: 'Clear Console', run: () => this.consoleView.clear() },

      { id: 'view.explorer', category: 'View', title: 'Show Explorer', keybinding: 'Ctrl+Shift+E', global: true, run: () => this.showSidebarView('explorer') },
      { id: 'view.search', category: 'View', title: 'Search in Files', keybinding: 'Ctrl+Shift+F', global: true, run: () => this.showSidebarView('search') },
      { id: 'view.toggleSidebar', category: 'View', title: 'Toggle Sidebar', keybinding: 'Ctrl+B', run: () => this.toggleSidebar() },
      { id: 'view.togglePanel', category: 'View', title: 'Toggle Panel', keybinding: 'Ctrl+J', global: true, run: () => this.togglePanel() },
      { id: 'view.togglePanelBacktick', category: 'View', title: 'Toggle Panel', keybinding: 'Ctrl+`', global: true, hidden: true, run: () => this.togglePanel() },
      { id: 'view.console', category: 'View', title: 'Show Console', run: () => this.showPanel('console') },
      { id: 'view.problems', category: 'View', title: 'Show Problems', keybinding: 'Ctrl+Shift+M', run: () => this.showPanel('problems') },
      { id: 'view.fontBigger', category: 'View', title: 'Increase Editor Font Size', keybinding: 'Ctrl+=', run: () => settings.update({ fontSize: settings.get().fontSize + 1 }) },
      { id: 'view.fontSmaller', category: 'View', title: 'Decrease Editor Font Size', keybinding: 'Ctrl+-', run: () => settings.update({ fontSize: settings.get().fontSize - 1 }) },
      { id: 'view.fontReset', category: 'View', title: 'Reset Editor Font Size', keybinding: 'Ctrl+0', run: () => settings.update({ fontSize: 14 }) },

      { id: 'preferences.toggleTheme', category: 'Preferences', title: 'Toggle Light/Dark Theme', run: () => settings.update({ theme: settings.get().theme === 'dark' ? 'light' : 'dark' }) },
      { id: 'preferences.toggleWordWrap', category: 'View', title: 'Toggle Word Wrap', keybinding: 'Alt+Z', run: () => settings.update({ wordWrap: !settings.get().wordWrap }) },
      { id: 'preferences.toggleMinimap', category: 'View', title: 'Toggle Minimap', run: () => settings.update({ minimap: !settings.get().minimap }) },
      { id: 'preferences.toggleAutoSave', category: 'File', title: 'Toggle Auto Save', run: () => settings.update({ autoSave: !settings.get().autoSave }) },
      { id: 'preferences.toggleFormatOnSave', category: 'Preferences', title: 'Toggle Format on Save', run: () => settings.update({ formatOnSave: !settings.get().formatOnSave }) },

      { id: 'project.upload', category: 'Project', title: 'Upload Files…', run: () => void this.upload('/') },
      { id: 'project.uploadFolder', category: 'Project', title: 'Upload Folder…', run: async () => void this.upload('/', await pickFiles({ directory: true })) },
      { id: 'project.importZip', category: 'Project', title: 'Import .zip…', run: async () => void this.upload('/', await pickFiles({ accept: '.zip', multiple: false })) },
      { id: 'project.downloadZip', category: 'Project', title: 'Download Project as .zip', run: () => this.downloadProject() },
      {
        id: 'project.reset',
        category: 'Project',
        title: 'Reset to Sample Project…',
        run: () => void this.replaceProject(sampleProject(), 'Reset to sample project?', 'All files will be replaced by the sample project. This cannot be undone — download a .zip first if you want to keep your work.'),
      },
      {
        id: 'project.clear',
        category: 'Project',
        title: 'New Empty Project…',
        run: () => void this.replaceProject({ files: {}, dirs: [] }, 'Start an empty project?', 'All files will be deleted. This cannot be undone — download a .zip first if you want to keep your work.'),
      },
      { id: 'help.shortcuts', category: 'Help', title: 'Keyboard Shortcuts', run: () => this.showShortcuts() },
    ]
    this.commands.register(...list)
  }

  private newItem(kind: 'file' | 'folder'): void {
    this.updateState({ sidebarVisible: true, sidebarView: 'explorer' })
    this.applyLayout()
    if (kind === 'file') this.explorer.newFile()
    else this.explorer.newFolder()
  }

  private renameActive(): void {
    const path = this.editors.activePath
    if (!path) return
    this.revealInExplorer(path)
    this.explorer.rename(path)
  }

  private showSidebarView(view: 'explorer' | 'search'): void {
    this.updateState({ sidebarVisible: false })
    this.toggleSidebarView(view)
  }

  private openPreviewForActive(): void {
    const path = this.editors.activePath
    const html = path && runtimeForPath(path) === 'html' ? path : this.fs.listFiles().find((p) => /(^|\/)index\.html?$/.test(p))
    if (!html) {
      notify('Open an .html file to preview it.', 'info')
      return
    }
    this.docs.saveAll()
    void this.preview.show(html)
  }

  private showShortcuts(): void {
    const items = this.commands
      .all()
      .filter((c) => c.keybinding && !c.hidden)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((c) => ({ label: c.category ? `${c.category}: ${c.title}` : c.title, keybinding: c.keybinding, run: () => this.commands.run(c.id) }))
    const provider = { prefix: '', placeholder: 'Keyboard shortcuts', items: () => items }
    const qi = new QuickInput([provider])
    qi.show('', () => this.editors.editor.focus())
  }

  // ---------------------------------------------------------------------------
  // Status bar & title
  // ---------------------------------------------------------------------------

  private updateStatus(): void {
    const path = this.editors.activePath
    const s = this.settings.get()
    this.status.language.textContent = path ? languageForPath(path).label : ''
    this.status.language.hidden = !path
    this.status.indent.textContent = `Spaces: ${s.tabSize}`
    this.status.indent.hidden = !path
    this.status.encoding.hidden = !path
    this.status.eol.hidden = !path
    const storage = { indexeddb: 'Saved in browser', localstorage: 'Saved in browser', memory: 'Not saved (no storage)' }[this.store.kind]
    this.status.storage.replaceChildren(icon(this.store.kind === 'memory' ? 'warning' : 'database'), h('span', {}, storage))
    this.status.storage.title = this.store.kind === 'memory' ? 'Browser storage is unavailable' : `Files are stored in this browser (${this.store.kind})`
    this.updateCursorStatus()
    this.updateProblemsStatus()
    this.updateRunButton()
    this.updateRunStatus()
    this.updateTitle()
  }

  private updateCursorStatus(): void {
    const editor = this.editors.editor
    const pos = editor.getPosition()
    const model = editor.getModel()
    const el = this.status.cursor
    if (!pos || !model) {
      el.hidden = true
      return
    }
    el.hidden = false
    const selections = editor.getSelections() ?? []
    const selected = selections.reduce((n, s) => n + model.getValueLengthInRange(s), 0)
    el.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}${selected ? ` (${selected} selected)` : ''}`
  }

  private updateProblemsStatus(): void {
    const { errors, warnings } = this.problems.problemCounts
    this.status.problems.replaceChildren(icon('error'), h('span', {}, String(errors)), icon('warning'), h('span', {}, String(warnings)))
    const badge = this.panel.querySelector<HTMLElement>('.problems-badge')!
    badge.textContent = String(errors + warnings)
    badge.hidden = errors + warnings === 0
  }

  private updateRunStatus(): void {
    const current = this.runner.current
    const el = this.status.run
    el.classList.toggle('running', !!current)
    if (current) el.replaceChildren(icon('loading', 'codicon-modifier-spin'), h('span', {}, `Running ${basename(current.entry)}`))
    else el.replaceChildren(icon('terminal'), h('span', {}, 'Console'))
  }

  private updateRunButton(): void {
    const path = this.runTarget()
    const runtime = path ? runtimeForPath(path) : null
    const running = this.runner.running
    this.stopButton.hidden = !running
    const label = this.runButton.querySelector('.run-label')!
    const html = runtime === 'html'
    this.runButton.replaceChildren(icon(html ? 'open-preview' : running ? 'debug-restart' : 'play'), label)
    label.textContent = html ? 'Preview' : running ? 'Restart' : 'Run'
    this.runButton.disabled = !runtime
    const action = html ? 'Open Preview' : 'Run'
    this.runButton.title = runtime
      ? `${action}: ${path} (${formatKeybinding('F5')})`
      : 'This file type cannot be run (supported: .js .ts .jsx .tsx .py .html)'
  }

  private updateTitle(): void {
    const path = this.editors.activePath
    document.title = path ? `${this.docs.isDirty(path) ? '● ' : ''}${basename(path)} — some-ide` : 'some-ide'
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

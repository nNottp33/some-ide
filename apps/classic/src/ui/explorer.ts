import { runtimeForPath } from '@some/runtime-core/core/languages'
import { basename, dirname, isWithin, join, rebase, resolveRelative, validateName } from '@some/runtime-core/core/path'
import { FsError, type EntryKind, type VirtualFS } from '@some/runtime-core/core/vfs'
import type { DocumentManager } from '../editor/documents'
import { confirmDialog, notify, showContextMenu, type MenuItem } from './dialogs'
import { h, icon, iconButton } from './dom'
import { fileIcon, folderIcon } from './file-icon'

export interface ExplorerOptions {
  fs: VirtualFS
  docs: DocumentManager
  expanded: string[]
  /** `focusEditor` is false for a single click so keyboard focus stays in the tree. */
  onOpen: (path: string, focusEditor: boolean) => void
  onRun: (path: string) => void
  onExpandedChange: (expanded: string[]) => void
  onUpload: (targetDir: string, files?: File[]) => void
  onMore: (anchor: HTMLElement) => void
  onDownloadFile: (path: string) => void
}

type EditState =
  | { mode: 'new-file' | 'new-folder'; parent: string }
  | { mode: 'rename'; path: string; kind: EntryKind }

interface VisibleRow {
  path: string
  kind: EntryKind
  depth: number
}

const INDENT = 12
const BASE_PADDING = 8

/** The file tree in the sidebar: create, rename, move (drag & drop), delete, upload. */
export class Explorer {
  readonly element: HTMLElement
  private readonly tree: HTMLElement
  private readonly expanded: Set<string>
  private rows: VisibleRow[] = []
  private selected: string | null = null
  private activeFile: string | null = null
  private editing: EditState | null = null
  /** The live input row for `editing`, kept across re-renders so typed text survives. */
  private editRow: { state: EditState; element: HTMLElement; input: HTMLInputElement; fresh: boolean } | null = null
  private renderQueued = false
  /** True while the tree DOM is being rebuilt; detaching a focused input fires `blur`. */
  private rendering = false
  /** Whether keyboard focus was in the tree when the last render started. */
  private focusInTree = false
  private dragSource: string | null = null

  constructor(private readonly options: ExplorerOptions) {
    const { fs, docs } = options
    this.expanded = new Set(options.expanded)

    this.tree = h('div', {
      class: 'tree',
      attrs: { role: 'tree', tabindex: '0', 'aria-label': 'Files' },
      onclick: (e: MouseEvent) => this.onClick(e),
      oncontextmenu: (e: MouseEvent) => this.onContextMenu(e),
      onkeydown: (e: KeyboardEvent) => this.onKeydown(e),
      ondragstart: (e: DragEvent) => this.onDragStart(e),
      ondragover: (e: DragEvent) => this.onDragOver(e),
      ondragleave: (e: DragEvent) => this.onDragLeave(e),
      ondrop: (e: DragEvent) => this.onDrop(e),
      ondragend: () => {
        this.dragSource = null
        this.clearDropTarget()
      },
    })

    this.element = h(
      'div',
      { class: 'view explorer' },
      h(
        'div',
        { class: 'view-header' },
        h('span', { class: 'view-title' }, 'Explorer'),
        h(
          'div',
          { class: 'view-actions' },
          iconButton('new-file', 'New File… (Alt+N)', () => this.newFile()),
          iconButton('new-folder', 'New Folder…', () => this.newFolder()),
          iconButton('cloud-upload', 'Upload Files…', () => options.onUpload(this.targetFolder())),
          iconButton('collapse-all', 'Collapse Folders', () => this.collapseAll()),
          iconButton('ellipsis', 'More Actions…', (e) => options.onMore(e.currentTarget as HTMLElement)),
        ),
      ),
      this.tree,
    )

    fs.onDidChange.on((event) => {
      if (event.type === 'rename') {
        for (const p of [...this.expanded]) {
          if (isWithin(event.oldPath, p)) {
            this.expanded.delete(p)
            this.expanded.add(rebase(p, event.oldPath, event.path))
          }
        }
        if (this.selected && isWithin(event.oldPath, this.selected)) this.selected = rebase(this.selected, event.oldPath, event.path)
        this.persistExpanded()
      } else if (event.type === 'delete') {
        for (const p of [...this.expanded]) if (isWithin(event.path, p)) this.expanded.delete(p)
        if (this.selected && isWithin(event.path, this.selected)) this.selected = null
      }
      this.scheduleRender()
    })
    docs.onDidChangeDirty.on(() => this.scheduleRender())
    this.render()
  }

  setActiveFile(path: string | null): void {
    this.activeFile = path
    this.scheduleRender()
  }

  /** Expands the parents of `path`, selects it and scrolls it into view. */
  reveal(path: string): void {
    for (let d = dirname(path); d !== '/'; d = dirname(d)) this.expanded.add(d)
    this.selected = path
    this.persistExpanded()
    this.render()
    this.rowElement(path)?.scrollIntoView({ block: 'nearest' })
  }

  focus(): void {
    this.tree.focus()
  }

  newFile(parent = this.targetFolder()): void {
    this.startEdit({ mode: 'new-file', parent })
  }

  newFolder(parent = this.targetFolder()): void {
    this.startEdit({ mode: 'new-folder', parent })
  }

  rename(path: string): void {
    const kind = this.options.fs.kind(path)
    if (kind) this.startEdit({ mode: 'rename', path, kind })
  }

  async delete(path: string): Promise<void> {
    const { fs, docs } = this.options
    const kind = fs.kind(path)
    if (!kind) return
    const dirty = docs.dirtyPaths().filter((p) => isWithin(path, p)).length
    const what = kind === 'dir' ? `the folder "${basename(path)}" and everything in it` : `"${basename(path)}"`
    const ok = await confirmDialog(
      'Delete',
      `Are you sure you want to delete ${what}?${dirty ? ` ${dirty} file(s) have unsaved changes.` : ''} This cannot be undone.`,
      'Delete',
      true,
    )
    if (!ok) return
    try {
      fs.delete(path)
    } catch (err) {
      notify((err as Error).message, 'error')
    }
    this.focus()
  }

  collapseAll(): void {
    this.expanded.clear()
    this.persistExpanded()
    this.render()
  }

  /** The folder new items go into: the selected folder, or the selected file's folder. */
  private targetFolder(): string {
    const { fs } = this.options
    if (!this.selected || !fs.exists(this.selected)) return '/'
    return fs.isDir(this.selected) ? this.selected : dirname(this.selected)
  }

  private persistExpanded(): void {
    this.options.onExpandedChange([...this.expanded])
  }

  private scheduleRender(): void {
    if (this.renderQueued) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      this.render()
    })
  }

  private startEdit(state: EditState): void {
    if (state.mode !== 'rename') {
      for (let d = state.parent; d !== '/'; d = dirname(d)) this.expanded.add(d)
      this.persistExpanded()
    }
    this.editing = state
    this.render()
  }

  private render(): void {
    // Moving the input row being edited out of the live tree (while building the fragment)
    // already fires its blur; the guard must cover the whole render, not just replaceChildren.
    this.rendering = true
    try {
      this.renderTree()
    } finally {
      this.rendering = false
    }
    this.afterRender()
  }

  private renderTree(): void {
    const { fs, docs } = this.options
    const fragment = document.createDocumentFragment()
    this.rows = []
    const dirtyPaths = docs.dirtyPaths()

    const walk = (dir: string, depth: number) => {
      if (this.editing && this.editing.mode !== 'rename' && this.editing.parent === dir) {
        fragment.append(this.inputRow(depth, this.editing.mode === 'new-folder' ? 'dir' : 'file', ''))
      }
      for (const entry of fs.readdir(dir)) {
        if (this.editing?.mode === 'rename' && this.editing.path === entry.path) {
          fragment.append(this.inputRow(depth, entry.kind, entry.name, entry.path))
        } else {
          const dirty = entry.kind === 'file' ? dirtyPaths.includes(entry.path) : dirtyPaths.some((p) => isWithin(entry.path, p))
          fragment.append(this.row(entry.path, entry.name, entry.kind, depth, dirty))
          this.rows.push({ path: entry.path, kind: entry.kind, depth })
        }
        if (entry.kind === 'dir' && this.expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk('/', 0)

    if (!fs.fileCount && !this.editing && !fs.readdir('/').length) {
      fragment.append(
        h(
          'div',
          { class: 'tree-empty' },
          h('p', {}, 'This project is empty.'),
          h('button', { class: 'button primary', attrs: { type: 'button' }, onclick: () => this.newFile('/') }, 'New File'),
          h('button', { class: 'button', attrs: { type: 'button' }, onclick: () => this.options.onUpload('/') }, 'Upload Files'),
        ),
      )
    }

    this.focusInTree = this.tree.contains(document.activeElement) && !(document.activeElement instanceof HTMLInputElement)
    this.tree.replaceChildren(fragment)
  }

  private afterRender(): void {
    const focusInTree = this.focusInTree
    const edit = this.editRow
    if (edit && !edit.element.isConnected) {
      // The folder being edited in is gone (deleted or moved meanwhile): drop the edit.
      this.editing = null
      this.editRow = null
    }
    if (edit?.element.isConnected) {
      // Moving the row during replaceChildren drops focus; the text and caret are kept.
      if (document.activeElement !== edit.input) edit.input.focus()
      if (edit.fresh) {
        edit.fresh = false
        // Select the name without the extension, like VS Code does.
        const dot = edit.input.value.lastIndexOf('.')
        edit.input.setSelectionRange(0, dot > 0 && edit.state.mode === 'rename' ? dot : edit.input.value.length)
      }
    } else if (focusInTree) {
      this.tree.focus()
    }
  }

  private row(path: string, name: string, kind: EntryKind, depth: number, dirty: boolean): HTMLElement {
    const open = kind === 'dir' && this.expanded.has(path)
    const classes = ['tree-row']
    if (path === this.selected) classes.push('selected')
    if (path === this.activeFile) classes.push('active')
    if (dirty) classes.push('dirty')
    return h(
      'div',
      {
        class: classes.join(' '),
        style: { paddingLeft: `${BASE_PADDING + depth * INDENT}px` },
        dataset: { path, kind },
        title: path,
        attrs: {
          role: 'treeitem',
          draggable: 'true',
          'aria-level': String(depth + 1),
          'aria-selected': String(path === this.selected),
          ...(kind === 'dir' ? { 'aria-expanded': String(open) } : {}),
        },
      },
      kind === 'dir' ? icon(open ? 'chevron-down' : 'chevron-right', 'twistie') : h('span', { class: 'twistie' }),
      kind === 'dir' ? folderIcon(open) : fileIcon(path),
      h('span', { class: 'tree-label' }, name),
      dirty ? h('span', { class: 'tree-dirty', title: 'Unsaved changes' }) : null,
    )
  }

  private inputRow(depth: number, kind: EntryKind, value: string, renaming?: string): HTMLElement {
    // A background re-render (auto save, a dirty-state change) re-uses the row being edited
    // instead of rebuilding it, so what is being typed is not lost.
    if (this.editRow && this.editing && this.editRow.state === this.editing) {
      this.editRow.element.style.paddingLeft = `${BASE_PADDING + depth * INDENT}px`
      return this.editRow.element
    }
    const error = h('div', { class: 'tree-input-error' })
    let done = false
    const finish = (commit: boolean) => {
      if (done) return
      const name = input.value.trim()
      const mode = this.editing?.mode
      let committed = false
      if (commit && name && name !== value) {
        const message = this.commitEdit(name)
        if (message) {
          error.textContent = message
          error.classList.add('visible')
          return
        }
        committed = true
      }
      done = true
      this.editRow = null
      this.editing = null
      this.render()
      // A newly created file is opened in the editor, which keeps the focus.
      if (!(committed && mode === 'new-file')) this.focus()
    }
    const input = h('input', {
      class: 'tree-input',
      attrs: { type: 'text', value, spellcheck: 'false', autocomplete: 'off', 'aria-label': renaming ? 'New name' : 'Name' },
      oninput: () => {
        const message = this.validate(input.value.trim())
        error.textContent = message ?? ''
        error.classList.toggle('visible', !!message)
      },
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation()
        if (e.key !== 'Enter' && e.key !== 'Escape') return
        // Without preventDefault the Enter would also type a newline into the editor we open.
        e.preventDefault()
        finish(e.key === 'Enter')
      },
      onblur: () => {
        // Commit on blur like VS Code; if that fails, just cancel.
        if (done || this.rendering) return
        const name = input.value.trim()
        if (name && name !== value && !this.validate(name)) finish(true)
        else finish(false)
      },
    })
    const glyph = kind === 'dir' ? folderIcon(false) : fileIcon(value || 'file.txt')
    const element = h(
      'div',
      { class: 'tree-row editing', style: { paddingLeft: `${BASE_PADDING + depth * INDENT}px` } },
      h('span', { class: 'twistie' }),
      glyph,
      h('div', { class: 'tree-input-wrap' }, input, error),
    )
    this.editRow = { state: this.editing!, element, input, fresh: true }
    return element
  }

  private targetPathFor(name: string): string | null {
    const edit = this.editing
    if (!edit) return null
    if (edit.mode === 'rename') return join(dirname(edit.path), name)
    return resolveRelative(edit.parent, name)
  }

  private validate(name: string): string | null {
    if (!name) return null
    const edit = this.editing
    if (!edit) return null
    // New items may include sub-folders ("utils/math.ts"); renames are a single name.
    const parts = edit.mode === 'rename' ? [name] : name.split('/').filter(Boolean)
    for (const part of parts) {
      const error = validateName(part)
      if (error) return error
    }
    const target = this.targetPathFor(name)
    if (target && (edit.mode !== 'rename' || target !== edit.path) && this.options.fs.exists(target)) {
      return `A file or folder "${basename(target)}" already exists here.`
    }
    return null
  }

  /** Applies the pending edit. Returns an error message, or null on success. */
  private commitEdit(name: string): string | null {
    const { fs } = this.options
    const edit = this.editing
    const target = this.targetPathFor(name)
    if (!edit || !target) return null
    const invalid = this.validate(name)
    if (invalid) return invalid
    try {
      if (edit.mode === 'rename') {
        fs.rename(edit.path, target)
        this.selected = target
      } else if (edit.mode === 'new-file') {
        fs.createFile(target)
        this.selected = target
        this.editing = null
        this.reveal(target)
        this.options.onOpen(target, true)
      } else {
        fs.createDir(target)
        this.expanded.add(target)
        this.selected = target
        this.persistExpanded()
      }
      return null
    } catch (err) {
      if (err instanceof FsError) return err.message
      throw err
    }
  }

  private rowElement(path: string): HTMLElement | null {
    return this.tree.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(path)}"]`)
  }

  private rowFromEvent(e: Event): { path: string; kind: EntryKind } | null {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row[data-path]')
    return row ? { path: row.dataset.path!, kind: row.dataset.kind as EntryKind } : null
  }

  private toggle(path: string, open = !this.expanded.has(path)): void {
    if (open) this.expanded.add(path)
    else this.expanded.delete(path)
    this.persistExpanded()
    this.render()
  }

  private onClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.tree-row.editing, .tree-empty')) return
    const hit = this.rowFromEvent(e)
    if (!hit) {
      this.selected = null
      this.render()
      return
    }
    this.selected = hit.path
    if (hit.kind === 'dir') this.toggle(hit.path)
    else {
      this.render()
      this.options.onOpen(hit.path, e.detail > 1)
    }
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault()
    const hit = this.rowFromEvent(e)
    const { onRun, onUpload, onDownloadFile } = this.options
    if (hit) {
      this.selected = hit.path
      this.render()
    }
    const folder = hit ? (hit.kind === 'dir' ? hit.path : dirname(hit.path)) : '/'
    const items: MenuItem[] = [
      { label: 'New File…', icon: 'new-file', run: () => this.newFile(folder) },
      { label: 'New Folder…', icon: 'new-folder', run: () => this.newFolder(folder) },
      { label: 'Upload Files…', icon: 'cloud-upload', run: () => onUpload(folder) },
    ]
    if (hit) {
      if (hit.kind === 'file') {
        items.unshift({ label: 'Open', icon: 'go-to-file', run: () => this.options.onOpen(hit.path, true) })
        if (runtimeForPath(hit.path)) {
          const label = runtimeForPath(hit.path) === 'html' ? 'Open Preview' : 'Run File'
          items.splice(1, 0, { label, icon: 'play', run: () => onRun(hit.path) }, 'separator')
        } else {
          items.splice(1, 0, 'separator')
        }
      }
      items.push(
        'separator',
        { label: 'Rename…', icon: 'edit', keybinding: 'F2', run: () => this.rename(hit.path) },
        { label: 'Delete', icon: 'trash', keybinding: 'Delete', run: () => void this.delete(hit.path) },
        'separator',
        { label: 'Copy Path', icon: 'copy', run: () => void navigator.clipboard?.writeText(hit.path) },
      )
      if (hit.kind === 'file') items.push({ label: 'Download', icon: 'desktop-download', run: () => onDownloadFile(hit.path) })
    } else {
      items.push('separator', { label: 'Collapse Folders', icon: 'collapse-all', run: () => this.collapseAll() })
    }
    showContextMenu(e, items)
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return
    const index = this.rows.findIndex((r) => r.path === this.selected)
    const current = this.rows[index]
    const select = (i: number) => {
      const row = this.rows[Math.max(0, Math.min(this.rows.length - 1, i))]
      if (!row) return
      this.selected = row.path
      this.render()
      this.rowElement(row.path)?.scrollIntoView({ block: 'nearest' })
    }
    switch (e.key) {
      case 'ArrowDown':
        select(index + 1)
        break
      case 'ArrowUp':
        select(index < 0 ? this.rows.length - 1 : index - 1)
        break
      case 'Home':
        select(0)
        break
      case 'End':
        select(this.rows.length - 1)
        break
      case 'ArrowRight':
        if (current?.kind === 'dir') {
          if (!this.expanded.has(current.path)) this.toggle(current.path, true)
          else select(index + 1)
        }
        break
      case 'ArrowLeft':
        if (current?.kind === 'dir' && this.expanded.has(current.path)) this.toggle(current.path, false)
        else if (current && dirname(current.path) !== '/') select(this.rows.findIndex((r) => r.path === dirname(current.path)))
        break
      case 'Enter':
        if (!current) return
        if (current.kind === 'dir') this.toggle(current.path)
        else this.options.onOpen(current.path, true)
        break
      case 'F2':
        if (current) this.rename(current.path)
        break
      case 'Delete':
        if (current) void this.delete(current.path)
        break
      default:
        return
    }
    e.preventDefault()
  }

  // --- Drag & drop: move items inside the tree, or drop files from the desktop. ---

  private dropFolder(e: DragEvent): string {
    const hit = this.rowFromEvent(e)
    if (!hit) return '/'
    return hit.kind === 'dir' ? hit.path : dirname(hit.path)
  }

  private onDragStart(e: DragEvent): void {
    const hit = this.rowFromEvent(e)
    if (!hit || !e.dataTransfer) return
    this.dragSource = hit.path
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', hit.path)
  }

  private onDragOver(e: DragEvent): void {
    const external = !this.dragSource && e.dataTransfer?.types.includes('Files')
    const folder = this.dropFolder(e)
    const allowed = external || (this.dragSource !== null && !isWithin(this.dragSource, folder) && dirname(this.dragSource) !== folder)
    if (!allowed) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = external ? 'copy' : 'move'
    this.clearDropTarget()
    const target = folder === '/' ? this.tree : this.rowElement(folder)
    target?.classList.add('drop-target')
  }

  private onDragLeave(e: DragEvent): void {
    if (!this.tree.contains(e.relatedTarget as Node)) this.clearDropTarget()
  }

  private clearDropTarget(): void {
    this.tree.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'))
    this.tree.classList.remove('drop-target')
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault()
    this.clearDropTarget()
    const folder = this.dropFolder(e)
    const source = this.dragSource
    this.dragSource = null
    if (source) {
      try {
        this.options.fs.rename(source, join(folder, basename(source)))
        if (folder !== '/') this.expanded.add(folder)
        this.persistExpanded()
      } catch (err) {
        notify((err as Error).message, 'error')
      }
    } else if (e.dataTransfer?.files.length) {
      this.options.onUpload(folder, [...e.dataTransfer.files])
    }
  }
}

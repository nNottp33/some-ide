import { debounce } from '../core/emitter'
import { basename, dirname } from '../core/path'
import { buildSearchRegex, searchFiles, type SearchOptions, type SearchResults } from '../core/search'
import type { DocumentManager } from '../editor/documents'
import { confirmDialog, notify } from './dialogs'
import { h, icon, iconButton } from './dom'
import { fileIcon } from './file-icon'

export interface SearchViewOptions {
  docs: DocumentManager
  onOpen: (path: string, line: number, column: number, length: number) => void
}

/** Find (and replace) across all project files, including unsaved edits. */
export class SearchView {
  readonly element: HTMLElement
  private readonly queryInput: HTMLInputElement
  private readonly replaceInput: HTMLInputElement
  private readonly replaceRow: HTMLElement
  private readonly summary: HTMLElement
  private readonly results: HTMLElement
  private readonly collapsed = new Set<string>()
  private options: Required<Omit<SearchOptions, 'query'>> = { caseSensitive: false, wholeWord: false, regex: false }
  private last: SearchResults | null = null

  constructor(private readonly deps: SearchViewOptions) {
    const run = debounce(() => this.search(), 200)
    const toggle = (key: keyof typeof this.options, glyph: string, title: string) => {
      const button = iconButton(glyph, title, () => {
        this.options[key] = !this.options[key]
        button.classList.toggle('checked', this.options[key])
        button.setAttribute('aria-pressed', String(this.options[key]))
        this.search()
      }, 'toggle')
      button.setAttribute('aria-pressed', 'false')
      return button
    }

    this.queryInput = h('input', {
      class: 'input',
      attrs: { type: 'text', placeholder: 'Search', spellcheck: 'false', 'aria-label': 'Search' },
      oninput: () => run(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          run.flush()
          this.search()
        }
      },
    })
    this.replaceInput = h('input', {
      class: 'input',
      attrs: { type: 'text', placeholder: 'Replace', spellcheck: 'false', 'aria-label': 'Replace' },
    })
    this.replaceRow = h(
      'div',
      { class: 'search-row' },
      this.replaceInput,
      iconButton('replace-all', 'Replace All', () => void this.replaceAll()),
    )
    this.replaceRow.hidden = true
    const replaceToggle = iconButton('chevron-right', 'Toggle Replace', () => {
      this.replaceRow.hidden = !this.replaceRow.hidden
      replaceToggle.replaceChildren(icon(this.replaceRow.hidden ? 'chevron-right' : 'chevron-down'))
      if (!this.replaceRow.hidden) this.replaceInput.focus()
    }, 'replace-toggle')

    this.summary = h('div', { class: 'search-summary' })
    this.results = h('div', { class: 'search-results', attrs: { role: 'tree' } })

    this.element = h(
      'div',
      { class: 'view search-view' },
      h('div', { class: 'view-header' }, h('span', { class: 'view-title' }, 'Search')),
      h(
        'div',
        { class: 'search-form' },
        replaceToggle,
        h(
          'div',
          { class: 'search-inputs' },
          h(
            'div',
            { class: 'search-row' },
            this.queryInput,
            toggle('caseSensitive', 'case-sensitive', 'Match Case'),
            toggle('wholeWord', 'whole-word', 'Match Whole Word'),
            toggle('regex', 'regex', 'Use Regular Expression'),
          ),
          this.replaceRow,
        ),
      ),
      this.summary,
      this.results,
    )

    // Keep results fresh while the user edits files.
    const refresh = debounce(() => this.element.isConnected && this.queryInput.value && this.search(), 500)
    deps.docs.onDidChangeContent.on(refresh)
    deps.docs.onDidRemove.on(refresh)
    deps.docs.onDidMove.on(refresh)
  }

  focus(selection?: string): void {
    if (selection && !selection.includes('\n')) {
      this.queryInput.value = selection
      this.search()
    }
    this.queryInput.focus()
    this.queryInput.select()
  }

  private search(): void {
    const query = this.queryInput.value
    this.results.replaceChildren()
    this.summary.textContent = ''
    this.last = null
    if (!query) return
    let results: SearchResults
    try {
      results = searchFiles(this.deps.docs.contents(), { query, ...this.options })
    } catch (err) {
      this.summary.textContent = (err as Error).message
      this.summary.classList.add('error')
      return
    }
    this.summary.classList.remove('error')
    this.last = results
    const fileCount = results.files.length
    this.summary.textContent = results.total
      ? `${results.total}${results.truncated ? '+' : ''} result${results.total === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`
      : 'No results found.'

    for (const file of results.files) {
      const open = !this.collapsed.has(file.path)
      const header = h(
        'div',
        {
          class: 'search-file',
          title: file.path,
          attrs: { role: 'treeitem', 'aria-expanded': String(open) },
          onclick: () => {
            if (this.collapsed.has(file.path)) this.collapsed.delete(file.path)
            else this.collapsed.add(file.path)
            this.search()
          },
        },
        icon(open ? 'chevron-down' : 'chevron-right', 'twistie'),
        fileIcon(file.path),
        h('span', { class: 'search-file-name' }, basename(file.path)),
        h('span', { class: 'search-file-dir' }, dirname(file.path).slice(1)),
        h('span', { class: 'badge' }, String(file.matches.length)),
      )
      this.results.append(header)
      if (!open) continue
      for (const match of file.matches) {
        const before = match.preview.slice(0, match.previewOffset)
        const hit = match.preview.slice(match.previewOffset, match.previewOffset + match.length)
        const after = match.preview.slice(match.previewOffset + match.length)
        this.results.append(
          h(
            'div',
            {
              class: 'search-match',
              title: `Line ${match.line}`,
              attrs: { role: 'treeitem' },
              onclick: () => this.deps.onOpen(file.path, match.line, match.column, match.length),
            },
            h('span', { class: 'search-line' }, String(match.line)),
            h('span', { class: 'search-preview' }, before, h('mark', {}, hit), after),
          ),
        )
      }
    }
  }

  private async replaceAll(): Promise<void> {
    const query = this.queryInput.value
    if (!query || !this.last?.total) return
    const replacement = this.replaceInput.value
    const files = this.last.files.map((f) => f.path)
    const ok = await confirmDialog(
      'Replace All',
      `Replace ${this.last.total} occurrence(s) across ${files.length} file(s) with "${replacement}"? Files are left unsaved so you can review or undo.`,
      'Replace',
    )
    if (!ok) return
    const base = buildSearchRegex({ query, ...this.options })
    const regex = new RegExp(base.source, base.flags + 'm')
    for (const path of files) {
      const doc = this.deps.docs.get(path)
      if (!doc) continue
      const text = doc.model.getValue()
      const next = this.options.regex ? text.replace(regex, replacement) : text.replace(regex, () => replacement)
      if (next !== text) this.deps.docs.replaceText(doc, next)
    }
    notify(`Replaced in ${files.length} file(s). Save with Ctrl+S or Save All.`)
    this.search()
  }
}

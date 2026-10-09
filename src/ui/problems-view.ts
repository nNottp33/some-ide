import { Emitter } from '../core/emitter'
import { basename, dirname } from '../core/path'
import type { DocumentManager } from '../editor/documents'
import { monaco } from '../editor/monaco'
import { h, icon } from './dom'
import { fileIcon } from './file-icon'

export interface ProblemCounts {
  errors: number
  warnings: number
}

/** Lists diagnostics (errors/warnings) Monaco's language services report for project files. */
export class ProblemsView {
  readonly element: HTMLElement
  readonly onDidChangeCounts = new Emitter<ProblemCounts>()
  private counts: ProblemCounts = { errors: 0, warnings: 0 }

  constructor(
    private readonly docs: DocumentManager,
    private readonly onOpen: (path: string, line: number, column: number) => void,
  ) {
    this.element = h('div', { class: 'problems', attrs: { role: 'tree', tabindex: '0' } })
    let queued = false
    monaco.editor.onDidChangeMarkers(() => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        this.render()
      })
    })
    this.render()
  }

  get problemCounts(): ProblemCounts {
    return this.counts
  }

  private render(): void {
    const { Error, Warning, Info } = monaco.MarkerSeverity
    const byFile = new Map<string, monaco.editor.IMarker[]>()
    for (const marker of monaco.editor.getModelMarkers({})) {
      if (marker.severity < Info) continue
      const path = this.docs.pathForUri(marker.resource)
      if (!path) continue
      if (!byFile.has(path)) byFile.set(path, [])
      byFile.get(path)!.push(marker)
    }

    const counts = { errors: 0, warnings: 0 }
    const rows: HTMLElement[] = []
    for (const path of [...byFile.keys()].sort()) {
      const markers = byFile.get(path)!.sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber)
      rows.push(
        h(
          'div',
          { class: 'problem-file', title: path },
          fileIcon(path),
          h('span', { class: 'search-file-name' }, basename(path)),
          h('span', { class: 'search-file-dir' }, dirname(path).slice(1)),
          h('span', { class: 'badge' }, String(markers.length)),
        ),
      )
      for (const m of markers) {
        if (m.severity === Error) counts.errors++
        else if (m.severity === Warning) counts.warnings++
        const glyph = m.severity === Error ? 'error' : m.severity === Warning ? 'warning' : 'info'
        rows.push(
          h(
            'div',
            {
              class: `problem severity-${glyph}`,
              attrs: { role: 'treeitem' },
              onclick: () => this.onOpen(path, m.startLineNumber, m.startColumn),
            },
            icon(glyph),
            h('span', { class: 'problem-message' }, m.message.split('\n')[0]),
            h('span', { class: 'problem-source' }, `${m.source ?? m.owner}${m.code ? `(${typeof m.code === 'string' ? m.code : m.code.value})` : ''}`),
            h('span', { class: 'problem-location' }, `[Ln ${m.startLineNumber}, Col ${m.startColumn}]`),
          ),
        )
      }
    }
    this.element.replaceChildren(...(rows.length ? rows : [h('div', { class: 'console-placeholder' }, 'No problems have been detected in the project.')]))
    if (counts.errors !== this.counts.errors || counts.warnings !== this.counts.warnings) {
      this.counts = counts
      this.onDidChangeCounts.emit(counts)
    }
  }
}

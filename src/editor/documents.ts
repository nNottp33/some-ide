import { Emitter } from '../core/emitter'
import { languageForPath } from '../core/languages'
import { isWithin, rebase } from '../core/path'
import type { FsEvent, VirtualFS } from '../core/vfs'
import { monaco } from './monaco'

export interface Document {
  path: string
  model: monaco.editor.ITextModel
  /** Model version that matches the file on disk; -1 when unknown (e.g. moved while dirty). */
  savedVersion: number
}

/**
 * Keeps one Monaco text model per project file, in sync with the virtual file system.
 * Having a model for every file lets the TypeScript service resolve imports across files.
 */
export class DocumentManager {
  private docs = new Map<string, Document>()
  private tabSize = 2
  private byUri = new Map<string, string>()
  private dirtyState = new Map<string, boolean>()

  readonly onDidChangeDirty = new Emitter<{ path: string; dirty: boolean }>()
  readonly onDidChangeContent = new Emitter<{ path: string }>()
  /** Files that moved, after their models have been re-created at the new path. */
  readonly onDidMove = new Emitter<Array<{ from: string; to: string }>>()
  readonly onDidRemove = new Emitter<string[]>()
  readonly onDidReset = new Emitter<void>()

  constructor(private readonly fs: VirtualFS) {
    for (const path of fs.listFiles()) this.create(path, fs.readFile(path))
    fs.onDidChange.on((event) => this.handle(event))
  }

  get(path: string): Document | undefined {
    return this.docs.get(path)
  }

  pathForUri(uri: monaco.Uri): string | undefined {
    return this.byUri.get(uri.toString())
  }

  isDirty(path: string): boolean {
    const doc = this.docs.get(path)
    return !!doc && doc.model.getAlternativeVersionId() !== doc.savedVersion
  }

  dirtyPaths(): string[] {
    return [...this.docs.keys()].filter((p) => this.isDirty(p))
  }

  /** Current text, including unsaved edits. */
  read(path: string): string {
    return this.docs.get(path)?.model.getValue() ?? this.fs.readFile(path)
  }

  /** All files with their current (possibly unsaved) text. */
  *contents(): IterableIterator<[string, string]> {
    for (const [path, doc] of this.docs) yield [path, doc.model.getValue()]
  }

  save(path: string): void {
    const doc = this.docs.get(path)
    if (!doc) return
    this.fs.writeFile(path, doc.model.getValue())
    doc.savedVersion = doc.model.getAlternativeVersionId()
    this.updateDirty(doc)
  }

  saveAll(): void {
    for (const path of this.dirtyPaths()) this.save(path)
  }

  revert(path: string): void {
    const doc = this.docs.get(path)
    if (!doc) return
    this.replaceText(doc, this.fs.readFile(path))
    doc.savedVersion = doc.model.getAlternativeVersionId()
    this.updateDirty(doc)
  }

  /** Unsaved edits, for "hot exit" persistence across reloads. */
  dirtyBuffers(): Record<string, string> {
    return Object.fromEntries(this.dirtyPaths().map((p) => [p, this.docs.get(p)!.model.getValue()]))
  }

  /** Re-applies unsaved edits as undoable changes, leaving the files marked dirty. */
  restoreBuffers(buffers: Record<string, string>): void {
    for (const [path, text] of Object.entries(buffers)) {
      const doc = this.docs.get(path)
      if (doc && doc.model.getValue() !== text) this.replaceText(doc, text)
    }
  }

  setTabSize(tabSize: number): void {
    this.tabSize = tabSize
    for (const doc of this.docs.values()) doc.model.updateOptions({ tabSize, indentSize: tabSize, insertSpaces: true })
  }

  /** Replaces the whole text as a single undoable edit. */
  replaceText(doc: Document, text: string): void {
    doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text }], () => null)
  }

  private create(path: string, content: string, dirtyFrom?: string): Document {
    const uri = monaco.Uri.file(path)
    monaco.editor.getModel(uri)?.dispose()
    const model = monaco.editor.createModel(content, languageForPath(path).id, uri)
    model.updateOptions({ tabSize: this.tabSize, indentSize: this.tabSize, insertSpaces: true })
    const doc: Document = { path, model, savedVersion: model.getAlternativeVersionId() }
    model.onDidChangeContent(() => {
      this.updateDirty(doc)
      this.onDidChangeContent.emit({ path: doc.path })
    })
    this.docs.set(path, doc)
    this.byUri.set(uri.toString(), path)
    this.dirtyState.set(path, false)
    if (dirtyFrom !== undefined && dirtyFrom !== content) {
      // A dirty file was moved: keep the unsaved text and the dirty marker. Done after the
      // listener is attached so the change is reported like any other edit.
      doc.savedVersion = -1
      model.setValue(dirtyFrom)
    }
    return doc
  }

  private dispose(path: string): void {
    const doc = this.docs.get(path)
    if (!doc) return
    this.docs.delete(path)
    this.byUri.delete(doc.model.uri.toString())
    this.dirtyState.delete(path)
    doc.model.dispose()
  }

  private updateDirty(doc: Document): void {
    const dirty = this.isDirty(doc.path)
    if (this.dirtyState.get(doc.path) === dirty) return
    this.dirtyState.set(doc.path, dirty)
    this.onDidChangeDirty.emit({ path: doc.path, dirty })
  }

  private handle(event: FsEvent): void {
    switch (event.type) {
      case 'create':
        if (event.kind === 'file') this.create(event.path, this.fs.readFile(event.path))
        break
      case 'change': {
        const doc = this.docs.get(event.path)
        const content = this.fs.readFile(event.path)
        if (!doc) {
          this.create(event.path, content)
        } else if (doc.model.getValue() !== content && !this.isDirty(event.path)) {
          // Written from outside the editor (upload, import): take the new text.
          this.replaceText(doc, content)
          doc.savedVersion = doc.model.getAlternativeVersionId()
          this.updateDirty(doc)
        }
        break
      }
      case 'delete': {
        const removed = [...this.docs.keys()].filter((p) => isWithin(event.path, p))
        removed.forEach((p) => this.dispose(p))
        if (removed.length) this.onDidRemove.emit(removed)
        break
      }
      case 'rename': {
        const moves: Array<{ from: string; to: string }> = []
        for (const [path, doc] of [...this.docs]) {
          if (!isWithin(event.oldPath, path)) continue
          const to = rebase(path, event.oldPath, event.path)
          const unsaved = this.isDirty(path) ? doc.model.getValue() : undefined
          this.dispose(path)
          this.create(to, this.fs.readFile(to), unsaved)
          moves.push({ from: path, to })
        }
        if (moves.length) this.onDidMove.emit(moves)
        break
      }
      case 'reset':
        for (const path of [...this.docs.keys()]) this.dispose(path)
        for (const path of this.fs.listFiles()) this.create(path, this.fs.readFile(path))
        this.onDidReset.emit()
        break
    }
  }
}

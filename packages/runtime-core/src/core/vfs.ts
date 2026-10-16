import { Emitter } from './emitter'
import { basename, dirname, isWithin, normalize, rebase, validateName } from './path'

export type EntryKind = 'file' | 'dir'

export type FsEvent =
  | { type: 'create'; path: string; kind: EntryKind }
  | { type: 'change'; path: string }
  | { type: 'delete'; path: string; kind: EntryKind }
  | { type: 'rename'; oldPath: string; path: string; kind: EntryKind }
  | { type: 'reset' }

export interface DirEntry {
  name: string
  path: string
  kind: EntryKind
}

export interface ProjectSnapshot {
  files: Record<string, string>
  dirs: string[]
}

export class FsError extends Error {
  override name = 'FsError'
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** In-memory, text-only file system. Persistence is handled elsewhere by listening to `onDidChange`. */
export class VirtualFS {
  private files = new Map<string, string>()
  private dirs = new Set<string>(['/'])
  readonly onDidChange = new Emitter<FsEvent>()

  exists(path: string): boolean {
    const p = normalize(path)
    return this.files.has(p) || this.dirs.has(p)
  }

  isFile(path: string): boolean {
    return this.files.has(normalize(path))
  }

  isDir(path: string): boolean {
    return this.dirs.has(normalize(path))
  }

  kind(path: string): EntryKind | null {
    const p = normalize(path)
    if (this.files.has(p)) return 'file'
    if (this.dirs.has(p)) return 'dir'
    return null
  }

  readFile(path: string): string {
    const content = this.files.get(normalize(path))
    if (content === undefined) throw new FsError(`File not found: ${normalize(path)}`)
    return content
  }

  /** Creates or overwrites a file, creating missing parent folders. */
  writeFile(path: string, content: string): void {
    const p = normalize(path)
    if (p === '/' || this.dirs.has(p)) throw new FsError(`Cannot write to a folder: ${p}`)
    this.mkdir(dirname(p))
    const existed = this.files.has(p)
    if (existed && this.files.get(p) === content) return
    this.files.set(p, content)
    this.onDidChange.emit(existed ? { type: 'change', path: p } : { type: 'create', path: p, kind: 'file' })
  }

  /** Like `writeFile`, but fails if something already exists at `path`. */
  createFile(path: string, content = ''): void {
    const p = normalize(path)
    this.assertValidName(p)
    if (this.exists(p)) throw new FsError(`"${basename(p)}" already exists.`)
    this.writeFile(p, content)
  }

  /** Recursive mkdir. No-op for folders that already exist. */
  mkdir(path: string): void {
    const p = normalize(path)
    if (this.dirs.has(p)) return
    if (this.files.has(p)) throw new FsError(`A file named "${basename(p)}" already exists.`)
    this.mkdir(dirname(p))
    this.dirs.add(p)
    this.onDidChange.emit({ type: 'create', path: p, kind: 'dir' })
  }

  createDir(path: string): void {
    const p = normalize(path)
    this.assertValidName(p)
    if (this.exists(p)) throw new FsError(`"${basename(p)}" already exists.`)
    this.mkdir(p)
  }

  /** Direct children of a folder: folders first, then files, each in natural order. */
  readdir(path: string): DirEntry[] {
    const dir = normalize(path)
    if (!this.dirs.has(dir)) throw new FsError(`Folder not found: ${dir}`)
    const entries: DirEntry[] = []
    const collect = (p: string, kind: EntryKind) => {
      if (p !== dir && dirname(p) === dir) entries.push({ name: basename(p), path: p, kind })
    }
    for (const d of this.dirs) collect(d, 'dir')
    for (const f of this.files.keys()) collect(f, 'file')
    return entries.sort((a, b) =>
      a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1,
    )
  }

  /** Deletes a file or a folder with everything inside it. */
  delete(path: string): void {
    const p = normalize(path)
    if (p === '/') throw new FsError('The project root cannot be deleted.')
    const kind = this.kind(p)
    if (!kind) throw new FsError(`Not found: ${p}`)
    if (kind === 'file') {
      this.files.delete(p)
    } else {
      for (const f of [...this.files.keys()]) if (isWithin(p, f)) this.files.delete(f)
      for (const d of [...this.dirs]) if (isWithin(p, d)) this.dirs.delete(d)
    }
    this.onDidChange.emit({ type: 'delete', path: p, kind })
  }

  /** Renames or moves a file or folder. The destination must not exist yet. */
  rename(from: string, to: string): void {
    const src = normalize(from)
    const dest = normalize(to)
    if (src === dest) return
    if (src === '/') throw new FsError('The project root cannot be renamed.')
    const kind = this.kind(src)
    if (!kind) throw new FsError(`Not found: ${src}`)
    this.assertValidName(dest)
    if (this.exists(dest)) throw new FsError(`"${basename(dest)}" already exists in that location.`)
    if (kind === 'dir' && isWithin(src, dest)) throw new FsError('A folder cannot be moved into itself.')
    if (this.files.has(dirname(dest))) throw new FsError(`"${basename(dirname(dest))}" is a file, not a folder.`)

    // Create the destination parent silently; the rename event covers the visible change.
    for (let d = dirname(dest); !this.dirs.has(d); d = dirname(d)) this.dirs.add(d)

    if (kind === 'file') {
      this.files.set(dest, this.files.get(src)!)
      this.files.delete(src)
    } else {
      for (const [f, content] of [...this.files]) {
        if (!isWithin(src, f)) continue
        this.files.delete(f)
        this.files.set(rebase(f, src, dest), content)
      }
      for (const d of [...this.dirs]) {
        if (!isWithin(src, d)) continue
        this.dirs.delete(d)
        this.dirs.add(rebase(d, src, dest))
      }
    }
    this.onDidChange.emit({ type: 'rename', oldPath: src, path: dest, kind })
  }

  /** All file paths, sorted. */
  listFiles(): string[] {
    return [...this.files.keys()].sort(collator.compare)
  }

  get fileCount(): number {
    return this.files.size
  }

  entries(): IterableIterator<[string, string]> {
    return this.files.entries()
  }

  snapshot(): ProjectSnapshot {
    return {
      files: Object.fromEntries(this.files),
      dirs: [...this.dirs].filter((d) => d !== '/'),
    }
  }

  /** Replaces the whole tree. Emits a single `reset` event. */
  load(snapshot: ProjectSnapshot): void {
    this.files = new Map()
    this.dirs = new Set(['/'])
    for (const d of snapshot.dirs ?? []) {
      for (let p = normalize(d); !this.dirs.has(p); p = dirname(p)) this.dirs.add(p)
    }
    for (const [path, content] of Object.entries(snapshot.files ?? {})) {
      const p = normalize(path)
      for (let d = dirname(p); !this.dirs.has(d); d = dirname(d)) this.dirs.add(d)
      this.files.set(p, content)
    }
    this.onDidChange.emit({ type: 'reset' })
  }

  private assertValidName(path: string): void {
    const error = validateName(basename(path))
    if (error) throw new FsError(error)
  }
}

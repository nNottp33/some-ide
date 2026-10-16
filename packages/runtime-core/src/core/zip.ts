import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { normalize } from './path'
import type { ProjectSnapshot } from './vfs'

/** Heuristic used by git and others: a NUL byte near the start means binary. */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true
  return false
}

export function exportZip(snapshot: ProjectSnapshot): Uint8Array {
  const tree: Zippable = {}
  for (const dir of snapshot.dirs) tree[dir.slice(1) + '/'] = new Uint8Array(0)
  for (const [path, content] of Object.entries(snapshot.files)) tree[path.slice(1)] = strToU8(content)
  return zipSync(tree, { level: 6 })
}

export interface ImportedFiles {
  files: Record<string, string>
  dirs: string[]
  skipped: string[]
}

/**
 * Reads a zip into text files. Binary files are skipped (the editor is text-only), and a
 * single wrapping folder — as in GitHub's "Download ZIP" — is stripped.
 */
export function importZip(data: Uint8Array): ImportedFiles {
  const entries = unzipSync(data)
  const names = Object.keys(entries).filter((n) => !n.startsWith('__MACOSX/') && !n.endsWith('.DS_Store'))

  const tops = new Set(names.map((n) => n.split('/')[0]))
  const [onlyTop] = tops
  const stripPrefix = tops.size === 1 && names.every((n) => n.startsWith(onlyTop + '/')) ? onlyTop + '/' : ''

  const result: ImportedFiles = { files: {}, dirs: [], skipped: [] }
  for (const name of names) {
    const rel = name.slice(stripPrefix.length)
    if (!rel) continue
    const path = normalize(rel)
    if (name.endsWith('/')) {
      result.dirs.push(path)
    } else if (isProbablyBinary(entries[name])) {
      result.skipped.push(path)
    } else {
      result.files[path] = strFromU8(entries[name])
    }
  }
  return result
}

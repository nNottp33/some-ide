/**
 * POSIX-style path helpers for the virtual file system.
 * Every path is absolute and rooted at "/" (e.g. "/src/main.ts").
 */

export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

export function join(...parts: string[]): string {
  return normalize(parts.join('/'))
}

export function dirname(path: string): string {
  const p = normalize(path)
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function basename(path: string): string {
  const p = normalize(path)
  return p.slice(p.lastIndexOf('/') + 1)
}

/** Lower-cased extension including the dot, or "" (dotfiles such as ".gitignore" have none). */
export function extname(path: string): string {
  const base = basename(path)
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i).toLowerCase()
}

/** True when `child` is `parent` itself or lives somewhere below it. */
export function isWithin(parent: string, child: string): boolean {
  const p = normalize(parent)
  const c = normalize(child)
  if (p === '/') return true
  return c === p || c.startsWith(p + '/')
}

/** Re-roots `path` from `from` to `to` (used when a folder is renamed or moved). */
export function rebase(path: string, from: string, to: string): string {
  const p = normalize(path)
  const f = normalize(from)
  if (p === f) return normalize(to)
  return normalize(to + p.slice(f.length))
}

/** Returns an error message for an invalid file/folder name, or null when it is fine. */
export function validateName(name: string): string | null {
  if (!name.trim()) return 'A name is required.'
  if (name.includes('/') || name.includes('\\')) return 'Names cannot contain slashes.'
  if (name === '.' || name === '..') return `"${name}" is not a valid name.`
  if (name !== name.trim()) return 'Names cannot start or end with spaces.'
  return null
}

/** Accepts "a/b/c.txt" relative to a folder and returns the normalized absolute path. */
export function resolveRelative(folder: string, input: string): string {
  return input.startsWith('/') ? normalize(input) : join(folder, input)
}

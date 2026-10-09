import { languageForPath } from '../core/languages'
import { h, icon } from './dom'

/** Colored text badge per language, e.g. "TS" in blue. */
export function fileIcon(path: string): HTMLElement {
  const lang = languageForPath(path)
  return h(
    'span',
    { class: 'file-icon', style: { color: lang.color }, dataset: { len: String(Math.min(lang.badge.length, 3)) } },
    lang.badge,
  )
}

export function folderIcon(open: boolean): HTMLElement {
  return icon(open ? 'folder-opened' : 'folder', 'folder-icon')
}

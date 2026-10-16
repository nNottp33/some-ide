export interface SearchOptions {
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

export interface SearchMatch {
  /** 1-based line and column, as Monaco expects. */
  line: number
  column: number
  length: number
  /** The (possibly trimmed) line text and where the match starts inside it. */
  preview: string
  previewOffset: number
}

export interface FileSearchResult {
  path: string
  matches: SearchMatch[]
}

export interface SearchResults {
  files: FileSearchResult[]
  total: number
  truncated: boolean
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Builds the global regex for a search. Throws a SyntaxError for an invalid user regex. */
export function buildSearchRegex(options: SearchOptions): RegExp {
  let source = options.regex ? options.query : escapeRegExp(options.query)
  if (options.wholeWord) source = `\\b(?:${source})\\b`
  return new RegExp(source, options.caseSensitive ? 'g' : 'gi')
}

const PREVIEW_BEFORE = 30
const PREVIEW_MAX = 160

export function searchText(text: string, regex: RegExp, limit = Infinity): SearchMatch[] {
  const matches: SearchMatch[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    const line = lines[i]
    regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(line)) && matches.length < limit) {
      if (m[0].length === 0) {
        // Zero-length matches (e.g. /^/) would loop forever; skip them.
        regex.lastIndex++
        continue
      }
      const start = Math.max(0, m.index - PREVIEW_BEFORE)
      const leadingTrim = line.slice(start).match(/^\s*/)![0].length
      const from = start + leadingTrim
      matches.push({
        line: i + 1,
        column: m.index + 1,
        length: m[0].length,
        preview: (from > 0 ? '…' : '') + line.slice(from, from + PREVIEW_MAX),
        previewOffset: m.index - from + (from > 0 ? 1 : 0),
      })
    }
  }
  return matches
}

export function searchFiles(files: Iterable<[string, string]>, options: SearchOptions, limit = 2000): SearchResults {
  const results: SearchResults = { files: [], total: 0, truncated: false }
  if (!options.query) return results
  const regex = buildSearchRegex(options)
  const sorted = [...files].sort(([a], [b]) => a.localeCompare(b))
  for (const [path, text] of sorted) {
    if (results.total >= limit) {
      results.truncated = true
      break
    }
    const matches = searchText(text, regex, limit - results.total)
    if (matches.length) {
      results.files.push({ path, matches })
      results.total += matches.length
    }
  }
  return results
}

/**
 * Replaces the matches `searchText` reports — per line, never empty — rather than everything
 * the regex could match across the whole text (`\s+` must not join lines). `regex` must be
 * global. With `expand`, "$1", "$&", "$<name>" etc. in `replacement` work as in
 * String.prototype.replace; otherwise the replacement is literal.
 */
export function replaceInText(text: string, regex: RegExp, replacement: string, expand: boolean): { text: string; count: number } {
  let count = 0
  const parts = text.split(/(\r?\n)/) // line breaks are kept at the odd indices
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(regex, (...args: unknown[]) => {
      const match = args[0] as string
      if (match === '') return ''
      count++
      return expand ? expandReplacement(replacement, args) : replacement
    })
  }
  return { text: parts.join(''), count }
}

/** Expands the "$…" patterns of String.prototype.replace from a replacer's arguments. */
function expandReplacement(replacement: string, args: unknown[]): string {
  const match = args[0] as string
  const last = args[args.length - 1]
  const groups = typeof last === 'object' && last !== null ? (last as Record<string, string | undefined>) : undefined
  const inputIndex = groups ? args.length - 2 : args.length - 1
  const input = args[inputIndex] as string
  const offset = args[inputIndex - 1] as number
  const captures = args.slice(1, inputIndex - 1) as Array<string | undefined>
  return replacement.replace(/\$(?:(\$)|(&)|(`)|(')|<([^>]*)>|(\d{1,2}))/g, (whole, dollar, amp, before, after, name, num) => {
    if (dollar) return '$'
    if (amp) return match
    if (before) return input.slice(0, offset)
    if (after) return input.slice(offset + match.length)
    if (name !== undefined) return groups ? (groups[name] ?? '') : whole
    if (num !== undefined) {
      const n = Number(num)
      if (num.length === 2 && n >= 1 && n <= captures.length) return captures[n - 1] ?? ''
      const d = Number(num[0])
      if (d >= 1 && d <= captures.length) return (captures[d - 1] ?? '') + num.slice(1)
    }
    return whole
  })
}

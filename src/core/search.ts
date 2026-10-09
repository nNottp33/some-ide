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

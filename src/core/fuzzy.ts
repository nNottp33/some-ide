export interface FuzzyMatch {
  score: number
  /** Indices in the target string that matched, for highlighting. */
  positions: number[]
}

const isBoundary = (target: string, i: number): boolean => {
  if (i === 0) return true
  const prev = target[i - 1]
  const ch = target[i]
  if (prev === '/' || prev === '.' || prev === '_' || prev === '-' || prev === ' ') return true
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase() // camelCase hump
}

/**
 * Scores `target` against `query` as an in-order subsequence (like VS Code's quick open).
 * Matches inside the file name, on word boundaries, and in consecutive runs score higher.
 * Returns null when not every query character can be matched.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, '').toLowerCase()
  if (!q) return { score: 0, positions: [] }
  const t = target.toLowerCase()
  const nameStart = target.lastIndexOf('/') + 1

  // Prefer matching inside the file name: try a match that starts at the name first.
  const attempts = [nameStart, 0]
  let best: FuzzyMatch | null = null
  for (const start of attempts) {
    const positions: number[] = []
    let ti = start
    for (const ch of q) {
      const found = t.indexOf(ch, ti)
      if (found === -1) break
      positions.push(found)
      ti = found + 1
    }
    if (positions.length !== q.length) continue

    let score = 0
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i]
      score += 1
      if (isBoundary(target, pos)) score += 8
      if (i > 0 && positions[i - 1] === pos - 1) score += 5
      if (pos >= nameStart) score += 3
    }
    if (t.slice(nameStart).startsWith(q)) score += 20
    score -= target.length * 0.05
    if (!best || score > best.score) best = { score, positions }
  }
  return best
}

/** Filters and sorts `items` by fuzzy score against `query`. */
export function fuzzyFilter<T>(query: string, items: T[], key: (item: T) => string): Array<{ item: T } & FuzzyMatch> {
  const results: Array<{ item: T } & FuzzyMatch> = []
  for (const item of items) {
    const match = fuzzyMatch(query, key(item))
    if (match) results.push({ item, ...match })
  }
  return results.sort((a, b) => b.score - a.score)
}

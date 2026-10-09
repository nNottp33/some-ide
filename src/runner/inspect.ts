/**
 * Formats any JS value for the console, similar to Node's `util.inspect`.
 *
 * This function must stay fully self-contained (no imports, no references to module
 * scope): the HTML preview injects it into the page with `inspect.toString()`.
 */
export function inspect(value: unknown, nested = false): string {
  const MAX_DEPTH = 4
  const MAX_ITEMS = 100
  const BREAK_LENGTH = 72
  const seen: unknown[] = []

  const quote = (s: string) =>
    "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t') + "'"

  const keyName = (k: string | symbol) =>
    typeof k === 'symbol' ? '[' + k.toString() + ']' : /^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)

  const wrap = (open: string, parts: string[], close: string, indent: string) => {
    if (parts.length === 0) return open + close
    const oneLine = open + ' ' + parts.join(', ') + ' ' + close
    if (oneLine.length <= BREAK_LENGTH && !oneLine.includes('\n')) return oneLine
    const inner = indent + '  '
    return open + '\n' + parts.map((p) => inner + p).join(',\n') + '\n' + indent + close
  }

  const fmt = (v: unknown, depth: number, isNested: boolean, indent: string): string => {
    switch (typeof v) {
      case 'string':
        return isNested ? quote(v) : v
      case 'number':
        return Object.is(v, -0) ? '-0' : String(v)
      case 'bigint':
        return String(v) + 'n'
      case 'symbol':
        return v.toString()
      case 'undefined':
        return 'undefined'
      case 'boolean':
        return String(v)
      case 'function': {
        const src = Function.prototype.toString.call(v)
        if (/^class[\s{]/.test(src)) return '[class ' + (v.name || '(anonymous)') + ']'
        return v.name ? '[Function: ' + v.name + ']' : '[Function (anonymous)]'
      }
    }
    if (v === null) return 'null'
    const obj = v as Record<string | symbol, unknown>

    if (obj instanceof Error) {
      const head = obj.name + ': ' + obj.message
      if (isNested) return '[' + head + ']'
      const stack = typeof obj.stack === 'string' ? obj.stack : ''
      return stack.includes(obj.message) ? stack : head + (stack ? '\n' + stack : '')
    }
    if (obj instanceof Date) return isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString()
    if (obj instanceof RegExp) return String(obj)
    if (typeof Promise !== 'undefined' && obj instanceof Promise) return 'Promise { <pending> }'
    if (typeof WeakMap !== 'undefined' && (obj instanceof WeakMap || obj instanceof WeakSet)) {
      return (obj instanceof WeakMap ? 'WeakMap' : 'WeakSet') + ' { <items unknown> }'
    }
    if (typeof Node !== 'undefined' && obj instanceof Node) {
      const html = (obj as unknown as Element).outerHTML
      return typeof html === 'string' ? (html.length > 200 ? html.slice(0, 200) + '…' : html) : obj.nodeName
    }

    if (seen.includes(obj)) return '[Circular]'
    const isArray = Array.isArray(obj)
    if (depth > MAX_DEPTH) return isArray ? '[Array]' : '[Object]'

    seen.push(obj)
    try {
      const childIndent = indent + '  '
      const child = (x: unknown) => fmt(x, depth + 1, true, childIndent)
      const parts: string[] = []
      const limited = (count: number) => {
        if (count > MAX_ITEMS) parts.push('... ' + (count - MAX_ITEMS) + ' more items')
      }

      if (isArray) {
        const arr = obj as unknown as unknown[]
        for (let i = 0; i < Math.min(arr.length, MAX_ITEMS); i++) parts.push(i in arr ? child(arr[i]) : '<empty>')
        limited(arr.length)
        return wrap('[', parts, ']', indent)
      }
      if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
        const typed = obj as unknown as ArrayLike<number | bigint>
        for (let i = 0; i < Math.min(typed.length, MAX_ITEMS); i++) parts.push(child(typed[i]))
        limited(typed.length)
        return wrap(obj.constructor.name + '(' + typed.length + ') [', parts, ']', indent)
      }
      if (obj instanceof Map) {
        let i = 0
        for (const [k, val] of obj) {
          if (i++ >= MAX_ITEMS) break
          parts.push(child(k) + ' => ' + child(val))
        }
        limited(obj.size)
        return wrap('Map(' + obj.size + ') {', parts, '}', indent)
      }
      if (obj instanceof Set) {
        let i = 0
        for (const val of obj) {
          if (i++ >= MAX_ITEMS) break
          parts.push(child(val))
        }
        limited(obj.size)
        return wrap('Set(' + obj.size + ') {', parts, '}', indent)
      }

      const keys: Array<string | symbol> = [...Object.keys(obj), ...Object.getOwnPropertySymbols(obj)]
      for (const k of keys.slice(0, MAX_ITEMS)) {
        let shown: string
        try {
          shown = child(obj[k])
        } catch {
          shown = '[Getter]'
        }
        parts.push(keyName(k) + ': ' + shown)
      }
      limited(keys.length)
      const proto = Object.getPrototypeOf(obj)
      const ctor = proto && proto.constructor && proto.constructor.name
      const prefix = proto === null ? '[Object: null prototype] ' : ctor && ctor !== 'Object' ? ctor + ' ' : ''
      return prefix + wrap('{', parts, '}', indent)
    } finally {
      seen.pop()
    }
  }

  return fmt(value, 0, nested, '')
}

/**
 * Formats console arguments the way browsers/Node do, including %s %d %i %f %o %O %c.
 * `inspectFn` is a parameter (not a module reference) so this can be injected with toString().
 */
export function formatArgs(args: unknown[], inspectFn: (value: unknown, nested?: boolean) => string = inspect): string {
  if (typeof args[0] === 'string' && /%[sdifoOc%]/.test(args[0])) {
    const rest = args.slice(1)
    const head = args[0].replace(/%([sdifoOc%])/g, (m, f: string) => {
      if (f === '%') return '%'
      if (!rest.length) return m
      const v = rest.shift()
      switch (f) {
        case 's':
          return typeof v === 'string' ? v : inspectFn(v, true)
        case 'd':
        case 'i':
          return String(f === 'i' ? Math.trunc(Number(v)) : Number(v))
        case 'f':
          return String(Number(v))
        case 'c':
          return '' // CSS styling is ignored
        default:
          return inspectFn(v, true)
      }
    })
    return [head, ...rest.map((a) => inspectFn(a))].join(' ')
  }
  return args.map((a) => inspectFn(a)).join(' ')
}

/** Renders `console.table` data as a box-drawn text table. Returns null for non-objects. */
export function formatTable(data: unknown, only?: string[]): string | null {
  if (data === null || typeof data !== 'object') return null
  const rows: Array<[string, unknown]> =
    data instanceof Map
      ? [...data.entries()].map(([k, v]) => [inspect(k, true), v])
      : data instanceof Set
        ? [...data].map((v, i) => [String(i), v])
        : Object.entries(data)
  const columns: string[] = []
  let hasValues = false
  for (const [, value] of rows) {
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) if (!columns.includes(key)) columns.push(key)
    } else {
      hasValues = true
    }
  }
  const shown = only ? columns.filter((c) => only.includes(c)) : columns
  const header = ['(index)', ...shown, ...(hasValues ? ['Values'] : [])]
  const body = rows.map(([index, value]) => {
    const isObj = value !== null && typeof value === 'object'
    const cells = shown.map((c) =>
      isObj && c in (value as object) ? inspect((value as Record<string, unknown>)[c], true) : '',
    )
    return [index, ...cells, ...(hasValues ? [isObj ? '' : inspect(value, true)] : [])]
  })
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)) + 2)
  const line = (l: string, m: string, r: string) => l + widths.map((w) => '─'.repeat(w)).join(m) + r
  const row = (cells: string[]) => '│' + cells.map((c, i) => ' ' + c.padEnd(widths[i] - 1)).join('│') + '│'
  return [line('┌', '┬', '┐'), row(header), line('├', '┼', '┤'), ...body.map(row), line('└', '┴', '┘')].join('\n')
}

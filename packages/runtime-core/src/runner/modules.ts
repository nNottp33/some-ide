/**
 * Turns project files into runnable ES modules: transpiles TS/JSX with sucrase, resolves
 * relative imports inside the project, and maps bare imports (npm packages) to esm.sh.
 */
import { init as initLexer, parse, type Import } from 'es-module-lexer'
import { transform, type Transform } from 'sucrase'
import { dirname, extname, join, normalize } from '../core/path'

export const ESM_CDN = 'https://esm.sh/'

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.json']

export class ModuleError extends Error {
  override name = 'ModuleError'
}

export const isRelativeSpecifier = (spec: string) =>
  spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')

/** "https:", "data:", "blob:", "node:"… anything with a URL scheme. */
export const isUrlSpecifier = (spec: string) => /^[a-z][a-z0-9+.-]*:/i.test(spec)

/** Resolves an import like Vite/TypeScript would: exact, then extensions, then index files. */
export function resolveModulePath(fromFile: string, spec: string, has: (path: string) => boolean): string | null {
  const base = spec.startsWith('/') ? normalize(spec) : join(dirname(fromFile), spec)
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((ext) => base + ext)]
  // TypeScript convention: "./util.js" may refer to "./util.ts".
  const jsExt = /\.(m?)jsx?$/.exec(base)
  if (jsExt) {
    const stem = base.slice(0, -jsExt[0].length)
    candidates.push(stem + (jsExt[1] ? '.mts' : '.ts'), stem + '.tsx')
  }
  candidates.push(...RESOLVE_EXTENSIONS.map((ext) => base + '/index' + ext))
  return candidates.find((c) => has(c)) ?? null
}

/** Position helper for error messages: converts a string offset to 1-based line/column. */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return { line, column: offset - before.lastIndexOf('\n') }
}

export type ModuleTarget = 'browser' | 'worker'

/** Converts one project file into ES module source code. */
export function transpileModule(path: string, source: string, target: ModuleTarget): string {
  const ext = extname(path)
  switch (ext) {
    case '.js':
    case '.mjs':
      return source
    case '.json':
      try {
        JSON.parse(source)
      } catch (err) {
        throw new ModuleError(`Invalid JSON in ${path}: ${(err as Error).message}`)
      }
      return `export default ${source.trim()};`
    case '.css':
      return target === 'browser'
        ? `const style = document.createElement('style');\nstyle.dataset.file = ${JSON.stringify(path)};\n` +
            `style.textContent = ${JSON.stringify(source)};\ndocument.head.appendChild(style);\n` +
            `export default ${JSON.stringify(source)};`
        : `export default ${JSON.stringify(source)};`
    case '.ts':
    case '.mts':
    case '.tsx':
    case '.jsx': {
      const transforms: Transform[] = ext === '.jsx' ? ['jsx'] : ext === '.tsx' ? ['typescript', 'jsx'] : ['typescript']
      try {
        return transform(source, {
          transforms,
          filePath: path,
          disableESTransforms: true,
          jsxRuntime: 'automatic',
          jsxImportSource: 'react',
          production: true,
        }).code
      } catch (err) {
        // sucrase reports "Unexpected token (3:14)"; rewrite into a clickable location.
        const message = (err as Error).message
        const pos = /\((\d+):(\d+)\)\s*$/.exec(message)
        const where = pos ? `${path}:${pos[1]}:${Number(pos[2]) + 1}` : path
        throw new ModuleError(`SyntaxError: ${message.replace(/\s*\(\d+:\d+\)\s*$/, '')}\n    at ${where}`)
      }
    }
    default:
      // Any other file can still be imported, as a string.
      return `export default ${JSON.stringify(source)};`
  }
}

/**
 * Imports whose specifier is a literal string. `import(\`./locales/${lang}.js\`)` is reported
 * as a glob ("./locales/*.js") and must be left for the runtime to resolve.
 */
const isLinkable = (imp: Import): imp is Import & { specifier: string } =>
  imp.type !== 'import-meta' && imp.specifier != null && !(imp.type === 'dynamic' && imp.glob)

/**
 * Rewrites import specifiers in `code`. `map` returns the new specifier, or null to keep it.
 * JSON import attributes are dropped because JSON files are converted to JS modules.
 */
export function rewriteImports(code: string, imports: readonly Import[], map: (spec: string) => string | null): string {
  let out = code
  const ordered = [...imports].sort((a, b) => b.start - a.start)
  for (const imp of ordered) {
    if (!isLinkable(imp)) continue
    const replacement = map(imp.specifier)
    if (replacement == null) continue
    const quoted = JSON.stringify(replacement)
    if (imp.type === 'dynamic') {
      out = out.slice(0, imp.start) + quoted + out.slice(imp.end)
    } else {
      const isJson = imp.attributes?.some(([k, v]) => k === 'type' && v === 'json')
      const tail = isJson ? imp.importEnd : imp.end + 1
      out = out.slice(0, imp.start - 1) + quoted + out.slice(tail)
    }
  }
  return out
}

export interface LinkOptions {
  files: ReadonlyMap<string, string>
  entry: string
  target: ModuleTarget
  /**
   * Called once per module, dependencies first, with its final code. Returns the
   * specifier other modules should import it by (a blob: URL, an import-map key, …).
   */
  emit: (path: string, code: string) => string
  /**
   * Where a bare import such as 'lodash' comes from. Defaults to esm.sh; return null to leave
   * the specifier alone (e.g. when the page's own import map already defines it).
   */
  resolveBare?: (specifier: string) => string | null
}

/** Links the module graph rooted at `entry` and returns the entry's specifier. */
export async function linkModules({ files, entry, target, emit, resolveBare }: LinkOptions): Promise<string> {
  await initLexer()
  const linked = new Map<string, string>()
  const stack: string[] = []

  const visit = (path: string): string => {
    const done = linked.get(path)
    if (done) return done
    if (stack.includes(path)) {
      const cycle = [...stack.slice(stack.indexOf(path)), path].join(' → ')
      throw new ModuleError(`Circular imports are not supported yet: ${cycle}`)
    }
    const source = files.get(path)
    if (source === undefined) throw new ModuleError(`File not found: ${path}`)

    stack.push(path)
    const code = transpileModule(path, source, target)
    let imports: readonly Import[]
    try {
      imports = parse(code, path)[0]
    } catch (err) {
      const idx = (err as { idx?: number }).idx
      const where = idx == null ? path : `${path}:${lineColumnAt(code, idx).line}:${lineColumnAt(code, idx).column}`
      throw new ModuleError(`SyntaxError: could not parse module\n    at ${where}`)
    }
    // Link dependencies in source order, then rewrite the specifiers.
    const replacements = new Map<string, string | null>()
    for (const imp of imports) {
      if (!isLinkable(imp)) continue
      const spec = imp.specifier
      if (replacements.has(spec)) continue
      if (isUrlSpecifier(spec)) {
        replacements.set(spec, null)
      } else if (isRelativeSpecifier(spec)) {
        const resolved = resolveModulePath(path, spec, (p) => files.has(p))
        if (!resolved) throw new ModuleError(`Cannot find module '${spec}' imported from ${path}`)
        replacements.set(spec, visit(resolved))
      } else {
        replacements.set(spec, resolveBare ? resolveBare(spec) : ESM_CDN + spec)
      }
    }
    const rewritten = rewriteImports(code, imports, (spec) => replacements.get(spec) ?? null)
    stack.pop()

    const specifier = emit(path, `${rewritten}\n//# sourceURL=${path}`)
    linked.set(path, specifier)
    return specifier
  }

  return visit(normalize(entry))
}

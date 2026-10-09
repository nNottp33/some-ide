// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildPreview } from '../src/runner/html'
import { formatArgs, formatTable, inspect } from '../src/runner/inspect'
import { ESM_CDN, linkModules, ModuleError, resolveModulePath, transpileModule } from '../src/runner/modules'

describe('inspect', () => {
  it('formats values like Node', () => {
    expect(inspect('top')).toBe('top')
    expect(inspect('nested', true)).toBe("'nested'")
    expect(inspect([1, 'a', null, undefined])).toBe("[ 1, 'a', null, undefined ]")
    expect(inspect({ a: 1, 'b-c': [true] })).toBe("{ a: 1, 'b-c': [ true ] }")
    expect(inspect(new Map([['k', 1]]))).toBe("Map(1) { 'k' => 1 }")
    expect(inspect(new Set([1, 2]))).toBe('Set(2) { 1, 2 }')
    expect(inspect(10n)).toBe('10n')
    expect(inspect(-0)).toBe('-0')
    expect(inspect(function named() {})).toBe('[Function: named]')
    expect(inspect(class Foo {})).toBe('[class Foo]')
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    expect(inspect(new Point(1, 2))).toBe('Point { x: 1, y: 2 }')
  })

  it('handles cycles, depth and long output', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(inspect(a)).toBe("{ name: 'a', self: [Circular] }")
    expect(inspect({ l1: { l2: { l3: { l4: { l5: { l6: 1 } } } } } })).toContain('[Object]')
    const long = inspect(Array.from({ length: 150 }, (_, i) => i))
    expect(long).toContain('... 50 more items')
    expect(long.split('\n').length).toBeGreaterThan(1)
  })

  it('is self-contained so it can be injected with toString()', () => {
    const revived = new Function(`return (${inspect.toString()})`)() as typeof inspect
    expect(revived({ a: [1] })).toBe('{ a: [ 1 ] }')
    const format = new Function(`return (${formatArgs.toString()})`)() as typeof formatArgs
    expect(format(['%s is %d', 'x', 42], revived)).toBe('x is 42')
  })

  it('formats printf-style arguments and tables', () => {
    expect(formatArgs(['%s=%i%%', 'n', 4.7])).toBe('n=4%')
    expect(formatArgs(['%c styled', 'color: red'])).toBe(' styled')
    expect(formatArgs(['a', { b: 1 }])).toBe('a { b: 1 }')
    const table = formatTable([{ a: 1 }, { a: 2, b: 'x' }])!
    expect(table.split('\n')[1]).toBe('│ (index) │ a │ b   │')
    expect(formatTable(5)).toBeNull()
  })
})

describe('modules', () => {
  const files = new Map(
    Object.entries({
      '/src/main.ts': "import { add } from './math'\nimport data from '../data.json'\nimport confetti from 'canvas-confetti'\nconsole.log(add(1, 2), data, confetti)",
      '/src/math.ts': 'export const add = (a: number, b: number): number => a + b',
      '/data.json': '{ "ok": true }',
      '/lib/index.js': 'export default 1',
      '/a.ts': "import './b'",
      '/b.ts': "import './a'",
      '/bad.ts': 'const = 1',
    }),
  )
  const has = (p: string) => files.has(p)

  it('resolves like a bundler', () => {
    expect(resolveModulePath('/src/main.ts', './math', has)).toBe('/src/math.ts')
    expect(resolveModulePath('/src/main.ts', './math.js', has)).toBe('/src/math.ts')
    expect(resolveModulePath('/src/main.ts', '../lib', has)).toBe('/lib/index.js')
    expect(resolveModulePath('/src/main.ts', '/data.json', has)).toBe('/data.json')
    expect(resolveModulePath('/src/main.ts', './nope', has)).toBeNull()
  })

  it('transpiles TypeScript, JSX, JSON and CSS', () => {
    expect(transpileModule('/a.ts', 'const x: number = 1', 'worker')).toBe('const x = 1')
    expect(transpileModule('/a.jsx', 'export const A = () => <b>hi</b>', 'browser')).toContain('react/jsx-runtime')
    expect(transpileModule('/a.json', '{"a":1}', 'worker')).toBe('export default {"a":1};')
    expect(transpileModule('/a.css', 'b{}', 'browser')).toContain('document.head.appendChild')
    expect(() => transpileModule('/bad.json', '{', 'worker')).toThrow(/Invalid JSON/)
  })

  it('reports syntax errors with a clickable location', () => {
    expect(() => transpileModule('/bad.ts', files.get('/bad.ts')!, 'worker')).toThrow(/at \/bad\.ts:1:\d+/)
  })

  it('links a module graph, dependencies first', async () => {
    const emitted: Array<[string, string]> = []
    const entry = await linkModules({
      files,
      entry: '/src/main.ts',
      target: 'worker',
      emit: (path, code) => {
        emitted.push([path, code])
        return `mod:${path}`
      },
    })
    expect(entry).toBe('mod:/src/main.ts')
    expect(emitted.map(([p]) => p)).toEqual(['/src/math.ts', '/data.json', '/src/main.ts'])
    const main = emitted.at(-1)![1]
    expect(main).toContain('"mod:/src/math.ts"')
    expect(main).toContain('"mod:/data.json"')
    expect(main).toContain(`"${ESM_CDN}canvas-confetti"`)
    expect(main).toContain('//# sourceURL=/src/main.ts')
  })

  it('rejects cycles and missing files', async () => {
    const link = (entry: string) => linkModules({ files, entry, target: 'worker', emit: (p) => p })
    await expect(link('/a.ts')).rejects.toThrow(/Circular imports.*\/a\.ts → \/b\.ts → \/a\.ts/)
    const missing = new Map(files).set('/m.ts', "import './gone'")
    await expect(linkModules({ files: missing, entry: '/m.ts', target: 'worker', emit: (p) => p })).rejects.toThrow(ModuleError)
  })
})

describe('buildPreview', () => {
  const files = new Map(
    Object.entries({
      '/index.html':
        '<!doctype html><html><head><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://cdn.example/x.css"></head>' +
        '<body><img src="logo.svg"><script src="classic.js"></script><script type="module" src="./src/app.ts"></script>' +
        '<script type="module">import { x } from "./src/util.js"; console.log(x)</script></body></html>',
      '/style.css': 'body { color: red }',
      '/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '/classic.js': 'console.log("</script>")',
      '/src/app.ts': "import { x } from './util'\nconst n: number = x",
      '/src/util.js': 'export const x = 1',
    }),
  )

  it('inlines local assets and links modules through an import map', async () => {
    const { html, warnings } = await buildPreview(files, '/index.html')
    expect(warnings).toEqual([])
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('style[data-file="/style.css"]')?.textContent).toBe('body { color: red }')
    expect(doc.querySelector('link[href="https://cdn.example/x.css"]')).not.toBeNull()
    expect(doc.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)

    const importMap = JSON.parse(doc.querySelector('script[type="importmap"]')!.textContent!)
    expect(Object.keys(importMap.imports).sort()).toEqual(['@project/index.html.inline-1.js', '@project/src/app.ts', '@project/src/util.js'])
    const app = decodeURIComponent(importMap.imports['@project/src/app.ts'].split(',')[1])
    expect(app).toContain('import { x } from "@project/src/util.js"')
    expect(app).not.toContain(': number')

    const scripts = [...doc.querySelectorAll('body script')].map((s) => s.textContent)
    expect(scripts[0]).toContain('<\\/script>')
    expect(scripts[1]).toBe('import "@project/src/app.ts";')
    // The console/fetch bridge comes first in <head>, then the import map.
    expect(doc.head.firstElementChild?.textContent).toContain('some-ide-preview')
  })

  it('warns about missing local files', async () => {
    const { warnings } = await buildPreview(new Map([['/index.html', '<script src="missing.js"></script>']]), '/index.html')
    expect(warnings).toEqual(['/index.html: cannot find "missing.js"'])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { fuzzyFilter, fuzzyMatch } from '../src/core/fuzzy'
import { languageForPath, runtimeForPath } from '../src/core/languages'
import { basename, dirname, extname, isWithin, join, normalize, rebase, resolveRelative, validateName } from '../src/core/path'
import { buildSearchRegex, searchFiles, searchText } from '../src/core/search'
import { FsError, VirtualFS, type FsEvent } from '../src/core/vfs'
import { exportZip, importZip, isProbablyBinary } from '../src/core/zip'
import { strToU8, zipSync } from 'fflate'

describe('path', () => {
  it('normalizes', () => {
    expect(normalize('a/b/../c/./d')).toBe('/a/c/d')
    expect(normalize('/../..')).toBe('/')
    expect(normalize('//a//b/')).toBe('/a/b')
    expect(join('/src', '../lib', 'x.ts')).toBe('/lib/x.ts')
  })

  it('splits paths', () => {
    expect(dirname('/src/main.ts')).toBe('/src')
    expect(dirname('/main.ts')).toBe('/')
    expect(basename('/src/main.ts')).toBe('main.ts')
    expect(extname('/src/Main.TS')).toBe('.ts')
    expect(extname('/.gitignore')).toBe('')
    expect(extname('/archive.tar.gz')).toBe('.gz')
  })

  it('checks containment and re-roots paths', () => {
    expect(isWithin('/src', '/src/a/b.ts')).toBe(true)
    expect(isWithin('/src', '/src')).toBe(true)
    expect(isWithin('/src', '/srcfoo/a.ts')).toBe(false)
    expect(isWithin('/', '/anything')).toBe(true)
    expect(rebase('/src/a/b.ts', '/src', '/lib')).toBe('/lib/a/b.ts')
    expect(resolveRelative('/src', 'util/x.ts')).toBe('/src/util/x.ts')
    expect(resolveRelative('/src', '/x.ts')).toBe('/x.ts')
  })

  it('validates names', () => {
    expect(validateName('ok.ts')).toBeNull()
    expect(validateName('ไฟล์.txt')).toBeNull()
    expect(validateName('')).toMatch(/required/)
    expect(validateName('a/b')).toMatch(/slash/)
    expect(validateName('..')).toMatch(/not a valid/)
    expect(validateName(' x')).toMatch(/spaces/)
  })
})

describe('VirtualFS', () => {
  const setup = () => {
    const fs = new VirtualFS()
    const events: FsEvent[] = []
    fs.onDidChange.on((e) => events.push(e))
    return { fs, events }
  }

  it('writes files and creates parent folders', () => {
    const { fs, events } = setup()
    fs.writeFile('/a/b/c.txt', 'hi')
    expect(fs.isDir('/a')).toBe(true)
    expect(fs.isDir('/a/b')).toBe(true)
    expect(fs.readFile('/a/b/c.txt')).toBe('hi')
    expect(events.map((e) => e.type)).toEqual(['create', 'create', 'create'])
    fs.writeFile('/a/b/c.txt', 'hi')
    expect(events).toHaveLength(3) // unchanged content: no event
    fs.writeFile('/a/b/c.txt', 'bye')
    expect(events.at(-1)).toEqual({ type: 'change', path: '/a/b/c.txt' })
  })

  it('lists folders first in natural order', () => {
    const { fs } = setup()
    for (const f of ['/b.txt', '/file10.txt', '/file2.txt', '/z/x.txt', '/a/y.txt']) fs.writeFile(f, '')
    expect(fs.readdir('/').map((e) => e.name)).toEqual(['a', 'z', 'b.txt', 'file2.txt', 'file10.txt'])
  })

  it('refuses invalid operations', () => {
    const { fs } = setup()
    fs.writeFile('/a.txt', '')
    expect(() => fs.createFile('/a.txt')).toThrow(FsError)
    expect(() => fs.mkdir('/a.txt')).toThrow(/already exists/)
    expect(() => fs.writeFile('/a.txt/x', '')).toThrow(FsError)
    expect(() => fs.delete('/')).toThrow(/root/)
    expect(() => fs.readFile('/missing')).toThrow(/not found/)
    expect(() => fs.createFile('/bad\\name')).toThrow(/slashes/)
  })

  it('renames folders with their contents', () => {
    const { fs, events } = setup()
    fs.writeFile('/src/a.ts', 'A')
    fs.writeFile('/src/deep/b.ts', 'B')
    fs.rename('/src', '/lib/src2')
    expect(fs.listFiles()).toEqual(['/lib/src2/a.ts', '/lib/src2/deep/b.ts'])
    expect(fs.isDir('/src')).toBe(false)
    expect(fs.isDir('/lib')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'rename', oldPath: '/src', path: '/lib/src2', kind: 'dir' })
    expect(() => fs.rename('/lib', '/lib/src2/inner')).toThrow(/into itself/)
    fs.writeFile('/x.ts', '')
    expect(() => fs.rename('/x.ts', '/lib/src2/a.ts')).toThrow(/already exists/)
  })

  it('deletes recursively and round-trips snapshots', () => {
    const { fs } = setup()
    fs.writeFile('/src/a.ts', 'A')
    fs.mkdir('/empty')
    const snap = fs.snapshot()
    fs.delete('/src')
    expect(fs.exists('/src/a.ts')).toBe(false)

    const listener = vi.fn()
    fs.onDidChange.on(listener)
    fs.load(snap)
    expect(listener).toHaveBeenCalledWith({ type: 'reset' })
    expect(fs.readFile('/src/a.ts')).toBe('A')
    expect(fs.isDir('/empty')).toBe(true)
  })
})

describe('fuzzy', () => {
  it('matches subsequences and prefers file names', () => {
    expect(fuzzyMatch('mts', 'src/main.ts')).not.toBeNull()
    expect(fuzzyMatch('xyz', 'src/main.ts')).toBeNull()
    const ranked = fuzzyFilter('main', ['main/other.ts', 'src/main.ts', 'domain-info.md'], (s) => s)
    expect(ranked[0].item).toBe('src/main.ts')
  })

  it('returns highlight positions', () => {
    const m = fuzzyMatch('gr', 'src/greet.ts')!
    expect(m.positions).toEqual([4, 5])
  })
})

describe('search', () => {
  it('finds matches with previews', () => {
    const regex = buildSearchRegex({ query: 'greet' })
    const matches = searchText("import { greet } from './greet'\n\nGreet()", regex)
    expect(matches.map((m) => [m.line, m.column])).toEqual([
      [1, 10],
      [1, 26],
      [3, 1],
    ])
    const [first] = matches
    expect(first.preview.slice(first.previewOffset, first.previewOffset + first.length)).toBe('greet')
  })

  it('supports case, whole word and regex options', () => {
    const files: Array<[string, string]> = [
      ['/b.ts', 'foo food Foo'],
      ['/a.ts', 'foo'],
    ]
    expect(searchFiles(files, { query: 'foo' }).total).toBe(4)
    expect(searchFiles(files, { query: 'foo', caseSensitive: true }).total).toBe(3)
    expect(searchFiles(files, { query: 'foo', wholeWord: true }).total).toBe(3)
    expect(searchFiles(files, { query: 'fo+d', regex: true }).total).toBe(1)
    expect(searchFiles(files, { query: 'foo' }).files.map((f) => f.path)).toEqual(['/a.ts', '/b.ts'])
    expect(() => searchFiles(files, { query: '(', regex: true })).toThrow(SyntaxError)
  })

  it('does not loop on zero-length matches and respects limits', () => {
    expect(searchText('abc', buildSearchRegex({ query: '^', regex: true }))).toEqual([])
    const big: Array<[string, string]> = [['/x', 'a\n'.repeat(50)]]
    const results = searchFiles(big, { query: 'a' }, 10)
    expect(results.total).toBe(10)
  })
})

describe('zip', () => {
  it('round-trips a project', () => {
    const data = exportZip({ files: { '/src/a.ts': 'A', '/README.md': 'ไทย' }, dirs: ['/src', '/empty'] })
    const back = importZip(data)
    expect(back.files).toEqual({ '/src/a.ts': 'A', '/README.md': 'ไทย' })
    expect(back.dirs).toEqual(expect.arrayContaining(['/src', '/empty']))
  })

  it('strips a single wrapping folder and skips binaries', () => {
    const data = zipSync({
      'repo-main/': new Uint8Array(0),
      'repo-main/index.html': strToU8('<h1>hi</h1>'),
      'repo-main/logo.png': new Uint8Array([137, 80, 78, 71, 0, 0, 1]),
    })
    const result = importZip(data)
    expect(result.files).toEqual({ '/index.html': '<h1>hi</h1>' })
    expect(result.skipped).toEqual(['/logo.png'])
    expect(isProbablyBinary(strToU8('plain text'))).toBe(false)
  })
})

describe('languages', () => {
  it('maps files to languages and runtimes', () => {
    expect(languageForPath('/a.ts').id).toBe('typescript')
    expect(languageForPath('/Dockerfile').id).toBe('dockerfile')
    expect(languageForPath('/notes').id).toBe('plaintext')
    expect(runtimeForPath('/a.tsx')).toBe('javascript')
    expect(runtimeForPath('/a.py')).toBe('python')
    expect(runtimeForPath('/a.htm')).toBe('html')
    expect(runtimeForPath('/a.css')).toBeNull()
  })
})

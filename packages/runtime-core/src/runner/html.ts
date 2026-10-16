/**
 * Builds a self-contained HTML document for the live preview.
 *
 * The preview runs in a sandboxed iframe (opaque origin), so it cannot fetch project files
 * by URL. Instead, local stylesheets and scripts are inlined, ES modules are linked through
 * an import map of data: URLs, and a small bridge script forwards console output to the IDE,
 * serves fetch() calls for project files, and handles links to other project pages.
 */
import { dirname, extname, join, normalize } from '../core/path'
import { formatArgs, inspect } from './inspect'
import { ESM_CDN, isUrlSpecifier, linkModules } from './modules'

const PROJECT_PREFIX = '@project'

interface ImportMapJson {
  imports?: Record<string, string>
  scopes?: Record<string, Record<string, string>>
  integrity?: Record<string, string>
}

/** Import-map matching: an exact key, or the longest key ending in "/" that prefixes `spec`. */
export function importMapDefines(imports: Record<string, string>, spec: string): boolean {
  if (Object.prototype.hasOwnProperty.call(imports, spec)) return true
  return Object.keys(imports).some((key) => key.endsWith('/') && spec.startsWith(key))
}

export interface PreviewBuild {
  html: string
  warnings: string[]
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
}
export const mimeFor = (path: string) => MIME[extname(path)] ?? 'text/plain'

/** Keeps "</script>" inside inline code from closing the script element. */
const escapeScript = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1')

/** JSON that is safe to embed inside a <script> element. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

function bridgeScript(files: ReadonlyMap<string, string>, entry: string): string {
  const fileMap = Object.fromEntries([...files].map(([p, c]) => [p, [c, mimeFor(p)]]))
  return `(function () {
  var inspect = (${inspect.toString()});
  var format = (${formatArgs.toString()});
  var send = function (data) {
    data.source = 'some-ide-preview';
    try { parent.postMessage(data, '*'); } catch (e) {}
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      try { send({ level: level, text: format(args, inspect) }); } catch (e) {}
      return original.apply(console, args);
    };
  });
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      send({ level: 'error', text: 'Failed to load ' + (t.src || t.href) });
    } else {
      send({ level: 'error', text: e.error && e.error.stack ? String(e.error.stack) : String(e.message) });
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    send({ level: 'error', text: 'Uncaught (in promise) ' + inspect(e.reason) });
  });

  var files = ${scriptJson(fileMap)};
  var baseDir = ${JSON.stringify(dirname(entry).replace(/\/?$/, '/'))};
  var toProjectPath = function (ref) {
    if (typeof ref !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.indexOf('//') === 0) return null;
    var url = new URL(ref, 'http://project' + baseDir);
    return decodeURIComponent(url.pathname);
  };
  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var path = toProjectPath(input instanceof URL ? input.href : input);
    if (path && files[path]) {
      return Promise.resolve(new Response(files[path][0], { status: 200, headers: { 'Content-Type': files[path][1] } }));
    }
    if (path) return Promise.resolve(new Response('Not found: ' + path, { status: 404 }));
    return realFetch.apply(this, arguments);
  };
  // Forward IDE shortcuts (F5, Ctrl+S, Ctrl+P…) so they still work while the preview has focus.
  document.addEventListener('keydown', function (e) {
    var fn = /^F\d+$/.test(e.code);
    if (!fn && !e.ctrlKey && !e.metaKey) return;
    var code = e.code;
    if (fn || ['KeyS', 'KeyP', 'KeyJ', 'KeyB', 'Backquote'].indexOf(code) >= 0 || (e.shiftKey && ['KeyF', 'KeyE'].indexOf(code) >= 0)) {
      e.preventDefault();
    }
    send({ type: 'keydown', code: code, key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey });
  }, true);
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.target === '_blank') return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    var path = toProjectPath(href.split('#')[0].split('?')[0]);
    if (!path) return;
    e.preventDefault();
    if (files[path]) send({ type: 'navigate', path: path });
    else send({ level: 'warn', text: 'Page not found in project: ' + path });
  });
})();`
}

/** Builds the preview document for the HTML file at `entry`. */
export async function buildPreview(files: ReadonlyMap<string, string>, entry: string): Promise<PreviewBuild> {
  const source = files.get(entry)
  if (source === undefined) throw new Error(`File not found: ${entry}`)

  const doc = new DOMParser().parseFromString(source, 'text/html')
  const warnings: string[] = []
  const dir = dirname(entry)
  const importMap: Record<string, string> = {}

  // The page's own import map wins for the bare imports it defines (an exact key, or a
  // "prefix/" key); everything else is fetched from esm.sh.
  const existingMap = doc.querySelector('script[type="importmap"]')
  let userMap: ImportMapJson = {}
  if (existingMap) {
    try {
      const parsed: unknown = JSON.parse(existingMap.textContent || '{}')
      if (parsed && typeof parsed === 'object') userMap = parsed as ImportMapJson
    } catch {
      warnings.push(`${entry}: the existing import map is not valid JSON and was replaced`)
    }
  }
  const userImports = userMap.imports ?? {}
  const resolveBare = (spec: string) => (importMapDefines(userImports, spec) ? null : ESM_CDN + spec)

  const localPath = (ref: string | null): string | null => {
    if (!ref || isUrlSpecifier(ref) || ref.startsWith('//') || ref.startsWith('#')) return null
    const clean = ref.split(/[?#]/)[0]
    const path = clean.startsWith('/') ? normalize(clean) : join(dir, clean)
    if (files.has(path)) return path
    warnings.push(`${entry}: cannot find "${ref}"`)
    return null
  }

  const emit = (path: string, code: string) => {
    const key = PROJECT_PREFIX + path
    importMap[key] = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code)
    return key
  }

  // A map value naming a project file ("vue": "./vendor/vue.js") would 404 inside the
  // sandboxed frame, so such entries are linked like any other project module.
  for (const [name, value] of Object.entries(userImports)) {
    if (typeof value !== 'string' || !value || isUrlSpecifier(value) || value.startsWith('//')) continue
    if (name.endsWith('/')) {
      warnings.push(`${entry}: import map prefix "${name}" points into the project; only exact entries are supported`)
      continue
    }
    const path = localPath(value)
    if (!path) continue
    userImports[name] = importMap[await linkModules({ files, entry: path, target: 'browser', emit, resolveBare })]
  }

  for (const link of [...doc.querySelectorAll('link[rel~="stylesheet"][href]')]) {
    const path = localPath(link.getAttribute('href'))
    if (!path) continue
    const style = doc.createElement('style')
    style.setAttribute('data-file', path)
    style.textContent = files.get(path)!.replace(/<\/(style)/gi, '<\\/$1')
    link.replaceWith(style)
  }

  let inlineModules = 0
  for (const script of [...doc.querySelectorAll('script')]) {
    const type = (script.getAttribute('type') ?? '').trim().toLowerCase()
    const isModule = type === 'module'
    if (type && !isModule && type !== 'text/javascript' && type !== 'application/javascript') continue

    const src = script.getAttribute('src')
    if (src) {
      const path = localPath(src)
      if (!path) continue
      script.removeAttribute('src')
      if (isModule || /\.(ts|tsx|jsx|mts)$/.test(path)) {
        const specifier = await linkModules({ files, entry: path, target: 'browser', emit, resolveBare })
        script.setAttribute('type', 'module')
        script.textContent = `import ${JSON.stringify(specifier)};`
      } else {
        script.textContent = escapeScript(`${files.get(path)}\n//# sourceURL=${path}`)
      }
    } else if (isModule && script.textContent?.trim()) {
      const virtualPath = join(dir, `${entry.split('/').pop()}.inline-${++inlineModules}.js`)
      const withInline = new Map(files).set(virtualPath, script.textContent)
      const specifier = await linkModules({ files: withInline, entry: virtualPath, target: 'browser', emit, resolveBare })
      script.textContent = `import ${JSON.stringify(specifier)};`
    }
  }

  // SVG images can be inlined as data: URLs; other binary assets aren't stored in the project.
  for (const el of [...doc.querySelectorAll('img[src], link[rel~="icon"][href]')]) {
    const attr = el.hasAttribute('src') ? 'src' : 'href'
    const path = localPath(el.getAttribute(attr))
    if (path && extname(path) === '.svg') {
      el.setAttribute(attr, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(files.get(path)!))
    }
  }

  const bridge = doc.createElement('script')
  bridge.textContent = escapeScript(bridgeScript(files, entry))
  const merged = scriptJson({ ...userMap, imports: { ...userImports, ...importMap } })
  if (existingMap) {
    existingMap.textContent = merged
    doc.head.prepend(bridge)
  } else {
    const mapScript = doc.createElement('script')
    mapScript.setAttribute('type', 'importmap')
    mapScript.textContent = merged
    doc.head.prepend(bridge, mapScript)
  }

  return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, warnings }
}

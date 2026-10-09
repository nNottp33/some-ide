import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'
import type { ThemeName } from '../core/settings'

export { monaco }

// Bundle Monaco's web workers through Vite (`?worker`) so they load from our own origin.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  },
}

/** Ambient types for the small Node-style shim the JavaScript runner provides. */
const RUNTIME_TYPES = `
declare const process: {
  argv: string[]
  env: Record<string, string | undefined>
  platform: string
  stdout: { write(chunk: unknown): boolean }
  stderr: { write(chunk: unknown): boolean }
  exit(code?: number): never
}
declare module '*.css' { const css: string; export default css }
declare module '*.json' { const value: any; export default value }
`

export const MONACO_THEMES: Record<ThemeName, string> = { dark: 'some-ide-dark', light: 'some-ide-light' }

let configured = false

export function configureMonaco(): void {
  if (configured) return
  configured = true

  const ts = monaco.typescript
  const compilerOptions: monaco.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    // Every file is its own module (as the runner treats it): allows top-level await and
    // stops `const x` in one file from clashing with `const x` in another.
    moduleDetection: 3,
    allowJs: true,
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    resolveJsonModule: true,
    strict: true,
    noEmit: true,
  }
  // 2307/2792: "Cannot find module" — npm packages are fetched from esm.sh at run time, so
  // their types are unknown here. Missing project files are still reported by the runner.
  const diagnostics = { noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [2307, 2792, 7016] }
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptions)
    defaults.setDiagnosticsOptions(diagnostics)
    defaults.setEagerModelSync(true)
    defaults.addExtraLib(RUNTIME_TYPES, 'file:///__some-ide__/runtime.d.ts')
  }

  monaco.editor.defineTheme(MONACO_THEMES.dark, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1e1f24',
      'editorGutter.background': '#1e1f24',
      'minimap.background': '#1e1f24',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.lineHighlightBorder': '#00000000',
      'editorWidget.background': '#23252b',
      'editorWidget.border': '#33363e',
      'editorSuggestWidget.background': '#23252b',
      'editorHoverWidget.background': '#23252b',
      'focusBorder': '#6d7cff',
    },
  })
  monaco.editor.defineTheme(MONACO_THEMES.light, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.lineHighlightBackground': '#00000006',
      'editor.lineHighlightBorder': '#00000000',
      'focusBorder': '#4f5bd5',
    },
  })
}

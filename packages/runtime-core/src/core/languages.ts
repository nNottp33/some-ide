import { basename, extname } from './path'

export interface LanguageInfo {
  /** Monaco language id. */
  id: string
  /** Human readable name for the status bar. */
  label: string
  /** Short badge text and color used as the file icon. */
  badge: string
  color: string
}

export type Runtime = 'javascript' | 'python' | 'html'

const lang = (id: string, label: string, badge: string, color: string): LanguageInfo => ({ id, label, badge, color })

const PLAIN = lang('plaintext', 'Plain Text', 'TXT', '#9aa0a6')

const BY_EXTENSION: Record<string, LanguageInfo> = {
  '.js': lang('javascript', 'JavaScript', 'JS', '#e8c547'),
  '.mjs': lang('javascript', 'JavaScript', 'JS', '#e8c547'),
  '.cjs': lang('javascript', 'JavaScript', 'JS', '#e8c547'),
  '.jsx': lang('javascript', 'JavaScript JSX', 'JSX', '#61dafb'),
  '.ts': lang('typescript', 'TypeScript', 'TS', '#3b8eea'),
  '.mts': lang('typescript', 'TypeScript', 'TS', '#3b8eea'),
  '.cts': lang('typescript', 'TypeScript', 'TS', '#3b8eea'),
  '.tsx': lang('typescript', 'TypeScript JSX', 'TSX', '#3b8eea'),
  '.json': lang('json', 'JSON', '{}', '#cbcb41'),
  '.html': lang('html', 'HTML', '<>', '#e44d26'),
  '.htm': lang('html', 'HTML', '<>', '#e44d26'),
  '.css': lang('css', 'CSS', '#', '#563d7c'),
  '.scss': lang('scss', 'SCSS', 'S', '#c6538c'),
  '.less': lang('less', 'Less', 'L', '#2a4d80'),
  '.md': lang('markdown', 'Markdown', 'M↓', '#519aba'),
  '.markdown': lang('markdown', 'Markdown', 'M↓', '#519aba'),
  '.py': lang('python', 'Python', 'PY', '#4b8bbe'),
  '.java': lang('java', 'Java', 'J', '#cc3e44'),
  '.c': lang('c', 'C', 'C', '#599eff'),
  '.h': lang('cpp', 'C/C++ Header', 'H', '#a074c4'),
  '.cpp': lang('cpp', 'C++', 'C++', '#f34b7d'),
  '.cc': lang('cpp', 'C++', 'C++', '#f34b7d'),
  '.hpp': lang('cpp', 'C++ Header', 'H', '#a074c4'),
  '.cs': lang('csharp', 'C#', 'C#', '#68217a'),
  '.go': lang('go', 'Go', 'GO', '#00add8'),
  '.rs': lang('rust', 'Rust', 'RS', '#dea584'),
  '.php': lang('php', 'PHP', 'PHP', '#a074c4'),
  '.rb': lang('ruby', 'Ruby', 'RB', '#cc342d'),
  '.kt': lang('kotlin', 'Kotlin', 'KT', '#a97bff'),
  '.swift': lang('swift', 'Swift', 'SW', '#f05138'),
  '.dart': lang('dart', 'Dart', 'DA', '#00b4ab'),
  '.lua': lang('lua', 'Lua', 'LUA', '#51a0cf'),
  '.sql': lang('sql', 'SQL', 'SQL', '#dad8d8'),
  '.sh': lang('shell', 'Shell Script', '$', '#89e051'),
  '.bash': lang('shell', 'Shell Script', '$', '#89e051'),
  '.yml': lang('yaml', 'YAML', 'YML', '#cb171e'),
  '.yaml': lang('yaml', 'YAML', 'YML', '#cb171e'),
  '.xml': lang('xml', 'XML', '<>', '#e37933'),
  '.svg': lang('xml', 'SVG', 'SVG', '#ffb13b'),
  '.graphql': lang('graphql', 'GraphQL', 'GQL', '#e535ab'),
  '.ini': lang('ini', 'INI', 'INI', '#9aa0a6'),
  '.toml': lang('ini', 'TOML', 'TML', '#9c4221'),
  '.txt': PLAIN,
}

const BY_NAME: Record<string, LanguageInfo> = {
  dockerfile: lang('dockerfile', 'Dockerfile', 'DKR', '#2496ed'),
  makefile: lang('plaintext', 'Makefile', 'MK', '#6d8086'),
  '.gitignore': lang('plaintext', 'Ignore', 'GIT', '#e44d26'),
  '.env': lang('ini', 'Environment', 'ENV', '#e8c547'),
}

export function languageForPath(path: string): LanguageInfo {
  return BY_NAME[basename(path).toLowerCase()] ?? BY_EXTENSION[extname(path)] ?? PLAIN
}

/** Which runtime can execute this file, if any. */
export function runtimeForPath(path: string): Runtime | null {
  switch (extname(path)) {
    case '.js':
    case '.mjs':
    case '.ts':
    case '.mts':
    case '.jsx':
    case '.tsx':
      return 'javascript'
    case '.py':
      return 'python'
    case '.html':
    case '.htm':
      return 'html'
    default:
      return null
  }
}

import { Emitter } from './emitter'
import { readLocal, writeLocal } from './storage'

export type ThemeName = 'dark' | 'light'

export interface Settings {
  theme: ThemeName
  fontSize: number
  tabSize: number
  wordWrap: boolean
  minimap: boolean
  autoSave: boolean
  formatOnSave: boolean
}

const prefersLight = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches

export const defaultSettings = (): Settings => ({
  theme: prefersLight() ? 'light' : 'dark',
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  minimap: true,
  autoSave: false,
  formatOnSave: false,
})

export class SettingsStore {
  readonly onDidChange = new Emitter<Settings>()
  private value: Settings = readLocal('settings', defaultSettings())

  get(): Readonly<Settings> {
    return this.value
  }

  update(patch: Partial<Settings>): void {
    this.value = { ...this.value, ...patch }
    this.value.fontSize = Math.min(32, Math.max(8, this.value.fontSize))
    writeLocal('settings', this.value)
    this.onDidChange.emit(this.value)
  }
}

/** Workbench layout and session state that survives reloads. */
export interface WorkbenchState {
  openTabs: string[]
  activeTab: string | null
  expanded: string[]
  sidebarView: 'explorer' | 'search'
  sidebarVisible: boolean
  sidebarWidth: number
  panelVisible: boolean
  panelHeight: number
  previewWidth: number
  stdin: string
  lastRun: string | null
}

export const defaultWorkbenchState = (): WorkbenchState => ({
  openTabs: [],
  activeTab: null,
  expanded: ['/src'],
  sidebarView: 'explorer',
  sidebarVisible: typeof innerWidth !== 'number' || innerWidth > 720,
  sidebarWidth: 260,
  panelVisible: true,
  panelHeight: 220,
  previewWidth: 420,
  stdin: '',
  lastRun: null,
})

export function loadWorkbenchState(): WorkbenchState {
  return readLocal('workbench', defaultWorkbenchState())
}

export function saveWorkbenchState(state: WorkbenchState): void {
  writeLocal('workbench', state)
}

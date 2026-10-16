/**
 * Persistence helpers.
 *
 * Project files live in IndexedDB (large, async). Small UI state and settings live in
 * localStorage so they can be read synchronously during startup. Every access is wrapped
 * in try/catch: storage can be missing or blocked (private windows, sandboxed iframes),
 * in which case the IDE keeps working in memory only.
 */

export interface KeyValueStore {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory'
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

const DB_NAME = 'some-ide'
const STORE_NAME = 'kv'

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function openIndexedDb(): Promise<KeyValueStore> {
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
  const db = await promisify(request)
  const store = (mode: IDBTransactionMode) => db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)
  return {
    kind: 'indexeddb',
    get: async <T>(key: string) => (await promisify(store('readonly').get(key))) as T | undefined,
    set: async (key, value) => void (await promisify(store('readwrite').put(value, key))),
    delete: async (key) => void (await promisify(store('readwrite').delete(key))),
  }
}

function localStorageStore(): KeyValueStore {
  const prefix = `${DB_NAME}:kv:`
  // Probe once so we fail over to memory immediately when localStorage is blocked.
  localStorage.setItem(prefix + '__probe', '1')
  localStorage.removeItem(prefix + '__probe')
  return {
    kind: 'localstorage',
    get: async <T>(key: string) => {
      const raw = localStorage.getItem(prefix + key)
      return raw == null ? undefined : (JSON.parse(raw) as T)
    },
    set: async (key, value) => localStorage.setItem(prefix + key, JSON.stringify(value)),
    delete: async (key) => localStorage.removeItem(prefix + key),
  }
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>()
  return {
    kind: 'memory',
    get: async <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    set: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => void map.delete(key),
  }
}

export async function openStore(): Promise<KeyValueStore> {
  try {
    return await openIndexedDb()
  } catch {
    try {
      return localStorageStore()
    } catch {
      return memoryStore()
    }
  }
}

/** Synchronous JSON read from localStorage that never throws; missing fields come from `fallback`. */
export function readLocal<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${DB_NAME}:${key}`)
    return raw == null ? fallback : { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${DB_NAME}:${key}`, JSON.stringify(value))
  } catch {
    // Storage blocked or full: the IDE still works, it just won't remember this.
  }
}

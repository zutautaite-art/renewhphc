const DB_NAME = 'renewhphc'
const DB_VERSION = 1
const STORE = 'workbook'

export type StoredWorkbook = {
  name: string
  buffer: ArrayBuffer
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

/** Persist the uploaded workbook bytes for restore on next visit. */
export async function saveWorkbook(name: string, buffer: ArrayBuffer): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  // Clone buffer so callers can reuse the original ArrayBuffer safely.
  const payload = { id: 1, name, buffer: buffer.slice(0) }
  await reqToPromise(store.put(payload))
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
  db.close()
}

/** Load the last saved workbook, or null if none / unavailable. */
export async function loadWorkbook(): Promise<StoredWorkbook | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const row = await reqToPromise(store.get(1)) as { name?: string; buffer?: ArrayBuffer } | undefined
    db.close()
    if (!row?.buffer || typeof row.name !== 'string') return null
    return { name: row.name, buffer: row.buffer }
  } catch {
    return null
  }
}

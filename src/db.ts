const DB_NAME = 'renewhphc'
const DB_VERSION = 2
const STORE = 'workbook'
const PIN_STORE = 'pins'

export type StoredWorkbook = {
  name: string
  buffer: ArrayBuffer
}

export type DroppedPin = {
  id: string
  lat: number
  lng: number
  type: 'Household' | 'Business'
  houseNo: string
  street: string
  town: string
  county: string
  solar: 'Yes' | 'No' | 'Unknown'
  ev: 'Yes' | 'No' | 'Unknown'
  heatPump: 'Yes' | 'No' | 'Unknown'
  createdAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(PIN_STORE)) {
        db.createObjectStore(PIN_STORE, { keyPath: 'id' })
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

/** User-visible explanation when save/restore fails. */
export function describeIndexedDbError(e: unknown): string {
  const dom = e instanceof DOMException ? e : null
  if (dom?.name === 'QuotaExceededError') {
    return 'Browser storage is full. Use a smaller .xlsx, free disk space, or clear this site’s stored data. Avoid private/incognito windows for long-term storage.'
  }
  if (dom?.name === 'InvalidStateError') {
    return 'Browser storage is unavailable (often in private browsing). The file works until you close this tab.'
  }
  if (e instanceof Error) return e.message
  return 'Browser storage error'
}

/** Best-effort: ask the browser not to evict this origin’s data under storage pressure. */
export async function tryPersistBrowserStorage(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return
  await navigator.storage.persist().catch(() => {})
}

/** Persist the uploaded workbook bytes for restore on next visit. */
export async function saveWorkbook(name: string, buffer: ArrayBuffer): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const payload = { id: 1, name, buffer: buffer.slice(0) }
  await reqToPromise(store.put(payload))
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
  db.close()
}

/** Load the last saved workbook, or null if none / storage unavailable. */
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

/** Save a new dropped pin. */
export async function savePinToDb(pin: DroppedPin): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(PIN_STORE, 'readwrite')
    await reqToPromise(tx.objectStore(PIN_STORE).put(pin))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch (e) { console.warn('savePinToDb failed:', e) }
}

/** Load all dropped pins. */
export async function loadAllPinsFromDb(): Promise<DroppedPin[]> {
  try {
    const db = await openDb()
    const tx = db.transaction(PIN_STORE, 'readonly')
    const result = await reqToPromise(tx.objectStore(PIN_STORE).getAll()) as DroppedPin[]
    db.close()
    return result ?? []
  } catch { return [] }
}

/** Delete all dropped pins. */
export async function clearAllPinsFromDb(): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(PIN_STORE, 'readwrite')
    await reqToPromise(tx.objectStore(PIN_STORE).clear())
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch (e) { console.warn('clearAllPinsFromDb failed:', e) }
}

/** Update solar/ev/heatPump fields of an existing pin. */
export async function updatePinInDb(id: string, updates: Partial<DroppedPin>): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(PIN_STORE, 'readwrite')
    const store = tx.objectStore(PIN_STORE)
    const existing = await reqToPromise(store.get(id)) as DroppedPin | undefined
    if (existing) await reqToPromise(store.put({ ...existing, ...updates }))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch (e) { console.warn('updatePinInDb failed:', e) }
}

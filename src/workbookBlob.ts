import { upload } from '@vercel/blob/client'

/** Must match `api/handle-blob-upload.ts` and `api/workbook-remote.ts`. */
export const SHARED_WORKBOOK_PATH = 'renewhphc/workbook.xlsx'

export type RemoteWorkbookMeta = {
  url: string | null
  pathname: string | null
  /** `true` when `BLOB_READ_WRITE_TOKEN` is set on the server (Vercel). */
  blobConfigured: boolean
  /** `true` when Blob is configured but nothing exists at the shared path yet. */
  noFileYet?: boolean
}

function handleBlobUploadUrl(): string {
  return `${window.location.origin}/api/handle-blob-upload`
}

/** GET `/api/workbook-remote` — does not download the file body. */
export async function fetchRemoteWorkbookMeta(): Promise<RemoteWorkbookMeta | null> {
  try {
    const metaRes = await fetch('/api/workbook-remote')
    if (!metaRes.ok) return null
    return (await metaRes.json()) as RemoteWorkbookMeta
  } catch {
    return null
  }
}

/** Download workbook bytes when the API reports a `url`. */
export async function fetchBufferFromRemoteMeta(meta: RemoteWorkbookMeta): Promise<ArrayBuffer | null> {
  if (!meta.url) return null
  try {
    const fileRes = await fetch(meta.url)
    if (!fileRes.ok) return null
    return await fileRes.arrayBuffer()
  } catch {
    return null
  }
}

/** Upload the file to Vercel Blob (same object for every device). */
export async function uploadSharedWorkbook(file: File): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await upload(SHARED_WORKBOOK_PATH, file, {
      access: 'public',
      handleUploadUrl: handleBlobUploadUrl(),
      multipart: file.size > 4 * 1024 * 1024,
      contentType:
        file.type ||
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Blob upload failed'
    return { ok: false, message }
  }
}

/** Convenience: meta + download in one call (two round-trips). */
export async function fetchSharedWorkbookBuffer(): Promise<ArrayBuffer | null> {
  const meta = await fetchRemoteWorkbookMeta()
  if (!meta?.url) return null
  return fetchBufferFromRemoteMeta(meta)
}

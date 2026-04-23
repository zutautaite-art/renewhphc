import { upload } from '@vercel/blob/client'

/** Must match `api/handle-blob-upload.ts` and `api/workbook-remote.ts`. */
export const SHARED_WORKBOOK_PATH = 'renewhphc/workbook.xlsx'

function handleBlobUploadUrl(): string {
  return `${window.location.origin}/api/handle-blob-upload`
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

/** Fetch bytes of the shared workbook if it exists on Blob (GET /api/workbook-remote). */
export async function fetchSharedWorkbookBuffer(): Promise<ArrayBuffer | null> {
  try {
    const metaRes = await fetch('/api/workbook-remote')
    if (!metaRes.ok) return null
    const meta = (await metaRes.json()) as { url: string | null }
    if (!meta?.url) return null
    const fileRes = await fetch(meta.url)
    if (!fileRes.ok) return null
    return await fileRes.arrayBuffer()
  } catch {
    return null
  }
}

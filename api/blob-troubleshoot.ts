import type { VercelRequest, VercelResponse } from '@vercel/node'
import { BlobNotFoundError, get, head } from '@vercel/blob'

const SHARED_WORKBOOK_PATH = 'renewhphc/workbook.xlsx'

/**
 * Safe diagnostics for Vercel Blob + workbook path (no secrets).
 * GET /api/blob-troubleshoot
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  if (_req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const tokenPresent = Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim())

  let headStatus: 'skipped' | 'ok' | 'not_found' | 'error' = 'skipped'
  let headError = ''
  if (tokenPresent) {
    try {
      await head(SHARED_WORKBOOK_PATH)
      headStatus = 'ok'
    } catch (e) {
      if (e instanceof BlobNotFoundError) headStatus = 'not_found'
      else {
        headStatus = 'error'
        headError = e instanceof Error ? e.message : String(e)
      }
    }
  }

  let streamStatus: 'skipped' | 'ok' | 'empty' | 'error' = 'skipped'
  let streamError = ''
  if (tokenPresent && headStatus === 'ok') {
    streamStatus = 'error'
    for (const access of ['public', 'private'] as const) {
      try {
        const result = await get(SHARED_WORKBOOK_PATH, { access })
        if (result?.statusCode === 200 && result.stream) {
          const reader = result.stream.getReader()
          const chunk = await reader.read()
          await reader.cancel().catch(() => {})
          streamStatus = chunk.value && chunk.value.length > 0 ? 'ok' : 'empty'
          streamError = ''
          break
        }
      } catch (e) {
        streamError = e instanceof Error ? e.message : String(e)
      }
    }
  }

  const hints: string[] = []
  if (!tokenPresent) {
    hints.push('BLOB_READ_WRITE_TOKEN is missing on this deployment — link the Blob store to the project and redeploy.')
  } else if (headStatus === 'not_found') {
    hints.push('No object at this pathname yet — upload the workbook once from the app (live site).')
  } else if (headStatus === 'error') {
    hints.push(`head() failed: ${headError}`)
  } else if (streamStatus === 'error') {
    hints.push(`get() failed (tried public + private): ${streamError}`)
  } else if (streamStatus === 'empty') {
    hints.push('Blob exists but first read returned no bytes (unexpected).')
  } else if (streamStatus === 'ok') {
    hints.push('Server can read the workbook blob. If the map has no dots, check the Excel template / browser console / Network tab for parse or CORS issues.')
  }

  return res.status(200).json({
    tokenPresent,
    sharedPathname: SHARED_WORKBOOK_PATH,
    head: headStatus,
    firstByteRead: streamStatus,
    hints,
    checkedAt: new Date().toISOString(),
  })
}

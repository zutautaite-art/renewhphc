import type { VercelRequest, VercelResponse } from '@vercel/node'
import { get } from '@vercel/blob'

const SHARED_WORKBOOK_PATH = 'renewhphc/workbook.xlsx'

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * Download the shared workbook using the server token (works for public or private blobs).
 * Call this from the app instead of fetching the blob URL when the store is private.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return res.status(503).json({ error: 'Blob not configured' })
  }

  for (const access of ['public', 'private'] as const) {
    try {
      const result = await get(SHARED_WORKBOOK_PATH, { access })
      if (result?.statusCode === 200 && result.stream) {
        const buf = await streamToBuffer(result.stream)
        const ct =
          result.blob.contentType ||
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        res.setHeader('Content-Type', ct)
        res.setHeader('Cache-Control', 'private, max-age=60')
        return res.status(200).send(buf)
      }
    } catch {
      /* try next access mode */
    }
  }

  return res.status(404).end()
}

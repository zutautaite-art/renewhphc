import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'

/** Single shared workbook for this deployment (all devices use the same blob). */
const SHARED_WORKBOOK_PATH = 'renewhphc/workbook.xlsx'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  try {
    const body = req.body as HandleUploadBody
    const jsonResponse = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (pathname !== SHARED_WORKBOOK_PATH) {
          throw new Error('Invalid upload path')
        }
        return {
          allowedContentTypes: [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'application/octet-stream',
          ],
          maximumSizeInBytes: 100 * 1024 * 1024,
          addRandomSuffix: false,
          allowOverwrite: true,
        }
      },
    })
    return res.status(200).json(jsonResponse)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Upload handler error'
    return res.status(400).json({ error: message })
  }
}

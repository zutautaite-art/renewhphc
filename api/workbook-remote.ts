import type { VercelRequest, VercelResponse } from '@vercel/node'
import { head } from '@vercel/blob'

const SHARED_WORKBOOK_PATH = 'renewhphc/workbook.xlsx'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) {
    return res.status(200).json({
      url: null,
      pathname: null,
      blobConfigured: false,
      noFileYet: false,
    })
  }

  try {
    const meta = await head(SHARED_WORKBOOK_PATH)
    return res.status(200).json({
      url: meta.url,
      pathname: meta.pathname,
      blobConfigured: true,
      noFileYet: false,
    })
  } catch {
    return res.status(200).json({
      url: null,
      pathname: null,
      blobConfigured: true,
      noFileYet: true,
    })
  }
}

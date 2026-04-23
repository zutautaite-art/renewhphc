import { list } from '@vercel/blob'
import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { blobs } = await list({ prefix: 'workbook/' })
    if (!blobs.length) return res.status(404).json({ error: 'No workbook found' })

    const latest = blobs.sort((a, b) =>
      new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    )[0]

    return res.status(200).json({ url: latest.url, name: latest.pathname.split('/').pop() })
  } catch (err) {
    console.error('Blob list error:', err)
    return res.status(500).json({ error: 'Failed to get workbook' })
  }
}


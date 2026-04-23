import { list } from '@vercel/blob'
import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { blobs } = await list()
    if (!blobs.length) return res.status(404).json({ error: 'No workbook found' })

    const latest = blobs.sort((a, b) =>
      new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    )[0]

    const response = await fetch(latest.url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    })
    if (!response.ok) return res.status(500).json({ error: 'Failed to fetch from blob' })

    const buffer = await response.arrayBuffer()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${latest.pathname.split('/').pop()}"`)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).send(Buffer.from(buffer))
  } catch (err) {
    console.error('Blob fetch error:', err)
    return res.status(500).json({ error: 'Failed to get workbook' })
  }
}


import { put } from '@vercel/blob'
import type { VercelRequest, VercelResponse } from '@vercel/node'

export const config = { api: { bodyParser: false } }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const buffer = Buffer.concat(chunks)

    const filename = (req.headers['x-filename'] as string) || 'workbook.xlsx'

    const blob = await put(`workbook/${filename}`, buffer, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
    })

    return res.status(200).json({ url: blob.url })
  } catch (err) {
    console.error('Blob upload error:', err)
    return res.status(500).json({ error: 'Upload failed' })
  }
}


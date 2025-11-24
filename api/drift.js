import { sql } from '@vercel/postgres'

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      author TEXT NOT NULL,
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      timestamp BIGINT NOT NULL,
      dimension TEXT DEFAULT '',
      x DOUBLE PRECISION DEFAULT 0,
      y DOUBLE PRECISION DEFAULT 0,
      z DOUBLE PRECISION DEFAULT 0
    )
  `
}

export default async function handler(req, res) {
  await ensureSchema()
  if (req.method === 'GET') {
    try {
      const { rows } = await sql`SELECT id, author, title, content, timestamp, dimension, x, y, z FROM messages ORDER BY id DESC LIMIT 100`
      return res.status(200).json(rows)
    } catch (e) {
      return res.status(500).json({ ok: false })
    }
  } else if (req.method === 'POST') {
    const { author, title, content, timestamp, dimension, x, y, z } = req.body || {}
    try {
      await sql`
        INSERT INTO messages (author, title, content, timestamp, dimension, x, y, z)
        VALUES (${author || ''}, ${title || ''}, ${content || ''}, ${Number(timestamp) || Date.now()}, ${dimension || ''}, ${Number(x) || 0}, ${Number(y) || 0}, ${Number(z) || 0})
      `
      return res.status(200).json({ ok: true })
    } catch (e) {
      return res.status(500).json({ ok: false })
    }
  } else {
    res.status(405).end()
  }
}


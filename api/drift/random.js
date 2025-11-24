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
  const exclude = req.query.exclude || ''
  try {
    if (exclude) {
      const { rows } = await sql`SELECT id, author, title, content, timestamp, dimension, x, y, z FROM messages WHERE author <> ${exclude} ORDER BY RANDOM() LIMIT 1`
      if (rows.length === 0) return res.status(404).json({ ok: false })
      return res.status(200).json(rows[0])
    } else {
      const { rows } = await sql`SELECT id, author, title, content, timestamp, dimension, x, y, z FROM messages ORDER BY RANDOM() LIMIT 1`
      if (rows.length === 0) return res.status(404).json({ ok: false })
      return res.status(200).json(rows[0])
    }
  } catch (e) {
    return res.status(500).json({ ok: false })
  }
}


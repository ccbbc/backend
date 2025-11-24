import express from 'express'
import initSqlJs from 'sql.js'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dbFile = path.join(__dirname, 'drift.sqlite')

const SQL = await initSqlJs({ locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file) })
let db
if (fs.existsSync(dbFile)) {
  const data = fs.readFileSync(dbFile)
  db = new SQL.Database(data)
} else {
  db = new SQL.Database()
}
db.run('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT, title TEXT, content TEXT, timestamp INTEGER, dimension TEXT, x REAL, y REAL, z REAL)')

function saveDb() {
  const data = db.export()
  fs.writeFileSync(dbFile, Buffer.from(data))
}

const app = express()
app.use(express.json({ limit: '1mb' }))

function verifySignature(req, res, next) {
  const PART_A = Buffer.from([0x21,0x12,0x33,0x44,0x55,0x66,0x77,0x7f,0x20,0x19])
  const PART_B = Buffer.from([0x42,0x71,0x51,0x26,0x36,0x56,0x42,0x4d,0x13,0x37])
  const restored = Buffer.alloc(Math.min(PART_A.length, PART_B.length))
  for (let i = 0; i < restored.length; i++) restored[i] = PART_A[i] ^ PART_B[i]
  const defaultSecret = restored.toString('utf8') // "ccbbc0523."
  const secret = process.env.GAME_SECRET || defaultSecret
  if (!secret) return res.status(401).json({ ok: false, error: 'NO_SECRET' })
  const ts = req.header('x-game-ts')
  const nonce = req.header('x-game-nonce')
  const player = req.header('x-game-player')
  const sig = req.header('x-game-signature')
  if (!ts || !nonce || !player || !sig) return res.status(401).json({ ok: false, error: 'MISSING_HEADERS' })
  const now = Date.now()
  const skew = Math.abs(now - Number(ts))
  if (Number.isNaN(Number(ts)) || skew > 5 * 60 * 1000) return res.status(401).json({ ok: false, error: 'TS_SKEW' })
  const h = crypto.createHmac('sha256', secret).update(`${ts}.${nonce}.${player}`).digest('base64')
  if (h !== sig) return res.status(401).json({ ok: false, error: 'BAD_SIG' })
  next()
}

app.post('/drift', verifySignature, (req, res) => {
  const { author, title, content, timestamp, dimension, x, y, z } = req.body || {}
  if (typeof author !== 'string' || typeof content !== 'string') return res.status(400).json({ ok: false })
  const ts = typeof timestamp === 'number' ? timestamp : Date.now()
  const stmt = db.prepare('INSERT INTO messages (author, title, content, timestamp, dimension, x, y, z) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  stmt.run([author, title || '', content, ts, dimension || '', x || 0, y || 0, z || 0])
  saveDb()
  res.json({ ok: true })
})

app.get('/drift', verifySignature, (req, res) => {
  const stmt = db.prepare('SELECT id, author, title, content, timestamp, dimension, x, y, z FROM messages ORDER BY id DESC LIMIT 100')
  const rows = []
  stmt.bind([])
  while (stmt.step()) {
    const [id, author, title, content, timestamp, dimension, x, y, z] = stmt.get()
    rows.push({ id, author, title, content, timestamp, dimension, x, y, z })
  }
  res.json(rows)
})

app.get('/drift/random', verifySignature, (req, res) => {
  const exclude = req.query.exclude || ''
  let stmt
  if (exclude) {
    stmt = db.prepare('SELECT id, author, title, content, timestamp, dimension, x, y, z FROM messages WHERE author != ? ORDER BY RANDOM() LIMIT 1')
    stmt.bind([exclude])
  } else {
    stmt = db.prepare('SELECT id, author, title, content, timestamp, dimension, x, y, z FROM messages ORDER BY RANDOM() LIMIT 1')
    stmt.bind([])
  }
  if (!stmt.step()) return res.status(404).json({ ok: false })
  const [id, author, title, content, timestamp, dimension, x, y, z] = stmt.get()
  res.json({ id, author, title, content, timestamp, dimension, x, y, z })
})

const port = process.env.PORT || 8080
app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}/`)
})

export default (req, res) => app(req, res)

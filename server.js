import express from 'express'
import initSqlJs from 'sql.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dbFile = path.join(__dirname, 'drift.sqlite')

const SQL = await initSqlJs({ locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file) })
let db
if (fs.existsSync(dbFile)) {
  try {
    const data = fs.readFileSync(dbFile)
    db = new SQL.Database(data)
  } catch (e) {
    console.error('Failed to open existing database, creating a new one:', e?.message || e)
    const bak = dbFile.replace(/\.sqlite$/, `.corrupt-${Date.now()}.sqlite`)
    try { fs.renameSync(dbFile, bak) } catch {}
    db = new SQL.Database()
  }
} else {
  db = new SQL.Database()
}
try {
  db.run('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT, title TEXT, content TEXT, timestamp INTEGER, dimension TEXT, x REAL, y REAL, z REAL)')
} catch (e) {
  console.error('Database initialization failed, recreating:', e?.message || e)
  try { fs.renameSync(dbFile, dbFile.replace(/\.sqlite$/, `.reinit-${Date.now()}.sqlite`)) } catch {}
  db = new SQL.Database()
  db.run('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT, title TEXT, content TEXT, timestamp INTEGER, dimension TEXT, x REAL, y REAL, z REAL)')
}

function saveDb() {
  const data = db.export()
  fs.writeFileSync(dbFile, Buffer.from(data))
}

const app = express()
app.use(express.json({ limit: '1mb' }))
// Basic CORS without extra dependency
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// Health check and root ping for connectivity tests
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'cbcustom-backend', version: '1.0', endpoints: ['/drift', '/drift/random', '/health'] })
})
app.get('/health', (req, res) => res.json({ ok: true }))

app.post('/drift', (req, res) => {
  const { author, title, content, timestamp, dimension, x, y, z } = req.body || {}
  if (typeof author !== 'string' || typeof content !== 'string') return res.status(400).json({ ok: false })
  const ts = typeof timestamp === 'number' ? timestamp : Date.now()
  const stmt = db.prepare('INSERT INTO messages (author, title, content, timestamp, dimension, x, y, z) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  stmt.run([author, title || '', content, ts, dimension || '', x || 0, y || 0, z || 0])
  saveDb()
  res.json({ ok: true })
})

// Root alias to POST /drift for clients posting to base URL
app.post('/', (req, res) => {
  req.url = '/drift'
  app._router.handle(req, res)
})

app.get('/drift', (req, res) => {
  const stmt = db.prepare('SELECT id, author, title, content, timestamp, dimension, x, y, z FROM messages ORDER BY id DESC LIMIT 100')
  const rows = []
  stmt.bind([])
  while (stmt.step()) {
    const [id, author, title, content, timestamp, dimension, x, y, z] = stmt.get()
    rows.push({ id, author, title, content, timestamp, dimension, x, y, z })
  }
  res.json(rows)
})

app.get('/drift/random', (req, res) => {
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
  res.json({ id, author, auth: author, title, content, timestamp, dimension, x, y, z })
})

// Root alias for GET /random for clients querying base + '/random'
app.get('/random', (req, res) => {
  req.url = '/drift/random'
  app._router.handle(req, res)
})

const port = process.env.PORT || 8080
app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}/`)
})

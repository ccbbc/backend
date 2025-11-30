const express = require('express');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let SQL = null;
let db = null;

// 适配 Zeabur 等平台的持久化存储
// 如果设置了 DATA_DIR 环境变量，将数据库文件存放在该目录下
const dataDir = process.env.DATA_DIR || __dirname;
if (process.env.DATA_DIR && !fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`Created data directory: ${dataDir}`);
  } catch (e) {
    console.error(`Failed to create data directory ${dataDir}:`, e);
  }
}
const dbPath = path.join(dataDir, 'drift.sqlite');
console.log(`Database path: ${dbPath}`);

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

async function init() {
  SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');
  db.run('CREATE TABLE IF NOT EXISTS bottles (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ("good","bad","normal")), reply_count INTEGER NOT NULL DEFAULT 0)');
  db.run('CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY AUTOINCREMENT, bottle_id INTEGER NOT NULL REFERENCES bottles(id) ON DELETE CASCADE, user TEXT NOT NULL, content TEXT NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT, morality INTEGER NOT NULL DEFAULT 0, banned_until INTEGER NOT NULL DEFAULT 0)');
  db.run('CREATE TABLE IF NOT EXISTS holds (id INTEGER PRIMARY KEY AUTOINCREMENT, bottle_id INTEGER NOT NULL REFERENCES bottles(id) ON DELETE CASCADE, holder TEXT NOT NULL, held_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS cooldowns (key TEXT PRIMARY KEY, until INTEGER NOT NULL, violation_count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0)');
  db.run('CREATE TABLE IF NOT EXISTS bans (key TEXT PRIMARY KEY, until INTEGER NOT NULL, reason TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS effects (id INTEGER PRIMARY KEY AUTOINCREMENT, bottle_id INTEGER NOT NULL REFERENCES bottles(id) ON DELETE CASCADE, effect_type TEXT NOT NULL, payload TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS memorials (id INTEGER PRIMARY KEY AUTOINCREMENT, bottle_id INTEGER UNIQUE NOT NULL REFERENCES bottles(id) ON DELETE CASCADE, participants TEXT NOT NULL, created_at INTEGER NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS dredge_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, bottle_id INTEGER NOT NULL REFERENCES bottles(id) ON DELETE CASCADE, user TEXT NOT NULL, timestamp INTEGER NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS memorial_claims (memorial_id INTEGER NOT NULL, player_id TEXT NOT NULL, obtained_at INTEGER NOT NULL, PRIMARY KEY (memorial_id, player_id))');
  const cols = stmtAll('PRAGMA table_info(bottles)');
  const hasIp = cols.some(r => r.name === 'ip');
  if (!hasIp) {
    db.run('ALTER TABLE bottles ADD COLUMN ip TEXT');
  }
  const hasArea = cols.some(r => r.name === 'area');
  if (!hasArea) db.run('ALTER TABLE bottles ADD COLUMN area TEXT');
  const hasExpires = cols.some(r => r.name === 'expires_at');
  if (!hasExpires) db.run('ALTER TABLE bottles ADD COLUMN expires_at INTEGER');
  const hasType = cols.some(r => r.name === 'type');
  if (!hasType) db.run('ALTER TABLE bottles ADD COLUMN type TEXT');
  const hasBC = cols.some(r => r.name === 'bless_curse');
  if (!hasBC) db.run('ALTER TABLE bottles ADD COLUMN bless_curse TEXT');
  const hasNameSend = cols.some(r => r.name === 'name_send');
  if (!hasNameSend) db.run('ALTER TABLE bottles ADD COLUMN name_send TEXT');
  const hasNameRecv = cols.some(r => r.name === 'name_recv');
  if (!hasNameRecv) db.run('ALTER TABLE bottles ADD COLUMN name_recv TEXT');
  const hasLastHolder = cols.some(r => r.name === 'last_holder');
  if (!hasLastHolder) db.run('ALTER TABLE bottles ADD COLUMN last_holder TEXT');
  saveDb();
}

app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

function stmtAll(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dayRange(now) {
  const offsetMs = 8 * 3600 * 1000;
  const start = Math.floor((now + offsetMs) / 86400000) * 86400000 - offsetMs;
  const end = start + 86400000;
  return { start, end };
}

function countByAuthor(author, start, end) {
  const rows = stmtAll('SELECT COUNT(1) AS c FROM bottles WHERE author = ? AND timestamp >= ? AND timestamp < ?', [author, start, end]);
  return rows[0] ? Number(rows[0].c) : 0;
}

function countIpOther(ip, author, start, end) {
  const rows = stmtAll('SELECT COUNT(1) AS c FROM bottles WHERE ip = ? AND author <> ? AND timestamp >= ? AND timestamp < ?', [ip, author, start, end]);
  return rows[0] ? Number(rows[0].c) : 0;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function blessCurse(morality) {
  const m = Number(morality) || 0;
  let bless = 0;
  let curse = 0;
  if (m >= 20) bless = clamp((m - 19) * 1, 0, 100);
  else if (m >= 0) bless = clamp(m * 2, 0, 100);
  if (m <= -20) curse = clamp((Math.abs(m) - 19) * 3, 0, 100);
  else if (m < 0) curse = clamp(Math.abs(m) * 2, 0, 100);
  const r = Math.random() * 100;
  if (r < curse) return 'curse';
  if (r < curse + bless) return 'bless';
  return 'none';
}

function getMorality(playerId) {
  const rows = stmtAll('SELECT morality FROM players WHERE id = ?', [playerId]);
  return rows[0] ? Number(rows[0].morality) : 0;
}

function setMorality(playerId, delta) {
  const rows = stmtAll('SELECT morality FROM players WHERE id = ?', [playerId]);
  if (rows[0]) {
    const next = clamp(Number(rows[0].morality) + Number(delta), -50, 50);
    db.run('UPDATE players SET morality = ? WHERE id = ?', [next, playerId]);
  } else {
    const next = clamp(Number(delta), -50, 50);
    db.run('INSERT INTO players (id, morality) VALUES (?, ?)', [playerId, next]);
  }
}

function getCooldown(key) {
  const rows = stmtAll('SELECT until, violation_count, window_start FROM cooldowns WHERE key = ?', [key]);
  if (!rows[0]) return { until: 0, violation_count: 0, window_start: 0 };
  return { until: Number(rows[0].until), violation_count: Number(rows[0].violation_count), window_start: Number(rows[0].window_start) };
}

function setCooldown(key, until, violationCount, windowStart) {
  const rows = stmtAll('SELECT key FROM cooldowns WHERE key = ?', [key]);
  if (rows[0]) db.run('UPDATE cooldowns SET until = ?, violation_count = ?, window_start = ? WHERE key = ?', [until, violationCount, windowStart, key]);
  else db.run('INSERT INTO cooldowns (key, until, violation_count, window_start) VALUES (?, ?, ?, ?)', [key, until, violationCount, windowStart]);
}

function getBan(key) {
  const rows = stmtAll('SELECT until FROM bans WHERE key = ?', [key]);
  return rows[0] ? Number(rows[0].until) : 0;
}

function setBan(key, hours) {
  const until = Date.now() + hours * 3600000;
  const rows = stmtAll('SELECT key FROM bans WHERE key = ?', [key]);
  if (rows[0]) db.run('UPDATE bans SET until = ? WHERE key = ?', [until, key]);
  else db.run('INSERT INTO bans (key, until, reason) VALUES (?, ?, ?)', [key, until, 'auto']);
}

function checkAndRecordMemorialClaim(memorialId, playerId) {
  const now = Date.now();
  const rows = stmtAll('SELECT obtained_at FROM memorial_claims WHERE memorial_id = ? AND player_id = ?', [memorialId, playerId]);
  if (rows[0]) {
    const last = Number(rows[0].obtained_at);
    if (now - last < 7 * 24 * 3600 * 1000) return false;
    db.run('UPDATE memorial_claims SET obtained_at = ? WHERE memorial_id = ? AND player_id = ?', [now, memorialId, playerId]);
    return true;
  } else {
    db.run('INSERT INTO memorial_claims (memorial_id, player_id, obtained_at) VALUES (?, ?, ?)', [memorialId, playerId, now]);
    return true;
  }
}

 

app.get('/bottles', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const area = typeof req.query.area === 'string' ? req.query.area : '';
  const type = typeof req.query.type === 'string' ? req.query.type : '';
  const sender = typeof req.query.sender === 'string' ? req.query.sender : '';
  const where = ['1=1'];
  const params = [];
  if (area) { where.push('area = ?'); params.push(area); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (sender) { where.push('author = ?'); params.push(sender); }
  const sql = 'SELECT id, item_id, author, content, timestamp, kind, reply_count, area, type, bless_curse, name_send, name_recv FROM bottles WHERE ' + where.join(' AND ') + ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const rows = stmtAll(sql, params);
  res.status(200).json(rows);
});

app.get('/bottles/:id', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid_id' }); return; }
  const bList = stmtAll('SELECT id, item_id, author, content, timestamp, kind, reply_count, area, type, bless_curse, name_send, name_recv FROM bottles WHERE id = ?', [id]);
  if (bList.length === 0) { res.status(404).json({ error: 'not_found' }); return; }
  const replies = stmtAll('SELECT id, user, content FROM replies WHERE bottle_id = ? ORDER BY id ASC', [id]);
  const bottle = bList[0];
  bottle.replies = replies;
  res.status(200).json(bottle);
});

function createBottleCommon(req, res) {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const body = req.body || {};
  const item_id = typeof body.item_id === 'string' ? body.item_id : '';
  const author = typeof body.author === 'string' ? body.author : '';
  const content = typeof body.content === 'string' ? body.content : '';
  const kind = typeof body.kind === 'string' ? body.kind : 'normal';
  const type = typeof body.type === 'string' ? body.type : 'message';
  const now = Date.now();
  const { start, end } = dayRange(now);
  const replies = Array.isArray(body.replies) ? body.replies : [];
  const reply_to = Number(body.reply_to || 0);
  if ((!item_id && !(Number.isFinite(reply_to) && reply_to > 0)) || !author) { res.status(400).json({ error: 'invalid_payload' }); return; }
  if (!['good', 'bad', 'normal'].includes(kind)) { res.status(400).json({ error: 'invalid_kind' }); return; }
  const xf = req.headers['x-forwarded-for'];
  const ip = Array.isArray(xf) ? xf[0] : (typeof xf === 'string' ? xf.split(',')[0].trim() : (req.ip || ''));
  const pBan = getBan('player:' + author);
  const iBan = getBan('ip:' + ip);
  if (pBan > now || iBan > now) { res.status(403).json({ error_code: 302, until: Math.max(pBan, iBan) }); return; }
  if (Number.isFinite(reply_to) && reply_to > 0) {
    if (!content.trim()) { res.status(400).json({ error_code: 701 }); return; }
    const bRows = stmtAll('SELECT id, reply_count, author, area FROM bottles WHERE id = ?', [reply_to]);
    if (!bRows[0]) { res.status(404).json({ error: 'not_found' }); return; }
    if (String(bRows[0].author) === author) { res.status(400).json({ error_code: 702 }); return; }
    const hRows = stmtAll('SELECT COUNT(1) AS c FROM holds WHERE bottle_id = ? AND holder = ? AND expires_at > ?', [reply_to, author, now]);
    const hasHold = hRows[0] ? Number(hRows[0].c) > 0 : false;
    if (!hasHold) { res.status(400).json({ error_code: 703 }); return; }
    const rc = Number(bRows[0].reply_count);
    if (rc >= 5) { res.status(429).json({ error_code: 501 }); return; }
    db.run('BEGIN');
    const stmt = db.prepare('INSERT INTO replies (bottle_id, user, content) VALUES (?, ?, ?)');
    stmt.run([reply_to, author, content]);
    stmt.free();
    db.run('UPDATE bottles SET reply_count = reply_count + 1, area = ? WHERE id = ?', ['main', reply_to]);
    db.run('DELETE FROM holds WHERE bottle_id = ? AND holder = ?', [reply_to, author]);
    const newRows = stmtAll('SELECT reply_count FROM bottles WHERE id = ?', [reply_to]);
    const newRc = newRows[0] ? Number(newRows[0].reply_count) : rc + 1;
    let memorialId = null;
    if (newRc >= 5) {
      const participants = JSON.stringify([bRows[0].author, author]);
      db.run('INSERT OR IGNORE INTO memorials (bottle_id, participants, created_at) VALUES (?, ?, ?)', [reply_to, participants, now]);
      const memRows = stmtAll('SELECT id FROM memorials WHERE bottle_id = ?', [reply_to]);
      if (memRows[0]) memorialId = memRows[0].id;
      db.run('UPDATE bottles SET area = ? WHERE id = ?', ['memorial', reply_to]);
    }
    if (memorialId && !checkAndRecordMemorialClaim(memorialId, author)) memorialId = null;
    db.run('COMMIT');
    saveDb();
    console.log(`[REPLY_DIRECT] Author ${author} replied to bottle ${reply_to} (rc=${newRc})`);
    res.status(200).json({ ok: true, id: reply_to, reply_count: newRc, memorial_id: memorialId });
    return;
  }
  const pCd = getCooldown('player:' + author);
  const iCd = getCooldown('ip:' + ip);
  if (pCd.until > now) { res.status(429).json({ error_code: 301, retry_after: Math.ceil((pCd.until - now)/1000) }); return; }
  if (iCd.until > now) { res.status(429).json({ error_code: 301, retry_after: Math.ceil((iCd.until - now)/1000) }); return; }
  const aCount = countByAuthor(author, start, end);
  if (aCount >= 5) { res.status(429).json({ error_code: 201 }); return; }
  const iRows = stmtAll('SELECT COUNT(1) AS c FROM bottles WHERE ip = ? AND timestamp >= ? AND timestamp < ?', [ip, start, end]);
  const iCount = iRows[0] ? Number(iRows[0].c) : 0;
  if (iCount >= 10) { res.status(429).json({ error_code: 202 }); return; }
  const cdUntil = now + 120000;
  setCooldown('player:' + author, cdUntil, 0, now);
  setCooldown('ip:' + ip, cdUntil, 0, now);
  
  // 1. Update morality first
  let delta = 0;
  if (kind === 'good') delta = 1;
  else if (kind === 'bad') delta = -5;
  if (delta !== 0) setMorality(author, delta);

  // 2. Calculate bless/curse based on UPDATED morality
  const morality = getMorality(author);
  const bc = blessCurse(morality);
  const name_send = type + '·' + (bc === 'none' ? '' : (bc === 'bless' ? '祝福' : '诅咒'));
  const expires_at = now + 7*24*3600000;

  db.run('BEGIN');
  db.run('INSERT INTO bottles (item_id, author, content, timestamp, kind, reply_count, ip, area, expires_at, type, bless_curse, name_send) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item_id, author, content, now, kind, replies.length, ip, 'main', expires_at, type, bc, name_send]);
  const idRows = db.exec('SELECT last_insert_rowid() AS id');
  const id = idRows && idRows[0] && idRows[0].values && idRows[0].values[0] ? idRows[0].values[0][0] : null;
  if (replies.length > 0 && id != null) {
    const stmt = db.prepare('INSERT INTO replies (bottle_id, user, content) VALUES (?, ?, ?)');
    for (const r of replies) {
      const u = typeof r.user === 'string' ? r.user : '';
      const c = typeof r.content === 'string' ? r.content : '';
      stmt.run([id, u, c]);
    }
    stmt.free();
  }
  db.run('COMMIT');
  saveDb();
  console.log(`[CREATE] Author ${author} created bottle ${id} (area=main)`);
  res.status(201).json({ id });
}

app.post('/', (req, res) => { createBottleCommon(req, res); });
app.post('/bottles', (req, res) => { createBottleCommon(req, res); });

 

app.post('/fish', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const body = req.body || {};
  const player = typeof body.player === 'string' ? body.player : '';
  if (!player) { res.status(400).json({ error: 'invalid_payload' }); return; }
  const holdRows = stmtAll('SELECT COUNT(1) AS c FROM holds WHERE holder = ? AND expires_at > ?', [player, Date.now()]);
  const holding = holdRows[0] ? Number(holdRows[0].c) : 0;
  if (holding > 0) { res.status(429).json({ error_code: 601, message: '您有待回复的漂流瓶，请先处理' }); return; }
  const morality = getMorality(player);
  let best = null;
  // ... existing logic for selecting bottle ...

  if (morality >= 0) {
    const rows = stmtAll('SELECT id, type, kind, bless_curse, author, reply_count FROM bottles WHERE area = ? AND reply_count < 5 AND author <> ? AND id NOT IN (SELECT bottle_id FROM replies WHERE user = ?) AND (kind = ? OR bless_curse = ?) ORDER BY RANDOM() LIMIT 1', ['main', player, player, 'good', 'bless']);
    if (rows.length > 0) best = rows[0];
  } else {
    const rows = stmtAll('SELECT id, type, kind, bless_curse, author, reply_count FROM bottles WHERE area = ? AND reply_count < 5 AND author <> ? AND id NOT IN (SELECT bottle_id FROM replies WHERE user = ?) AND (kind = ? OR bless_curse = ?) ORDER BY RANDOM() LIMIT 1', ['main', player, player, 'bad', 'curse']);
    if (rows.length > 0) best = rows[0];
  }
  if (!best) {
    const rows = stmtAll('SELECT id, type, kind, bless_curse, author, reply_count FROM bottles WHERE area = ? AND reply_count < 5 AND author <> ? AND id NOT IN (SELECT bottle_id FROM replies WHERE user = ?) ORDER BY RANDOM() LIMIT 1', ['main', player, player]);
    if (rows.length > 0) best = rows[0];
  }
  if (!best) { res.status(404).json({ error: 'no_bottle' }); return; }
  const now = Date.now();
  const expires = now + 3600000;
  
  // Fetch full details and replies
  const fullRows = stmtAll('SELECT id, item_id, author, content, timestamp, kind, reply_count, area, type, bless_curse, name_send, name_recv FROM bottles WHERE id = ?', [best.id]);
  const fullBottle = fullRows[0] || best;
  const replies = stmtAll('SELECT user, content FROM replies WHERE bottle_id = ? ORDER BY id ASC', [best.id]);
  fullBottle.replies = replies;

  db.run('BEGIN');
  db.run('INSERT INTO holds (bottle_id, holder, held_at, expires_at) VALUES (?, ?, ?, ?)', [best.id, player, now, expires]);
  db.run('UPDATE bottles SET area = ?, last_holder = ?, name_recv = ? WHERE id = ?', ['temp', player, player + '的' + (best.type || '瓶') + '·' + (best.bless_curse === 'none' ? '' : (best.bless_curse === 'bless' ? '祝福' : '诅咒')), best.id]);
  db.run('COMMIT');
  saveDb();
  console.log(`[FISH] Player ${player} fished bottle ${best.id} (expires=${expires})`);
  
  // Map bless_curse to status: normal, curse, bless
  let status = 'normal';
  if (fullBottle.bless_curse === 'bless') status = 'bless';
  else if (fullBottle.bless_curse === 'curse') status = 'curse';
  
  res.status(200).json({ 
    id: best.id, 
    item_id: fullBottle.item_id, 
    status: status,
    expires_at: expires, 
    bottle: fullBottle 
  });
});

app.post('/bottles/:id/reply', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const id = Number(req.params.id);
  const body = req.body || {};
  const user = typeof body.user === 'string' ? body.user : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!Number.isFinite(id) || !user) { res.status(400).json({ error: 'invalid_payload' }); return; }
  if (!content.trim()) { res.status(400).json({ error_code: 701 }); return; }
  const rows = stmtAll('SELECT id, reply_count, area, author FROM bottles WHERE id = ?', [id]);
  if (!rows[0]) { res.status(404).json({ error: 'not_found' }); return; }
  if (String(rows[0].author) === user) { res.status(400).json({ error_code: 702 }); return; }
  const holdRows = stmtAll('SELECT COUNT(1) AS c FROM holds WHERE bottle_id = ? AND holder = ? AND expires_at > ?', [id, user, Date.now()]);
  const hasHold = holdRows[0] ? Number(holdRows[0].c) > 0 : false;
  if (!hasHold) { res.status(400).json({ error_code: 703 }); return; }
  const rc = Number(rows[0].reply_count);
  if (rc >= 5) { res.status(429).json({ error_code: 501 }); return; }
  db.run('BEGIN');
  const stmt = db.prepare('INSERT INTO replies (bottle_id, user, content) VALUES (?, ?, ?)');
  stmt.run([id, user, content]);
  stmt.free();
  db.run('UPDATE bottles SET reply_count = reply_count + 1, area = ? WHERE id = ?', ['main', id]);
  db.run('DELETE FROM holds WHERE bottle_id = ? AND holder = ?', [id, user]);
  const newRows = stmtAll('SELECT reply_count FROM bottles WHERE id = ?', [id]);
  const newRc = newRows[0] ? Number(newRows[0].reply_count) : rc + 1;
  let memorialId = null;
  if (newRc >= 5) {
    const partsRows = stmtAll('SELECT author FROM bottles WHERE id = ?', [id]);
    const participants = JSON.stringify([partsRows[0] ? partsRows[0].author : user, user]);
    db.run('INSERT OR IGNORE INTO memorials (bottle_id, participants, created_at) VALUES (?, ?, ?)', [id, participants, Date.now()]);
    const memRows = stmtAll('SELECT id FROM memorials WHERE bottle_id = ?', [id]);
    if (memRows[0]) memorialId = memRows[0].id;
    db.run('UPDATE bottles SET area = ? WHERE id = ?', ['memorial', id]);
  }
  if (memorialId && !checkAndRecordMemorialClaim(memorialId, user)) memorialId = null;
  db.run('COMMIT');
  saveDb();
  console.log(`[REPLY] User ${user} replied to bottle ${id} (rc=${newRc})`);
  res.status(200).json({ ok: true, reply_count: newRc, memorial_id: memorialId });
});

app.get('/memorials', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const rows = stmtAll('SELECT bottle_id, participants, created_at FROM memorials ORDER BY created_at DESC');
  res.status(200).json(rows);
});

app.get('/limits/check', (req, res) => {
  const now = Date.now();
  const body = req.query || {};
  const author = typeof body.author === 'string' ? body.author : '';
  const xf = req.headers['x-forwarded-for'];
  const ip = Array.isArray(xf) ? xf[0] : (typeof xf === 'string' ? xf.split(',')[0].trim() : (req.ip || ''));
  const { start, end } = dayRange(now);
  const aRows = stmtAll('SELECT COUNT(1) AS c FROM bottles WHERE author = ? AND timestamp >= ? AND timestamp < ?', [author, start, end]);
  const iRows = stmtAll('SELECT COUNT(1) AS c FROM bottles WHERE ip = ? AND timestamp >= ? AND timestamp < ?', [ip, start, end]);
  const pCd = getCooldown('player:' + author);
  const iCd = getCooldown('ip:' + ip);
  const pBan = getBan('player:' + author);
  const iBan = getBan('ip:' + ip);
  res.status(200).json({ author_count: aRows[0] ? Number(aRows[0].c) : 0, ip_count: iRows[0] ? Number(iRows[0].c) : 0, player_cd_until: pCd.until, ip_cd_until: iCd.until, ban_until: Math.max(pBan, iBan) });
});

app.post('/holds/:id/consume', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid_id' }); return; }
  const rows = stmtAll('SELECT bottle_id FROM holds WHERE id = ?', [id]);
  if (!rows[0]) { res.status(404).json({ error: 'not_found' }); return; }
  db.run('BEGIN');
  db.run('DELETE FROM holds WHERE id = ?', [id]);
  db.run('UPDATE bottles SET area = ? WHERE id = ?', ['main', rows[0].bottle_id]);
  db.run('COMMIT');
  saveDb();
  res.status(200).json({ ok: true });
});

app.post('/bottles/:id/retrieve', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const id = Number(req.params.id);
  const body = req.body || {};
  const user = typeof body.user === 'string' ? body.user : '';
  if (!Number.isFinite(id) || !user) { res.status(400).json({ error: 'invalid_payload' }); return; }
  const rows = stmtAll('SELECT id, author, kind, area FROM bottles WHERE id = ?', [id]);
  if (!rows[0]) { res.status(404).json({ error: 'not_found' }); return; }
  if (rows[0].author !== user) { res.status(403).json({ error: 'forbidden' }); return; }
  let delta = 0;
  if (rows[0].kind === 'good') delta = -1;
  else if (rows[0].kind === 'bad') delta = 5;
  if (delta !== 0) setMorality(user, delta);
  res.status(200).json({ ok: true });
});

app.post('/memorials/:id/dredge', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const id = Number(req.params.id);
  const body = req.body || {};
  const user = typeof body.user === 'string' ? body.user : '';
  if (!Number.isFinite(id) || !user) { res.status(400).json({ error: 'invalid_payload' }); return; }
  const dupRows = stmtAll('SELECT timestamp FROM dredge_logs WHERE bottle_id = ? AND user = ? ORDER BY timestamp DESC LIMIT 1', [id, user]);
  const lastTs = dupRows[0] ? Number(dupRows[0].timestamp) : 0;
  if (lastTs && (Date.now() - lastTs) < 7*24*3600000) { res.status(429).json({ error_code: 801, message: '7天内只能获取一次相同纪念册，请耐心等待' }); return; }
  const bRows = stmtAll('SELECT id, item_id, author, content, kind, area FROM bottles WHERE id = ?', [id]);
  if (!bRows[0]) { res.status(404).json({ error: 'not_found' }); return; }
  if (String(bRows[0].area) !== 'memorial') { res.status(409).json({ error: 'not_memorial' }); return; }
  const author = String(bRows[0].author);
  if (author !== user) {
    const rpRows = stmtAll('SELECT COUNT(1) AS c FROM replies WHERE bottle_id = ? AND user = ?', [id, user]);
    const ok = rpRows[0] ? Number(rpRows[0].c) > 0 : false;
    if (!ok) { res.status(403).json({ error: 'forbidden' }); return; }
  }
  const rRows = stmtAll('SELECT id, user, content FROM replies WHERE bottle_id = ? ORDER BY id ASC', [id]);
  db.run('INSERT INTO dredge_logs (bottle_id, user, timestamp) VALUES (?, ?, ?)', [id, user, Date.now()]);
  res.status(200).json({ bottle: { id: bRows[0].id, item_id: bRows[0].item_id, author: bRows[0].author, content: bRows[0].content, kind: bRows[0].kind }, replies: rRows });
});

app.post('/dredge', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const body = req.body || {};
  const user = typeof body.user === 'string' ? body.user : '';
  const id = Number(body.id);
  if (!user || !Number.isFinite(id)) { res.status(400).json({ error: 'invalid_payload' }); return; }
  
  const holdRows = stmtAll('SELECT COUNT(1) AS c FROM holds WHERE holder = ? AND expires_at > ?', [user, Date.now()]);
  const holding = holdRows[0] ? Number(holdRows[0].c) : 0;
  if (holding > 0) { res.status(429).json({ error_code: 601, message: '您有待回复的漂流瓶，请先处理' }); return; }

  const dupRows = stmtAll('SELECT timestamp FROM dredge_logs WHERE bottle_id = ? AND user = ? ORDER BY timestamp DESC LIMIT 1', [id, user]);
  const lastTs = dupRows[0] ? Number(dupRows[0].timestamp) : 0;
  if (lastTs && (Date.now() - lastTs) < 7*24*3600000) { res.status(429).json({ error_code: 801, message: '7天内只能获取一次相同纪念册，请耐心等待' }); return; }

  const bRows = stmtAll('SELECT id, item_id, author, content, kind, area FROM bottles WHERE id = ?', [id]);
  if (!bRows[0]) { res.status(404).json({ error: 'not_found' }); return; }
  if (String(bRows[0].area) !== 'memorial') { res.status(409).json({ error: 'not_memorial' }); return; }
  const author = String(bRows[0].author);
  if (author !== user) {
    const rpRows = stmtAll('SELECT COUNT(1) AS c FROM replies WHERE bottle_id = ? AND user = ?', [id, user]);
    const ok = rpRows[0] ? Number(rpRows[0].c) > 0 : false;
    if (!ok) { res.status(403).json({ error: 'forbidden' }); return; }
  }
  const rRows = stmtAll('SELECT id, user, content FROM replies WHERE bottle_id = ? ORDER BY id ASC', [id]);
  db.run('INSERT INTO dredge_logs (bottle_id, user, timestamp) VALUES (?, ?, ?)', [id, user, Date.now()]);
  res.status(200).json({ bottle: { id: bRows[0].id, item_id: bRows[0].item_id, author: bRows[0].author, content: bRows[0].content, kind: bRows[0].kind }, replies: rRows });
});

app.get('/players/:id/morality', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const id = String(req.params.id);
  const m = getMorality(id);
  res.status(200).json({ id, morality: m });
});

app.post('/players/:id/morality/apply', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const id = String(req.params.id);
  const body = req.body || {};
  const delta = Number(body.delta) || 0;
  setMorality(id, delta);
  res.status(200).json({ id, morality: getMorality(id) });
});

app.post('/holds/:id/release', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid_id' }); return; }
  const rows = stmtAll('SELECT bottle_id FROM holds WHERE id = ?', [id]);
  if (!rows[0]) { res.status(404).json({ error: 'not_found' }); return; }
  db.run('BEGIN');
  db.run('DELETE FROM holds WHERE id = ?', [id]);
  db.run('UPDATE bottles SET area = ? WHERE id = ?', ['main', rows[0].bottle_id]);
  db.run('COMMIT');
  saveDb();
  res.status(200).json({ ok: true });
});

app.post('/holds/release-player', (req, res) => {
  if (!db) { res.status(503).json({ error: 'not_ready' }); return; }
  const body = req.body || {};
  const player = typeof body.player === 'string' ? body.player : '';
  if (!player) { res.status(400).json({ error: 'invalid_payload' }); return; }
  const rows = stmtAll('SELECT id, bottle_id FROM holds WHERE holder = ?', [player]);
  db.run('BEGIN');
  for (const r of rows) {
    db.run('DELETE FROM holds WHERE id = ?', [r.id]);
    db.run('UPDATE bottles SET area = ? WHERE id = ?', ['main', r.bottle_id]);
  }
  db.run('COMMIT');
  saveDb();
  res.status(200).json({ released: rows.length });
});

setInterval(() => {
  if (!db) return;
  const now = Date.now();
  const rows = stmtAll('SELECT id, reply_count FROM bottles WHERE area = ? AND expires_at IS NOT NULL AND expires_at <= ?', ['main', now]);
  for (const r of rows) {
    if (Number(r.reply_count) === 0) db.run('DELETE FROM bottles WHERE id = ?', [r.id]);
    else {
      const partsRows = stmtAll('SELECT author FROM bottles WHERE id = ?', [r.id]);
      const participants = JSON.stringify([partsRows[0] ? partsRows[0].author : '']);
      db.run('INSERT OR IGNORE INTO memorials (bottle_id, participants, created_at) VALUES (?, ?, ?)', [r.id, participants, now]);
      db.run('UPDATE bottles SET area = ?, expires_at = NULL WHERE id = ?', ['memorial', r.id]);
    }
  }
  const hRows = stmtAll('SELECT id, bottle_id FROM holds WHERE expires_at <= ?', [now]);
  for (const h of hRows) {
    db.run('DELETE FROM holds WHERE id = ?', [h.id]);
    db.run('UPDATE bottles SET area = ? WHERE id = ?', ['main', h.bottle_id]);
  }
  saveDb();
}, 300000);

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const host = process.env.HOST || '0.0.0.0';

init().then(() => {
  app.listen(port, host, () => {});
});

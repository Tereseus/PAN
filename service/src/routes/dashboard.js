import { Router } from 'express';
import { all, get, run, insert, DB_PATH } from '../db.js';
import { statSync } from 'fs';
import { createHash } from 'crypto';

const router = Router();

// Password verification for delete operations
// Password is stored as SHA-256 hash in the settings table
// Default password on first use: "pan" (user should change it)
function hashPassword(pw) {
  return createHash('sha256').update(pw).digest('hex');
}

// Ensure settings table exists on first load
try {
  run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
} catch {}

function getOrCreatePassword() {
  const existing = get("SELECT value FROM settings WHERE key = 'delete_password'");
  if (existing) return existing.value;
  const defaultHash = hashPassword('pan');
  run("INSERT OR REPLACE INTO settings (key, value) VALUES ('delete_password', :hash)", { ':hash': defaultHash });
  return defaultHash;
}

router.post('/api/verify-password', (req, res) => {
  const { password } = req.body;
  if (!password) return res.json({ valid: false });
  const storedHash = getOrCreatePassword();
  const inputHash = hashPassword(password);
  res.json({ valid: storedHash === inputHash });
});

router.post('/api/change-password', (req, res) => {
  const { current, newPassword } = req.body;
  if (!current || !newPassword) return res.status(400).json({ error: 'missing fields' });
  const storedHash = getOrCreatePassword();
  if (hashPassword(current) !== storedHash) return res.json({ success: false, error: 'wrong password' });
  run("INSERT OR REPLACE INTO settings (key, value) VALUES ('delete_password', :hash)", { ':hash': hashPassword(newPassword) });
  res.json({ success: true });
});

// GET /dashboard/api/search?q=text — search all events by transcript text
router.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  const results = all(`SELECT * FROM events WHERE data LIKE :q ORDER BY created_at DESC LIMIT 50`, {
    ':q': `%${q}%`
  });
  res.json(results);
});

// GET /dashboard/api/events?type=X&limit=50&offset=0&date=2026-03-20&q=search
router.get('/api/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const type = req.query.type || null;
  const date = req.query.date || null;
  const search = req.query.q || null;

  let where = [];
  let params = {};

  if (type) {
    where.push("event_type = :type");
    params[':type'] = type;
  }
  if (date) {
    where.push("date(created_at) = :date");
    params[':date'] = date;
  }
  if (search) {
    where.push("data LIKE :q");
    params[':q'] = `%${search}%`;
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = get(`SELECT COUNT(*) as count FROM events ${whereClause}`, params);
  const events = all(
    `SELECT * FROM events ${whereClause} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    { ...params, ':limit': limit, ':offset': offset }
  );

  res.json({ events, total: total?.count || 0, limit, offset });
});

// GET /dashboard/api/stats
router.get('/api/stats', (req, res) => {
  const stats = get(`SELECT
    (SELECT COUNT(*) FROM events) as total_events,
    (SELECT COUNT(*) FROM memory_items) as total_memory,
    (SELECT COUNT(*) FROM sessions) as total_sessions,
    (SELECT COUNT(*) FROM projects) as total_projects,
    (SELECT COUNT(*) FROM devices) as total_devices,
    (SELECT COUNT(DISTINCT event_type) FROM events) as event_types
  `);

  let dbSize = 0;
  try {
    dbSize = statSync(DB_PATH).size;
  } catch {}

  const eventTypes = all(`SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type ORDER BY count DESC`);

  res.json({ ...stats, db_size_bytes: dbSize, event_types: eventTypes });
});

// GET /dashboard/api/memory
router.get('/api/memory', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const total = get(`SELECT COUNT(*) as count FROM memory_items`);
  const items = all(
    `SELECT * FROM memory_items ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    { ':limit': limit, ':offset': offset }
  );
  res.json({ items, total: total?.count || 0 });
});

// GET /dashboard/api/conversations?limit=50&filter=voice&q=searchtext
router.get('/api/conversations', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const filter = req.query.filter || 'all';
  const search = req.query.q || '';

  // Map filter to event types
  const filterMap = {
    'all': "('RouterCommand', 'PhoneAudio', 'PandantPhoto', 'SensorData', 'SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit')",
    'voice': "('RouterCommand', 'PhoneAudio')",
    'commands': "('RouterCommand')",
    'photos': "('PandantPhoto')",
    'sensors': "('SensorData')",
    'system': "('SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit')",
  };
  const typeFilter = filterMap[filter] || filterMap['all'];

  let whereClause = `WHERE event_type IN ${typeFilter}`;
  const params = { ':limit': limit, ':offset': offset };

  if (search) {
    whereClause += ` AND data LIKE :q`;
    params[':q'] = `%${search}%`;
  }

  const events = all(
    `SELECT * FROM events ${whereClause} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    params
  );

  const total = get(`SELECT COUNT(*) as count FROM events ${whereClause}`, params);

  const conversations = events.map(e => {
    let data = {};
    try { data = JSON.parse(e.data); } catch {}
    return {
      id: e.id,
      event_type: e.event_type,
      session_id: e.session_id,
      created_at: e.created_at,
      transcript: data.transcript || data.user_text || data.text || '',
      response: data.response || data.response_text || '',
      route: data.route || data.intent || '',
      model: data.model || '',
      response_time_ms: data.response_time_ms || data.duration_ms || null,
      data
    };
  });

  res.json({ conversations, total: total?.count || 0 });
});

// GET /dashboard/api/projects
router.get('/api/projects', (req, res) => {
  const projects = all(`SELECT * FROM projects ORDER BY name`);
  res.json(projects);
});

// GET /dashboard/api/devices
router.get('/api/devices', (req, res) => {
  const devices = all(`SELECT * FROM devices ORDER BY last_seen DESC`);
  res.json(devices);
});

// GET /dashboard/api/sessions
router.get('/api/sessions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const sessions = all(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT :limit`, { ':limit': limit });
  res.json(sessions);
});

// DELETE /dashboard/api/events/:id
router.delete('/api/events/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const existing = get(`SELECT id FROM events WHERE id = :id`, { ':id': id });
  if (!existing) return res.status(404).json({ error: 'not found' });

  run(`DELETE FROM events WHERE id = :id`, { ':id': id });
  res.json({ ok: true, deleted: id });
});

// DELETE /dashboard/api/events/bulk?type=X&date=X&q=search — bulk delete matching events
router.delete('/api/events/bulk', (req, res) => {
  if (req.query.confirm !== 'yes') return res.status(400).json({ error: 'missing confirm' });

  let where = [];
  let params = {};
  if (req.query.type) { where.push("event_type = :type"); params[':type'] = req.query.type; }
  if (req.query.date) { where.push("date(created_at) = :date"); params[':date'] = req.query.date; }
  if (req.query.q) { where.push("data LIKE :q"); params[':q'] = `%${req.query.q}%`; }

  if (where.length === 0) return res.status(400).json({ error: 'no filters specified' });

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const count = get(`SELECT COUNT(*) as count FROM events ${whereClause}`, params);
  run(`DELETE FROM events ${whereClause}`, params);
  res.json({ ok: true, deleted_count: count?.count || 0 });
});

// DELETE /dashboard/api/events/day/:date
router.delete('/api/events/day/:date', (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid date format, use YYYY-MM-DD' });
  }

  const count = get(`SELECT COUNT(*) as count FROM events WHERE date(created_at) = :date`, { ':date': date });
  run(`DELETE FROM events WHERE date(created_at) = :date`, { ':date': date });
  res.json({ ok: true, deleted_count: count?.count || 0, date });
});

// DELETE /dashboard/api/memory/:id
router.delete('/api/memory/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const existing = get(`SELECT id FROM memory_items WHERE id = :id`, { ':id': id });
  if (!existing) return res.status(404).json({ error: 'not found' });

  run(`DELETE FROM memory_items WHERE id = :id`, { ':id': id });
  res.json({ ok: true, deleted: id });
});

// DELETE /dashboard/api/all?confirm=yes
router.delete('/api/all', (req, res) => {
  if (req.query.confirm !== 'yes') {
    return res.status(400).json({ error: 'must pass ?confirm=yes' });
  }

  run(`DELETE FROM events`);
  run(`DELETE FROM memory_items`);
  run(`DELETE FROM sessions`);
  run(`DELETE FROM command_queue`);
  run(`DELETE FROM command_logs`);

  res.json({ ok: true, message: 'all data deleted' });
});

export default router;

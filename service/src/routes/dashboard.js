import { Router } from 'express';
import { all, get, run, insert, DB_PATH } from '../db.js';
import { statSync, readdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = join(__dirname2, '..', 'data', 'photos');

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

// GET /dashboard/api/photos — list all captured photos
router.get('/api/photos', (req, res) => {
  if (!existsSync(PHOTOS_DIR)) return res.json([]);
  try {
    const files = readdirSync(PHOTOS_DIR)
      .filter(f => f.endsWith('.jpg') || f.endsWith('.png'))
      .map(f => {
        const stat = statSync(join(PHOTOS_DIR, f));
        // Find matching vision event
        const event = get("SELECT * FROM events WHERE event_type = 'VisionAnalysis' AND data LIKE :f ORDER BY created_at DESC LIMIT 1",
          { ':f': `%${f}%` });
        let description = '';
        let question = '';
        if (event) {
          try {
            const d = JSON.parse(event.data);
            description = d.description || '';
            question = d.question || '';
          } catch {}
        }
        return {
          filename: f,
          url: `/photos/${f}`,
          size: stat.size,
          created: stat.mtime.toISOString(),
          description,
          question
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// DELETE /dashboard/api/photos/:filename
router.delete('/api/photos/:filename', (req, res) => {
  const f = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
  const path = join(PHOTOS_DIR, f);
  try {
    if (existsSync(path)) unlinkSync(path);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /dashboard/api/jobs — list scheduled jobs and running processes
router.get('/api/jobs', async (req, res) => {
  const jobs = [];

  // Check Windows scheduled tasks for PAN
  try {
    const { execSync } = await import('child_process');

    // Get PAN scheduled tasks
    const taskOutput = execSync(
      'schtasks /query /tn "PAN-VoiceTraining" /fo CSV /nh 2>nul || echo "not found"',
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();

    if (!taskOutput.includes('not found')) {
      const parts = taskOutput.split(',').map(s => s.replace(/"/g, ''));
      jobs.push({
        name: 'Voice Training',
        description: 'Piper voice model training — transcribe + train overnight',
        type: 'scheduled_task',
        status: parts[2]?.trim()?.toLowerCase() || 'unknown',
        schedule: 'Daily at 12:00 AM EST',
        next_run: parts[1]?.trim() || null,
      });
    }
  } catch {}

  // PAN Service status
  jobs.push({
    name: 'PAN Service',
    description: 'Core server on port 7777 — hooks, API, dashboard',
    type: 'service',
    status: 'running',
    schedule: 'Auto-start on boot (Windows Service)',
  });

  // Voice Recorder
  try {
    const { execSync } = await import('child_process');
    const procs = execSync('tasklist /fi "IMAGENAME eq python.exe" /fo CSV /nh 2>nul', {
      encoding: 'utf-8', timeout: 5000
    });
    const recorderRunning = procs.includes('python.exe');
    jobs.push({
      name: 'Voice Recorder',
      description: 'Hotkey-triggered mic recording for voice training data',
      type: 'process',
      status: recorderRunning ? 'running' : 'stopped',
      schedule: 'Triggered by mouse side button (XButton1/XButton2)',
    });
  } catch {
    jobs.push({
      name: 'Voice Recorder',
      description: 'Hotkey-triggered mic recording',
      type: 'process',
      status: 'unknown',
    });
  }

  // Electron Tray
  try {
    const { execSync } = await import('child_process');
    const procs = execSync('tasklist /fi "IMAGENAME eq electron.exe" /fo CSV /nh 2>nul', {
      encoding: 'utf-8', timeout: 5000
    });
    jobs.push({
      name: 'Desktop Agent (Electron)',
      description: 'Tray app — executes UI automation, terminal opens, system commands',
      type: 'process',
      status: procs.includes('electron.exe') ? 'running' : 'stopped',
      schedule: 'Manual start or via PAN shortcut',
    });
  } catch {}

  // Classifier
  jobs.push({
    name: 'Event Classifier',
    description: 'Classifies raw events into categories',
    type: 'internal',
    status: 'running',
    schedule: 'Every 5 minutes',
  });

  // Project Sync
  jobs.push({
    name: 'Project Sync',
    description: 'Scans disk for .pan files, syncs project database',
    type: 'internal',
    status: 'running',
    schedule: 'Every 10 minutes',
  });

  // Issue Checker
  jobs.push({
    name: 'Issue Checker',
    description: 'Checks filed GitHub issues for responses (Anthropic, Microsoft)',
    type: 'internal',
    status: 'ready',
    schedule: 'Daily (not yet automated)',
  });

  // Voice training data stats
  try {
    const { execSync } = await import('child_process');
    const stats = execSync('python src/voice-recorder.py --stats 2>nul', {
      encoding: 'utf-8', timeout: 5000,
      cwd: join(__dirname2, '..', '..')
    });
    const parsed = JSON.parse(stats);
    jobs.push({
      name: 'Voice Training Data',
      description: `${parsed.segments} segments, ${parsed.total_minutes} min, ${parsed.storage_mb}MB`,
      type: 'data',
      status: parsed.total_minutes >= 30 ? 'ready' : 'collecting',
      schedule: 'Accumulates via hotkey recording',
    });
  } catch {}

  res.json({ jobs });
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
    'all': null, // null = no type filter, show everything
    'voice': "('RouterCommand', 'PhoneAudio')",
    'commands': "('RouterCommand')",
    'photos': "('PandantPhoto', 'VisionAnalysis')",
    'sensors': "('SensorData')",
    'system': "('SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit')",
  };
  const typeFilter = filterMap[filter] !== undefined ? filterMap[filter] : null;

  let whereClause = typeFilter ? `WHERE event_type IN ${typeFilter}` : '';
  const params = { ':limit': limit, ':offset': offset };

  if (search) {
    whereClause += whereClause ? ` AND data LIKE :q` : `WHERE data LIKE :q`;
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
      transcript: data.transcript || data.user_text || data.text || data.question || '',
      response: data.response || data.response_text || data.description || '',
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

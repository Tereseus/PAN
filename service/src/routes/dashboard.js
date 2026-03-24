import { Router } from 'express';
import { all, get, run, insert, DB_PATH } from '../db.js';
import { getFindings, updateFinding, scout } from '../scout.js';
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

  // Tool Scout
  try {
    const newFindings = get(`SELECT COUNT(*) as c FROM scout_findings WHERE status = 'new'`);
    const totalFindings = get(`SELECT COUNT(*) as c FROM scout_findings`);
    jobs.push({
      name: 'Tool Scout',
      description: `Discovers new AI CLIs and tools for PAN — ${newFindings?.c || 0} new, ${totalFindings?.c || 0} total`,
      type: 'internal',
      status: 'running',
      schedule: 'Every 12 hours (BetterStack, GitHub Trending, Product Hunt)',
    });
  } catch {
    jobs.push({
      name: 'Tool Scout',
      description: 'Discovers new AI CLIs and tools for PAN',
      type: 'internal',
      status: 'starting',
      schedule: 'Every 12 hours',
    });
  }

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

  // Docker status
  try {
    const { execSync } = await import('child_process');
    const dockerVersion = execSync('docker --version 2>nul', { encoding: 'utf-8', timeout: 5000 }).trim();
    const dockerRunning = execSync('docker info --format "{{.ContainersRunning}}" 2>nul', { encoding: 'utf-8', timeout: 5000 }).trim();
    jobs.push({
      name: 'Docker',
      description: dockerVersion,
      type: 'service',
      status: 'running',
      detail: `${dockerRunning} container(s) running`,
    });
  } catch {
    jobs.push({
      name: 'Docker',
      description: 'Container runtime for voice training and native builds',
      type: 'service',
      status: 'stopped',
    });
  }

  // Piper Voice Model
  try {
    const modelDir = join(__dirname2, '..', 'data', 'voice_model');
    const onnxPath = join(modelDir, 'pan-voice.onnx');
    const configPath = join(modelDir, 'training_config.json');
    const hasModel = existsSync(onnxPath);
    const hasConfig = existsSync(configPath);
    jobs.push({
      name: 'Piper Voice Model',
      description: hasModel ? 'Custom TTS voice trained and ready' : 'Voice model for text-to-speech',
      type: 'ai_model',
      status: hasModel ? 'ready' : hasConfig ? 'training' : 'not_started',
    });
  } catch {}

  // Local LLM (phone)
  try {
    const devices = all(`SELECT * FROM devices WHERE device_type = 'phone' AND last_seen > datetime('now','localtime', '-5 minutes')`);
    const phoneOnline = devices.length > 0;
    jobs.push({
      name: 'Local LLM (Phone)',
      description: 'On-device AI model for intent classification',
      type: 'ai_model',
      status: phoneOnline ? 'connected' : 'offline',
      detail: 'Phi 3.5 Mini — 2.3GB downloaded',
    });
  } catch {}

  // Resistance Router stats
  try {
    const pathCount = get(`SELECT COUNT(*) as c FROM resistance_paths`);
    const logCount = get(`SELECT COUNT(*) as c FROM resistance_log`);
    const successRate = get(`SELECT ROUND(100.0 * SUM(success) / COUNT(*), 1) as rate FROM resistance_log`);
    jobs.push({
      name: 'Resistance Router',
      description: `${pathCount?.c || 0} paths, ${logCount?.c || 0} attempts, ${successRate?.rate || 0}% success`,
      type: 'internal',
      status: 'running',
    });
  } catch {}

  // Device preferences
  try {
    const prefs = all(`SELECT * FROM resistance_preferences`);
    if (prefs.length > 0) {
      jobs.push({
        name: 'User Preferences',
        description: prefs.map(p => `${p.action}: ${p.preferred_path}`).join(', '),
        type: 'config',
        status: 'configured',
      });
    }
  } catch {}

  // Connected devices
  try {
    const devices = all(`SELECT * FROM devices WHERE last_seen > datetime('now','localtime', '-10 minutes')`);
    jobs.push({
      name: 'Connected Devices',
      description: devices.map(d => `${d.name} (${d.device_type})`).join(', ') || 'No devices connected',
      type: 'devices',
      status: devices.length > 0 ? 'online' : 'offline',
      detail: `${devices.length} device(s)`,
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
  const sessionId = req.query.session_id || null;

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
  if (sessionId) {
    where.push("session_id = :session_id");
    params[':session_id'] = sessionId;
  }
  const projectPath = req.query.project_path || null;
  if (projectPath) {
    // Match events whose cwd contains this project path
    // Events store cwd with JSON-escaped backslashes (\\\\) — normalize and match both forms
    const fwd = projectPath.replace(/\\/g, '/');                    // C:/Users/tzuri/.../PAN
    const bk = fwd.replace(/\//g, '\\\\');                          // C:\\Users\\tzuri\\...\\PAN (as in JSON)
    where.push("(data LIKE :pp1 OR data LIKE :pp2)");
    params[':pp1'] = `%${bk}%`;
    params[':pp2'] = `%${fwd}%`;
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
    // Split search into words and AND them together for better matching
    const words = search.split(/\s+/).filter(w => w.length > 0);
    if (words.length > 0) {
      const wordClauses = words.map((w, i) => {
        params[`:q${i}`] = `%${w}%`;
        return `data LIKE :q${i}`;
      });
      const combined = wordClauses.join(' AND ');
      whereClause += whereClause ? ` AND (${combined})` : `WHERE (${combined})`;
    }
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
      response: data.response || data.response_text || data.result || data.description || '',
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

// GET /dashboard/api/scout — list discovered tools
router.get('/api/scout', (req, res) => {
  const status = req.query.status || 'new';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const findings = getFindings({ status, limit });
  res.json({ findings, total: findings.length });
});

// POST /dashboard/api/scout/scan — trigger an immediate scan
router.post('/api/scout/scan', async (req, res) => {
  try {
    const count = await scout();
    res.json({ ok: true, new_findings: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /dashboard/api/scout/:id/status — update finding status
router.post('/api/scout/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['new', 'reviewed', 'integrated', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  updateFinding(parseInt(req.params.id), status);
  res.json({ ok: true });
});

// GET /dashboard/api/progress — project progress for WezTerm sidebar
// Returns all projects with milestone/task completion percentages
router.get('/api/progress', (req, res) => {
  const projects = all("SELECT * FROM projects ORDER BY name");

  const result = projects.map(p => {
    // Get milestones for this project
    const milestones = all(
      "SELECT * FROM project_milestones WHERE project_id = :pid ORDER BY sort_order, name",
      { ':pid': p.id }
    );

    // Get task counts per milestone and overall
    const totalTasks = get(
      "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done, SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress FROM project_tasks WHERE project_id = :pid",
      { ':pid': p.id }
    );

    const milestonesWithProgress = milestones.map(m => {
      const mTasks = get(
        "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done, SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress FROM project_tasks WHERE milestone_id = :mid",
        { ':mid': m.id }
      );
      const total = mTasks?.total || 0;
      const done = mTasks?.done || 0;
      const inProgress = mTasks?.in_progress || 0;
      return {
        id: m.id,
        name: m.name,
        description: m.description,
        total,
        done,
        in_progress: inProgress,
        percentage: total > 0 ? Math.round((done + inProgress * 0.5) / total * 100) : 0,
      };
    });

    // Uncategorized tasks (no milestone)
    const uncategorized = get(
      "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done, SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress FROM project_tasks WHERE project_id = :pid AND milestone_id IS NULL",
      { ':pid': p.id }
    );

    const total = totalTasks?.total || 0;
    const done = totalTasks?.done || 0;
    const inProgress = totalTasks?.in_progress || 0;

    // Session count for activity
    const sessionCount = get("SELECT COUNT(*) as c FROM sessions WHERE project_id = :pid", { ':pid': p.id });

    return {
      id: p.id,
      name: p.name,
      path: p.path,
      description: p.description,
      total_tasks: total,
      done_tasks: done,
      in_progress_tasks: inProgress,
      percentage: total > 0 ? Math.round((done + inProgress * 0.5) / total * 100) : 0,
      milestones: milestonesWithProgress,
      uncategorized_tasks: uncategorized?.total || 0,
      session_count: sessionCount?.c || 0,
    };
  });

  // Activity stats
  const totalEvents = get("SELECT COUNT(*) as c FROM events")?.c || 0;
  const deviceCount = get("SELECT COUNT(*) as c FROM devices")?.c || 0;

  res.json({
    projects: result,
    activity: { total_events: totalEvents, devices: deviceCount },
    timestamp: new Date().toISOString(),
  });
});

// GET /dashboard/api/projects/:id/tasks — all tasks for a project
router.get('/api/projects/:id/tasks', (req, res) => {
  const pid = parseInt(req.params.id);
  const milestones = all(
    "SELECT * FROM project_milestones WHERE project_id = :pid ORDER BY sort_order, name",
    { ':pid': pid }
  );
  const tasks = all(
    "SELECT * FROM project_tasks WHERE project_id = :pid ORDER BY milestone_id, sort_order, title",
    { ':pid': pid }
  );
  res.json({ milestones, tasks });
});

// POST /dashboard/api/projects/:id/milestones — create a milestone
router.post('/api/projects/:id/milestones', (req, res) => {
  const pid = parseInt(req.params.id);
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const maxOrder = get("SELECT MAX(sort_order) as m FROM project_milestones WHERE project_id = :pid", { ':pid': pid });
  const id = insert(
    "INSERT INTO project_milestones (project_id, name, description, sort_order) VALUES (:pid, :name, :desc, :order)",
    { ':pid': pid, ':name': name, ':desc': description || null, ':order': (maxOrder?.m || 0) + 1 }
  );
  res.json({ id, name });
});

// POST /dashboard/api/projects/:id/tasks — create a task
router.post('/api/projects/:id/tasks', (req, res) => {
  const pid = parseInt(req.params.id);
  const { title, description, milestone_id, status, priority } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const maxOrder = get("SELECT MAX(sort_order) as m FROM project_tasks WHERE project_id = :pid", { ':pid': pid });
  const id = insert(
    "INSERT INTO project_tasks (project_id, milestone_id, title, description, status, priority, sort_order) VALUES (:pid, :mid, :title, :desc, :status, :pri, :order)",
    {
      ':pid': pid,
      ':mid': milestone_id || null,
      ':title': title,
      ':desc': description || null,
      ':status': status || 'todo',
      ':pri': priority || 0,
      ':order': (maxOrder?.m || 0) + 1,
    }
  );
  res.json({ id, title, status: status || 'todo' });
});

// PUT /dashboard/api/tasks/:id — update a task (status, title, etc.)
router.put('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { title, description, status, priority, milestone_id } = req.body;
  const existing = get("SELECT * FROM project_tasks WHERE id = :id", { ':id': id });
  if (!existing) return res.status(404).json({ error: 'not found' });

  const updates = [];
  const params = { ':id': id };

  if (title !== undefined) { updates.push("title = :title"); params[':title'] = title; }
  if (description !== undefined) { updates.push("description = :desc"); params[':desc'] = description; }
  if (status !== undefined) {
    updates.push("status = :status");
    params[':status'] = status;
    if (status === 'done' && existing.status !== 'done') {
      updates.push("completed_at = datetime('now','localtime')");
    }
    if (status !== 'done') {
      updates.push("completed_at = NULL");
    }
  }
  if (priority !== undefined) { updates.push("priority = :pri"); params[':pri'] = priority; }
  if (milestone_id !== undefined) { updates.push("milestone_id = :mid"); params[':mid'] = milestone_id; }

  if (updates.length === 0) return res.json({ ok: true, unchanged: true });

  run(`UPDATE project_tasks SET ${updates.join(', ')} WHERE id = :id`, params);
  res.json({ ok: true });
});

// DELETE /dashboard/api/tasks/:id
router.delete('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  run("DELETE FROM project_tasks WHERE id = :id", { ':id': id });
  res.json({ ok: true });
});

// DELETE /dashboard/api/milestones/:id — also deletes child tasks
router.delete('/api/milestones/:id', (req, res) => {
  const id = parseInt(req.params.id);
  run("DELETE FROM project_tasks WHERE milestone_id = :id", { ':id': id });
  run("DELETE FROM project_milestones WHERE id = :id", { ':id': id });
  res.json({ ok: true });
});

// POST /dashboard/api/projects/:id/bulk-tasks — create multiple tasks at once
// Body: { milestone_name: "...", tasks: ["task1", "task2", ...] }
router.post('/api/projects/:id/bulk-tasks', (req, res) => {
  const pid = parseInt(req.params.id);
  const { milestone_name, tasks } = req.body;
  if (!tasks || !Array.isArray(tasks)) return res.status(400).json({ error: 'tasks array required' });

  let milestoneId = null;
  if (milestone_name) {
    // Find or create milestone
    const existing = get(
      "SELECT id FROM project_milestones WHERE project_id = :pid AND name = :name",
      { ':pid': pid, ':name': milestone_name }
    );
    if (existing) {
      milestoneId = existing.id;
    } else {
      const maxOrder = get("SELECT MAX(sort_order) as m FROM project_milestones WHERE project_id = :pid", { ':pid': pid });
      milestoneId = insert(
        "INSERT INTO project_milestones (project_id, name, sort_order) VALUES (:pid, :name, :order)",
        { ':pid': pid, ':name': milestone_name, ':order': (maxOrder?.m || 0) + 1 }
      );
    }
  }

  let created = 0;
  for (const task of tasks) {
    const title = typeof task === 'string' ? task : task.title;
    const status = (typeof task === 'object' && task.status) || 'todo';
    if (!title) continue;
    insert(
      "INSERT INTO project_tasks (project_id, milestone_id, title, status, sort_order) VALUES (:pid, :mid, :title, :status, :order)",
      { ':pid': pid, ':mid': milestoneId, ':title': title, ':status': status, ':order': created }
    );
    created++;
  }
  res.json({ ok: true, created, milestone_id: milestoneId });
});

// POST /dashboard/api/open-tabs — record which tabs are open (for session restore)
router.post('/api/open-tabs', (req, res) => {
  const { tabs } = req.body;
  if (!tabs || !Array.isArray(tabs)) return res.status(400).json({ error: 'tabs array required' });

  // Clear existing and replace
  run("DELETE FROM open_tabs");
  for (const tab of tabs) {
    if (!tab.project_id) continue;
    insert(
      "INSERT INTO open_tabs (project_id, pane_id, tab_index) VALUES (:pid, :pane, :idx)",
      { ':pid': tab.project_id, ':pane': tab.pane_id || null, ':idx': tab.tab_index || 0 }
    );
  }
  res.json({ ok: true, saved: tabs.length });
});

// Custom sections per project
router.get('/api/projects/:id/sections', (req, res) => {
  const pid = parseInt(req.params.id);
  const sections = all("SELECT * FROM project_sections WHERE project_id = :pid ORDER BY sort_order, name", { ':pid': pid });
  const result = sections.map(s => {
    const items = all("SELECT * FROM section_items WHERE section_id = :sid ORDER BY sort_order", { ':sid': s.id });
    return { ...s, items };
  });
  res.json(result);
});

router.post('/api/projects/:id/sections', (req, res) => {
  const pid = parseInt(req.params.id);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const maxOrder = get("SELECT MAX(sort_order) as m FROM project_sections WHERE project_id = :pid", { ':pid': pid });
  const id = insert(
    "INSERT INTO project_sections (project_id, name, sort_order) VALUES (:pid, :name, :order)",
    { ':pid': pid, ':name': name, ':order': (maxOrder?.m || 0) + 1 }
  );
  res.json({ id, name });
});

router.delete('/api/sections/:id', (req, res) => {
  const id = parseInt(req.params.id);
  run("DELETE FROM section_items WHERE section_id = :id", { ':id': id });
  run("DELETE FROM project_sections WHERE id = :id", { ':id': id });
  res.json({ ok: true });
});

router.post('/api/sections/:id/items', (req, res) => {
  const sid = parseInt(req.params.id);
  const section = get("SELECT * FROM project_sections WHERE id = :id", { ':id': sid });
  if (!section) return res.status(404).json({ error: 'section not found' });
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const id = insert(
    "INSERT INTO section_items (section_id, project_id, content) VALUES (:sid, :pid, :content)",
    { ':sid': sid, ':pid': section.project_id, ':content': content }
  );
  res.json({ id, content });
});

router.put('/api/section-items/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { status, content } = req.body;
  const updates = [];
  const params = { ':id': id };
  if (status !== undefined) { updates.push("status = :status"); params[':status'] = status; }
  if (content !== undefined) { updates.push("content = :content"); params[':content'] = content; }
  if (updates.length === 0) return res.json({ ok: true });
  run(`UPDATE section_items SET ${updates.join(', ')} WHERE id = :id`, params);
  res.json({ ok: true });
});

router.delete('/api/section-items/:id', (req, res) => {
  run("DELETE FROM section_items WHERE id = :id", { ':id': parseInt(req.params.id) });
  res.json({ ok: true });
});

// GET /dashboard/api/open-tabs — get last open tabs for session restore
router.get('/api/open-tabs', (req, res) => {
  const tabs = all(`
    SELECT ot.*, p.name as project_name, p.path as project_path
    FROM open_tabs ot
    JOIN projects p ON p.id = ot.project_id
    ORDER BY ot.tab_index
  `);
  res.json(tabs);
});

export default router;

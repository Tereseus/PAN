import { Router } from 'express';
import { all, get, run, insert, DB_PATH, allScoped, getScoped, runScoped, insertScoped } from '../db.js';
import { getFindings, updateFinding, scout } from '../scout.js';
import { statSync, readdirSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { broadcastNotification } from '../terminal-bridge.js';
import { readTranscript as readPtyTranscript, renameTranscript, setSessionName } from '../pty-transcript.js';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { hostname } from 'os';

const __dirname2 = dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = join(__dirname2, '..', 'data', 'photos');

const router = Router();

// Password verification for delete operations
// Password is stored as SHA-256 hash in the settings table
// Default password on first use: "pan" (user should change it)
function hashPassword(pw) {
  return createHash('sha256').update(pw).digest('hex');
}

// Settings table is created by schema.sql — no inline CREATE needed

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
        const event = getScoped(req, "SELECT * FROM events WHERE event_type = 'VisionAnalysis' AND data LIKE :f AND org_id = :org_id ORDER BY created_at DESC LIMIT 1",
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
      { encoding: 'utf-8', timeout: 5000, windowsHide: true }
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
      encoding: 'utf-8', timeout: 5000, windowsHide: true
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
      encoding: 'utf-8', timeout: 5000, windowsHide: true
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
    const newFindings = getScoped(req, `SELECT COUNT(*) as c FROM scout_findings WHERE status = 'new' AND org_id = :org_id`);
    const totalFindings = getScoped(req, `SELECT COUNT(*) as c FROM scout_findings WHERE org_id = :org_id`);
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
      encoding: 'utf-8', timeout: 5000, windowsHide: true,
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
    const dockerVersion = execSync('docker --version 2>nul', { encoding: 'utf-8', timeout: 5000, windowsHide: true }).trim();
    const dockerRunning = execSync('docker info --format "{{.ContainersRunning}}" 2>nul', { encoding: 'utf-8', timeout: 5000, windowsHide: true }).trim();
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
    const devices = allScoped(req, `SELECT * FROM devices WHERE device_type = 'phone' AND last_seen > datetime('now','localtime', '-5 minutes') AND org_id = :org_id`);
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
    const pathCount = getScoped(req, `SELECT COUNT(*) as c FROM resistance_paths WHERE org_id = :org_id`);
    const logCount = getScoped(req, `SELECT COUNT(*) as c FROM resistance_log WHERE org_id = :org_id`);
    const successRate = getScoped(req, `SELECT ROUND(100.0 * SUM(success) / COUNT(*), 1) as rate FROM resistance_log WHERE org_id = :org_id`);
    jobs.push({
      name: 'Resistance Router',
      description: `${pathCount?.c || 0} paths, ${logCount?.c || 0} attempts, ${successRate?.rate || 0}% success`,
      type: 'internal',
      status: 'running',
    });
  } catch {}

  // Device preferences
  try {
    const prefs = allScoped(req, `SELECT * FROM resistance_preferences WHERE org_id = :org_id`);
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
    const devices = allScoped(req, `SELECT * FROM devices WHERE last_seen > datetime('now','localtime', '-10 minutes') AND org_id = :org_id`);
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
  const results = allScoped(req, `SELECT * FROM events WHERE data LIKE :q AND org_id = :org_id ORDER BY created_at DESC LIMIT 50`, {
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

  let where = ['org_id = :org_id'];
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

  const whereClause = `WHERE ${where.join(' AND ')}`;

  const total = getScoped(req, `SELECT COUNT(*) as count FROM events ${whereClause}`, params);
  const events = allScoped(req,
    `SELECT * FROM events ${whereClause} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    { ...params, ':limit': limit, ':offset': offset }
  );

  res.json({ events, total: total?.count || 0, limit, offset });
});

// Transcript cache — avoids re-parsing huge JSONL files on every poll
const transcriptCache = new Map(); // path -> { mtime, size, messages }

// GET /api/transcript — read full conversation from JSONL transcript file
// Returns user prompts, full assistant text responses, and tool call summaries
router.get('/api/transcript', (req, res) => {
  // Never let browsers cache transcript responses — they update constantly
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const sessionId = req.query.session_id;
  if (!sessionId) return res.json({ error: 'session_id required', messages: [] });

  // Find the transcript path from the most recent event for this session
  const event = getScoped(req,
    "SELECT data FROM events WHERE session_id = :sid AND event_type IN ('Stop', 'UserPromptSubmit') AND org_id = :org_id ORDER BY created_at DESC LIMIT 1",
    { ':sid': sessionId }
  );
  if (!event) return res.json({ error: 'session not found', messages: [] });

  let transcriptPath;
  try {
    transcriptPath = JSON.parse(event.data).transcript_path;
  } catch {}
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return res.json({ error: 'transcript not found', messages: [] });
  }

  try {
    // Check cache — skip re-parsing if file hasn't changed.
    // Compare BOTH mtime AND size: on Windows, mtime can be stale when Claude
    // holds the file handle open and appends data. Size always reflects appends.
    const fileStat = statSync(transcriptPath);
    const cached = transcriptCache.get(transcriptPath);
    if (cached && cached.mtime >= fileStat.mtimeMs && cached.size >= fileStat.size) {
      const limit = parseInt(req.query.limit) || 200;
      return res.json({ messages: cached.messages.slice(-limit) });
    }

    const raw = readFileSync(transcriptPath, 'utf-8').trim();
    const lines = raw.split('\n');
    const messages = [];

    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      // User prompt — content can be a string (typed message) or array (tool results, skip those)
      if (obj.type === 'user' && obj.message) {
        const content = obj.message.content;
        if (typeof content === 'string' && content.trim()) {
          messages.push({ role: 'user', type: 'prompt', text: content, ts: obj.timestamp });
        } else if (Array.isArray(content)) {
          // Array content — look for text and image blocks (skip tool_result entries)
          let textParts = [];
          let images = [];
          for (const block of content) {
            if (block.type === 'text' && block.text?.trim()) {
              textParts.push(block.text);
            } else if (block.type === 'image' && block.source) {
              // Extract clipboard filename from file path if available
              if (block.source.type === 'file' && block.source.file_path) {
                const m = block.source.file_path.match(/pan-clipboard[\/\\](clipboard_\d+\.\w+)/);
                if (m) images.push({ clipboardFile: m[1] });
              } else if (block.source.type === 'base64') {
                // For base64, generate a small data URL for the thumbnail
                images.push({ dataUrl: `data:${block.source.media_type};base64,${block.source.data.substring(0, 200)}`, isBase64: true, mediaType: block.source.media_type });
              }
            }
          }
          if (textParts.length || images.length) {
            messages.push({ role: 'user', type: 'prompt', text: textParts.join('\n'), images, ts: obj.timestamp });
          }
        }
        continue;
      }

      // Meta entry with [Image: source: ...] — attach clipboard reference to previous user message
      if (obj.isMeta && obj.message?.content) {
        const metaText = typeof obj.message.content === 'string' ? obj.message.content :
          Array.isArray(obj.message.content) ? obj.message.content.map(b => b.text || '').join('') : '';
        const imgMatch = metaText.match(/\[Image:?\s*source:?\s*[^\]]*pan-clipboard[\/\\](clipboard_\d+\.\w+)/i);
        if (imgMatch && messages.length > 0) {
          const last = messages[messages.length - 1];
          if (last.role === 'user') {
            if (!last.images) last.images = [];
            last.images.push({ clipboardFile: imgMatch[1] });
          }
        }
        continue;
      }

      // Assistant messages
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        const model = obj.message?.model || null;
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            messages.push({ role: 'assistant', type: 'text', text: block.text, ts: obj.timestamp, model });
          } else if (block.type === 'tool_use') {
            // Summarize tool calls — just name and key info
            const name = block.name || 'unknown';
            let summary = name;
            const input = block.input || {};
            if (name === 'Bash' && input.command) summary = `Bash: ${input.command.substring(0, 120)}`;
            else if (name === 'Edit' && input.file_path) summary = `Edit: ${input.file_path.split(/[/\\]/).pop()}`;
            else if (name === 'Read' && input.file_path) summary = `Read: ${input.file_path.split(/[/\\]/).pop()}`;
            else if (name === 'Write' && input.file_path) summary = `Write: ${input.file_path.split(/[/\\]/).pop()}`;
            else if (name === 'Grep' && input.pattern) summary = `Grep: ${input.pattern.substring(0, 60)}`;
            else if (name === 'Glob' && input.pattern) summary = `Glob: ${input.pattern}`;
            else if (name === 'Agent') summary = `Agent: ${input.description || 'subagent'}`;
            messages.push({ role: 'assistant', type: 'tool', text: summary, ts: obj.timestamp });
          }
        }
      }
    }

    // Cache the parsed result
    transcriptCache.set(transcriptPath, { mtime: fileStat.mtimeMs, size: fileStat.size, messages });
    // Limit cache size to 20 entries
    if (transcriptCache.size > 20) {
      const oldest = transcriptCache.keys().next().value;
      transcriptCache.delete(oldest);
    }

    // Only return the last N messages to keep payload reasonable
    const limit = parseInt(req.query.limit) || 200;
    res.json({ messages: messages.slice(-limit), total: messages.length });
  } catch (err) {
    res.json({ error: err.message, messages: [] });
  }
});

// GET /api/pty-transcript — read PTY transcript by tab session ID.
// LLM-agnostic: keyed by tab session ID, persists across Claude restarts.
router.get('/api/pty-transcript', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  const sessionId = req.query.session_id;
  if (!sessionId) return res.json({ error: 'session_id required', messages: [] });
  try {
    const messages = readPtyTranscript(sessionId);
    const limit = parseInt(req.query.limit) || 200;
    res.json({ messages: messages.slice(-limit), total: messages.length });
  } catch (err) {
    res.json({ error: err.message, messages: [] });
  }
});

// GET /dashboard/api/stats
// Cached — queries run on a 72K-row events table (2-3s each). Stale for 60s is fine for dashboard counters.
let _statsCache = null;
let _statsCacheAt = 0;
const STATS_TTL_MS = 60_000;
router.get('/api/stats', (req, res) => {
  if (_statsCache && (Date.now() - _statsCacheAt) < STATS_TTL_MS) {
    return res.json(_statsCache);
  }
  const stats = getScoped(req, `SELECT
    (SELECT COUNT(*) FROM events WHERE org_id = :org_id) as total_events,
    (SELECT COUNT(*) FROM memory_items WHERE org_id = :org_id) as total_memory,
    (SELECT COUNT(*) FROM sessions WHERE org_id = :org_id) as total_sessions,
    (SELECT COUNT(*) FROM projects WHERE org_id = :org_id) as total_projects,
    (SELECT COUNT(*) FROM devices WHERE org_id = :org_id) as total_devices,
    (SELECT COUNT(DISTINCT event_type) FROM events WHERE org_id = :org_id) as event_types
  `);

  let dbSize = 0;
  try {
    dbSize = statSync(DB_PATH).size;
  } catch {}

  const eventTypes = allScoped(req, `SELECT event_type, COUNT(*) as count FROM events WHERE org_id = :org_id GROUP BY event_type ORDER BY count DESC`);

  // Restart friction metric — total times the user has uttered the word
  // "restart" in a prompt event. This is a per-application data category
  // because it measures dev-loop friction (how often we have to break flow).
  // Per-project breakdown joins via the session → project path heuristic
  // already used by other dashboard queries.
  let totalRestarts = 0;
  let restartsByProject = [];
  try {
    totalRestarts = getScoped(req, `
      SELECT COUNT(*) AS c FROM events
      WHERE event_type IN ('UserPromptSubmit','user','user_prompt')
        AND lower(data) LIKE '%restart%'
        AND org_id = :org_id
    `).c || 0;
    restartsByProject = allScoped(req, `
      SELECT
        COALESCE(p.name, 'unscoped') AS project,
        COUNT(*) AS count
      FROM events e
      LEFT JOIN sessions s ON s.id = e.session_id
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE e.event_type IN ('UserPromptSubmit','user','user_prompt')
        AND lower(e.data) LIKE '%restart%'
        AND e.org_id = :org_id
      GROUP BY project
      ORDER BY count DESC
    `);
  } catch (err) {
    console.warn('[stats] restart count failed:', err.message);
  }

  const result = {
    ...stats,
    db_size_bytes: dbSize,
    event_types: eventTypes,
    total_restarts: totalRestarts,
    restarts_by_project: restartsByProject,
  };
  _statsCache = result;
  _statsCacheAt = Date.now();
  res.json(result);
});

// GET /dashboard/api/memory — reads actual Claude Code memory files from ~/.claude/projects/*/memory/
router.get('/api/memory', (req, res) => {
  const claudeDir = join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects');
  const memories = [];

  try {
    if (!existsSync(claudeDir)) return res.json({ memories: [] });
    const projectDirs = readdirSync(claudeDir).filter(d => {
      try { return statSync(join(claudeDir, d)).isDirectory(); } catch { return false; }
    });

    for (const projDir of projectDirs) {
      const memDir = join(claudeDir, projDir, 'memory');
      if (!existsSync(memDir)) continue;

      // Derive a readable project name from the dir name (C--Users-tzuri-OneDrive-Desktop-PAN → PAN)
      const parts = projDir.replace(/^C--/, '').split('-');
      const projectName = parts[parts.length - 1] || parts[parts.length - 2] || projDir;

      const files = readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
      for (const file of files) {
        try {
          const content = readFileSync(join(memDir, file), 'utf8');
          // Parse frontmatter
          let name = file.replace('.md', ''), type = 'unknown', description = '';
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
          let body = content;
          if (fmMatch) {
            const fm = fmMatch[1];
            body = fmMatch[2].trim();
            const nameMatch = fm.match(/name:\s*(.+)/);
            const typeMatch = fm.match(/type:\s*(.+)/);
            const descMatch = fm.match(/description:\s*(.+)/);
            if (nameMatch) name = nameMatch[1].trim();
            if (typeMatch) type = typeMatch[1].trim();
            if (descMatch) description = descMatch[1].trim();
          }
          const stat = statSync(join(memDir, file));
          memories.push({ name, type, description, body, project: projectName, file, modified: stat.mtime.toISOString() });
        } catch {}
      }
    }
  } catch {}

  // Sort by modified date, newest first
  memories.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  res.json({ memories });
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

  let whereClause = typeFilter ? `WHERE org_id = :org_id AND event_type IN ${typeFilter}` : 'WHERE org_id = :org_id';
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
      whereClause += ` AND (${combined})`;
    }
  }

  const events = allScoped(req,
    `SELECT * FROM events ${whereClause} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    params
  );

  const total = getScoped(req, `SELECT COUNT(*) as count FROM events ${whereClause}`, params);

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
  const projects = allScoped(req, `SELECT * FROM projects WHERE org_id = :org_id ORDER BY name`);
  res.json(projects);
});

// POST /dashboard/api/phone-ping — mobile dashboard heartbeat
// Called every 2 min from /mobile/ to keep phone last_seen fresh
router.post('/api/phone-ping', (req, res) => {
  const { device_id } = req.body || {};
  if (device_id) {
    // Update specific device if provided
    runScoped(req, `UPDATE devices SET last_seen = datetime('now','localtime'), online = 1
      WHERE hostname = :h AND org_id = :org_id`, { ':h': device_id });
  } else {
    // Update most recently seen phone (fallback when device_id unknown)
    runScoped(req, `UPDATE devices SET last_seen = datetime('now','localtime'), online = 1
      WHERE device_type = 'phone' AND org_id = :org_id
      AND last_seen = (SELECT MAX(last_seen) FROM devices WHERE device_type = 'phone' AND org_id = :org_id)`);
  }
  res.json({ ok: true });
});

// GET /dashboard/api/devices
router.get('/api/devices', (req, res) => {
  const devices = allScoped(req, `SELECT * FROM devices WHERE org_id = :org_id ORDER BY last_seen DESC`);
  // Enrich with real activity from client_logs (phone's last_seen may lag if logs handler doesn't update it)
  const recentLogs = allScoped(req, `
    SELECT device_id, MAX(created_at) as last_log
    FROM client_logs WHERE org_id = :org_id
    GROUP BY device_id`);
  const logMap = Object.fromEntries(recentLogs.map(r => [r.device_id, r.last_log]));
  const enriched = devices.map(d => {
    const lastLog = logMap[d.hostname];
    if (lastLog && (!d.last_seen || lastLog > d.last_seen)) {
      return { ...d, last_seen: lastLog, online: 1 };
    }
    return d;
  });
  res.json(enriched);
});

// GET /dashboard/api/services — unified services + devices status
router.get('/api/services', async (req, res) => {
  const services = [];
  const issues = [];
  const pcHost = hostname();

  // PAN Server — always up if this code is running
  const uptime = process.uptime();
  services.push({
    category: 'PAN Core', name: 'PAN Server', status: 'up',
    uptime, detail: `Port 7777, PID ${process.pid}`
  });

  // Steward
  const stewardEvent = getScoped(req, `SELECT created_at FROM events WHERE event_type IN ('StewardHeartbeat','SessionStart') AND org_id = :org_id ORDER BY created_at DESC LIMIT 1`);
  if (stewardEvent) {
    const age = (Date.now() - new Date(stewardEvent.created_at).getTime()) / 1000;
    services.push({ category: 'PAN Core', name: 'Steward', status: age < 600 ? 'up' : 'unknown', detail: age < 600 ? 'Running' : 'No recent events' });
  } else {
    services.push({ category: 'PAN Core', name: 'Steward', status: 'unknown', detail: 'No events recorded' });
  }

  // Intuition
  services.push({ category: 'PAN Core', name: 'Intuition', status: 'offline', detail: 'Dimensional state engine — not yet built' });

  // Dream
  const dreamRow = get(`SELECT value FROM settings WHERE key = 'last_dream_run'`);
  if (dreamRow) {
    services.push({ category: 'PAN Core', name: 'Dream', status: 'up', detail: `Last run: ${dreamRow.value}` });
  } else {
    services.push({ category: 'PAN Core', name: 'Dream', status: 'unknown', detail: 'No runs recorded' });
  }

  // Scout
  const scoutRow = get(`SELECT value FROM settings WHERE key = 'last_scout_run'`);
  if (scoutRow) {
    services.push({ category: 'PAN Core', name: 'Scout', status: 'up', detail: `Last run: ${scoutRow.value}` });
  } else {
    services.push({ category: 'PAN Core', name: 'Scout', status: 'unknown', detail: 'No runs recorded' });
  }

  // AI / LLM Services
  // Pull usage counts for context (last 24h)
  const usageRows = allScoped(req, `SELECT caller, model, COUNT(*) as calls FROM ai_usage WHERE org_id = :org_id AND created_at > datetime('now','-1 day') GROUP BY caller, model`);
  const usageMap = {};
  for (const r of usageRows) usageMap[`${r.caller}:${r.model}`] = r.calls;
  const totalCalls = usageRows.reduce((s, r) => s + r.calls, 0);

  // Whisper STT
  try {
    const wr = await fetch('http://127.0.0.1:7782', { signal: AbortSignal.timeout(1500) });
    if (wr.ok) {
      const wd = await wr.json().catch(() => ({}));
      const enrolled = wd.enrolled != null ? `${wd.enrolled} voice${wd.enrolled !== 1 ? 's' : ''} enrolled` : '';
      services.push({ category: 'AI Models', name: 'Whisper STT', status: 'up',
        role: 'Speech → text for all voice commands + passive speaker ID',
        detail: [enrolled, `${wd.model || 'base'} model · port 7782`].filter(Boolean).join(' · ') });
    } else {
      services.push({ category: 'AI Models', name: 'Whisper STT', status: 'down', role: 'Speech → text', detail: 'Server error' });
    }
  } catch {
    services.push({ category: 'AI Models', name: 'Whisper STT', status: 'down', role: 'Speech → text', detail: 'Not running · steward will restart' });
  }

  // Ollama + loaded models
  try {
    const or = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (or.ok) {
      const od = await or.json().catch(() => ({}));
      const models = od.models || [];
      if (models.length === 0) {
        services.push({ category: 'AI Models', name: 'Ollama', status: 'up', role: 'Local LLM runtime', detail: 'Running · no models loaded' });
      } else {
        // Classify model roles by name pattern
        const roleFor = (name) => {
          const n = name.toLowerCase();
          if (n.includes('embed')) return 'Text embeddings · memory search';
          if (n.includes('qwen') && n.includes('235')) return 'Local fast router (offline fallback)';
          if (n.includes('qwen')) return 'Local reasoning · offline capable';
          if (n.includes('llama')) return 'Local LLM · general purpose';
          if (n.includes('mistral')) return 'Local LLM · fast inference';
          if (n.includes('phi')) return 'Local LLM · lightweight';
          if (n.includes('nomic') || n.includes('mxbai')) return 'Text embeddings · memory search';
          return 'Local LLM · offline capable';
        };
        for (const m of models) {
          const sizeGb = m.size ? (m.size / 1e9).toFixed(1) + 'GB' : '';
          services.push({ category: 'AI Models', name: m.name, status: 'up',
            role: roleFor(m.name),
            detail: `Ollama local${sizeGb ? ' · ' + sizeGb : ''}` });
        }
      }
    } else {
      services.push({ category: 'AI Models', name: 'Ollama', status: 'down', role: 'Local LLM runtime', detail: 'Server error' });
    }
  } catch {
    services.push({ category: 'AI Models', name: 'Ollama', status: 'down', role: 'Local LLM runtime · embeddings', detail: 'Not running · offline features unavailable' });
  }

  // Cerebras — check via a settings key or just show config status
  const cerebrasKey = get(`SELECT value FROM settings WHERE key = 'cerebras_api_key'`);
  const aiModel = get(`SELECT value FROM settings WHERE key = 'ai_model'`);
  const usingCerebras = aiModel?.value?.startsWith('cerebras:');
  const cerebrasModel = aiModel?.value?.replace('cerebras:', '') || '';
  const cerebrasCalls = usageRows.filter(r => r.model?.includes('cerebras') || r.caller === 'router').reduce((s, r) => s + r.calls, 0);
  services.push({
    category: 'AI Models', name: 'Cerebras',
    status: cerebrasKey ? (usingCerebras ? 'up' : 'unknown') : 'unknown',
    role: 'Voice router · classifies every voice command (~580ms)',
    detail: usingCerebras
      ? `Active model · ${cerebrasModel}${cerebrasCalls ? ` · ${cerebrasCalls} calls today` : ''}`
      : (cerebrasKey ? 'Configured · not current model' : 'No API key · falling back to Claude')
  });

  // Claude CLI
  const claudeModel = aiModel?.value;
  const isClaudeActive = claudeModel && !claudeModel.startsWith('cerebras:') && !claudeModel.startsWith('ollama:');
  const claudeCalls = usageRows.filter(r => r.caller === 'terminal' || r.caller === 'session').reduce((s, r) => s + r.calls, 0);
  services.push({
    category: 'AI Models', name: 'Claude CLI',
    status: 'up',
    role: 'Terminal sessions · smart tasks · code · this conversation',
    detail: isClaudeActive
      ? `Active model · ${claudeModel}${claudeCalls ? ` · ${claudeCalls} calls today` : ''}`
      : `Fallback · claude -p subscription${claudeCalls ? ` · ${claudeCalls} calls today` : ''}`
  });

  // Devices — enrich last_seen from client_logs for devices that log but don't heartbeat
  const allDevRaw = allScoped(req, `SELECT * FROM devices WHERE org_id = :org_id ORDER BY last_seen DESC`);
  const recentDevLogs = allScoped(req, `SELECT device_id, MAX(created_at) as last_log FROM client_logs WHERE org_id = :org_id GROUP BY device_id`);
  const devLogMap = Object.fromEntries(recentDevLogs.map(r => [r.device_id, r.last_log]));
  const devices = allDevRaw.map(d => {
    const lastLog = devLogMap[d.hostname];
    if (lastLog && (!d.last_seen || lastLog > d.last_seen)) return { ...d, last_seen: lastLog };
    return d;
  });
  for (const d of devices) {
    const ageSec = d.last_seen ? (Date.now() - new Date(d.last_seen).getTime()) / 1000 : Infinity;
    // PC running this server is ALWAYS online
    const isThisPC = d.hostname === pcHost || d.device_type === 'pc' && ageSec < 10;
    const isOnline = isThisPC || ageSec < 120;
    const ageStr = ageSec < 60 ? `${Math.round(ageSec)}s ago` : ageSec < 3600 ? `${Math.round(ageSec / 60)}m ago` : `${Math.round(ageSec / 3600)}h ago`;
    services.push({
      category: 'Devices', name: d.name || d.hostname,
      hostname: d.hostname, device_type: d.device_type,
      status: isOnline ? 'up' : 'down',
      detail: `${d.device_type === 'phone' ? 'Phone' : 'PC'} — last seen ${isThisPC ? '0s ago' : ageStr}`
    });
  }

  res.json({ services, issues });
});

// GET /dashboard/api/sessions
router.get('/api/sessions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const sessions = allScoped(req, `SELECT * FROM sessions WHERE org_id = :org_id ORDER BY started_at DESC LIMIT :limit`, { ':limit': limit });
  res.json(sessions);
});

// DELETE /dashboard/api/events/:id
router.delete('/api/events/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const existing = getScoped(req, `SELECT id FROM events WHERE id = :id AND org_id = :org_id`, { ':id': id });
  if (!existing) return res.status(404).json({ error: 'not found' });

  runScoped(req, `DELETE FROM events WHERE id = :id AND org_id = :org_id`, { ':id': id });
  res.json({ ok: true, deleted: id });
});

// DELETE /dashboard/api/events/bulk?type=X&date=X&q=search — bulk delete matching events
router.delete('/api/events/bulk', (req, res) => {
  if (req.query.confirm !== 'yes') return res.status(400).json({ error: 'missing confirm' });

  let where = ['org_id = :org_id'];
  let params = {};
  if (req.query.type) { where.push("event_type = :type"); params[':type'] = req.query.type; }
  if (req.query.date) { where.push("date(created_at) = :date"); params[':date'] = req.query.date; }
  if (req.query.q) { where.push("data LIKE :q"); params[':q'] = `%${req.query.q}%`; }

  if (where.length <= 1) return res.status(400).json({ error: 'no filters specified' });

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const count = getScoped(req, `SELECT COUNT(*) as count FROM events ${whereClause}`, params);
  runScoped(req, `DELETE FROM events ${whereClause}`, params);
  res.json({ ok: true, deleted_count: count?.count || 0 });
});

// DELETE /dashboard/api/events/day/:date
router.delete('/api/events/day/:date', (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid date format, use YYYY-MM-DD' });
  }

  const count = getScoped(req, `SELECT COUNT(*) as count FROM events WHERE date(created_at) = :date AND org_id = :org_id`, { ':date': date });
  runScoped(req, `DELETE FROM events WHERE date(created_at) = :date AND org_id = :org_id`, { ':date': date });
  res.json({ ok: true, deleted_count: count?.count || 0, date });
});

// POST /dashboard/api/memory/cleanup — nuke all old memory_items (state file replaces them)
router.post('/api/memory/cleanup', (req, res) => {
  const before = getScoped(req, `SELECT COUNT(*) as count FROM memory_items WHERE org_id = :org_id`);
  // Keep only 'processed' markers (used by classifier to track which events were seen)
  const result = runScoped(req, `DELETE FROM memory_items WHERE item_type != 'processed' AND org_id = :org_id`);
  const remaining = getScoped(req, `SELECT COUNT(*) as count FROM memory_items WHERE org_id = :org_id`);
  res.json({ ok: true, deleted: result?.changes || 0, before: before?.count || 0, remaining: remaining?.count || 0 });
});

// DELETE /dashboard/api/memory/:id
router.delete('/api/memory/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const existing = getScoped(req, `SELECT id FROM memory_items WHERE id = :id AND org_id = :org_id`, { ':id': id });
  if (!existing) return res.status(404).json({ error: 'not found' });

  runScoped(req, `DELETE FROM memory_items WHERE id = :id AND org_id = :org_id`, { ':id': id });
  res.json({ ok: true, deleted: id });
});

// DELETE /dashboard/api/all?confirm=yes
router.delete('/api/all', (req, res) => {
  if (req.query.confirm !== 'yes') {
    return res.status(400).json({ error: 'must pass ?confirm=yes' });
  }

  runScoped(req, `DELETE FROM events WHERE org_id = :org_id`);
  runScoped(req, `DELETE FROM memory_items WHERE org_id = :org_id`);
  runScoped(req, `DELETE FROM sessions WHERE org_id = :org_id`);
  runScoped(req, `DELETE FROM command_queue WHERE org_id = :org_id`);
  runScoped(req, `DELETE FROM command_logs WHERE org_id = :org_id`);

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
  if (!['new', 'reviewed', 'integrated', 'dismissed', 'approved'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  updateFinding(parseInt(req.params.id), status);
  res.json({ ok: true });
});

// PATCH /dashboard/api/scout/:id — update finding (status, etc.)
router.patch('/api/scout/:id', (req, res) => {
  const { status } = req.body;
  if (status) {
    updateFinding(parseInt(req.params.id), status);
  }
  res.json({ ok: true });
});

// GET /dashboard/api/progress — project progress for WezTerm sidebar
// Returns all projects with milestone/task completion percentages
// Cached for 10s to avoid N×M query storm on every sidebar refresh
let _progressCache = null;
let _progressCacheTime = 0;
router.get('/api/progress', (req, res) => {
  const now = Date.now();
  if (_progressCache && (now - _progressCacheTime) < 10000) {
    return res.json(_progressCache);
  }
  const projects = allScoped(req, "SELECT * FROM projects WHERE org_id = :org_id ORDER BY name");

  const result = projects.map(p => {
    // Get milestones for this project
    const milestones = allScoped(req,
      "SELECT * FROM project_milestones WHERE project_id = :pid AND org_id = :org_id ORDER BY sort_order, name",
      { ':pid': p.id }
    );

    // Get task counts per milestone and overall
    const totalTasks = getScoped(req,
      "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done, SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress FROM project_tasks WHERE project_id = :pid AND org_id = :org_id",
      { ':pid': p.id }
    );

    const milestonesWithProgress = milestones.map(m => {
      const mTasks = getScoped(req,
        "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done, SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress FROM project_tasks WHERE milestone_id = :mid AND org_id = :org_id",
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
    const uncategorized = getScoped(req,
      "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done, SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress FROM project_tasks WHERE project_id = :pid AND milestone_id IS NULL AND org_id = :org_id",
      { ':pid': p.id }
    );

    const total = totalTasks?.total || 0;
    const done = totalTasks?.done || 0;
    const inProgress = totalTasks?.in_progress || 0;

    // Session count for activity
    const sessionCount = getScoped(req, "SELECT COUNT(*) as c FROM sessions WHERE project_id = :pid AND org_id = :org_id", { ':pid': p.id });

    return {
      id: p.id,
      name: p.name,
      path: p.path,
      description: p.description,
      classification: p.classification,
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
  const totalEvents = getScoped(req, "SELECT COUNT(*) as c FROM events WHERE org_id = :org_id")?.c || 0;
  const deviceCount = getScoped(req, "SELECT COUNT(*) as c FROM devices WHERE org_id = :org_id")?.c || 0;

  const response = {
    projects: result,
    activity: { total_events: totalEvents, devices: deviceCount },
    timestamp: new Date().toISOString(),
  };
  _progressCache = response;
  _progressCacheTime = Date.now();
  res.json(response);
});

// GET /dashboard/api/projects/:id/tasks — all tasks for a project
router.get('/api/projects/:id/tasks', (req, res) => {
  const pid = parseInt(req.params.id);
  const milestones = allScoped(req,
    "SELECT * FROM project_milestones WHERE project_id = :pid AND org_id = :org_id ORDER BY sort_order, name",
    { ':pid': pid }
  );
  const tasks = allScoped(req,
    `SELECT t.*, u.display_name as assigned_name
     FROM project_tasks t
     LEFT JOIN users u ON t.assigned_to = u.id
     WHERE t.project_id = :pid AND t.org_id = :org_id
     ORDER BY t.milestone_id, t.sort_order, t.title`,
    { ':pid': pid }
  );
  // Also return team members for assignment dropdowns
  const project = getScoped(req, "SELECT team_id FROM projects WHERE id = :pid AND org_id = :org_id", { ':pid': pid });
  let members = [];
  if (project?.team_id) {
    members = allScoped(req,
      `SELECT u.id, u.display_name, u.email, tm.role as team_role
       FROM team_members tm JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = :tid`,
      { ':tid': project.team_id }
    );
  }
  // Fallback: return all users in the org if no team assigned
  if (members.length === 0) {
    members = allScoped(req,
      `SELECT u.id, u.display_name, u.email
       FROM memberships m JOIN users u ON m.user_id = u.id
       WHERE m.org_id = :org_id`,
      {}
    );
  }
  res.json({ milestones, tasks, members, team_id: project?.team_id || null });
});

// PUT /dashboard/api/projects/:id/team — assign team to project
router.put('/api/projects/:id/team', (req, res) => {
  const pid = parseInt(req.params.id);
  const { team_id } = req.body;
  try {
    runScoped(req,
      "UPDATE projects SET team_id = :tid WHERE id = :pid AND org_id = :org_id",
      { ':tid': team_id || null, ':pid': pid }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /dashboard/api/projects/:id/milestones — create a milestone
router.post('/api/projects/:id/milestones', (req, res) => {
  const pid = parseInt(req.params.id);
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const maxOrder = getScoped(req, "SELECT MAX(sort_order) as m FROM project_milestones WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  const id = insertScoped(req,
    "INSERT INTO project_milestones (project_id, name, description, sort_order, org_id) VALUES (:pid, :name, :desc, :order, :org_id)",
    { ':pid': pid, ':name': name, ':desc': description || null, ':order': (maxOrder?.m || 0) + 1 }
  );
  res.json({ id, name });
});

// POST /dashboard/api/projects/:id/tasks — create a task
router.post('/api/projects/:id/tasks', (req, res) => {
  const pid = parseInt(req.params.id);
  const { title, description, milestone_id, status, priority, type, assigned_to } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const maxOrder = getScoped(req, "SELECT MAX(sort_order) as m FROM project_tasks WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  const id = insertScoped(req,
    "INSERT INTO project_tasks (project_id, milestone_id, title, description, status, priority, type, assigned_to, sort_order, org_id) VALUES (:pid, :mid, :title, :desc, :status, :pri, :type, :assign, :order, :org_id)",
    {
      ':pid': pid,
      ':mid': milestone_id || null,
      ':title': title,
      ':desc': description || null,
      ':status': status || 'todo',
      ':pri': priority || 0,
      ':type': type || 'task',
      ':assign': assigned_to || null,
      ':order': (maxOrder?.m || 0) + 1,
    }
  );
  res.json({ id, title, status: status || 'todo', type: type || 'task' });
});

// PUT /dashboard/api/tasks/:id — update a task (status, title, etc.)
router.put('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { title, description, status, priority, milestone_id } = req.body;
  const existing = getScoped(req, "SELECT * FROM project_tasks WHERE id = :id AND org_id = :org_id", { ':id': id });
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
  if (req.body.sort_order !== undefined) { updates.push("sort_order = :sort"); params[':sort'] = req.body.sort_order; }
  if (req.body.type !== undefined) { updates.push("type = :type"); params[':type'] = req.body.type; }
  if (req.body.assigned_to !== undefined) { updates.push("assigned_to = :assign"); params[':assign'] = req.body.assigned_to || null; }

  if (updates.length === 0) return res.json({ ok: true, unchanged: true });

  runScoped(req, `UPDATE project_tasks SET ${updates.join(', ')} WHERE id = :id AND org_id = :org_id`, params);
  res.json({ ok: true });
});

// DELETE /dashboard/api/tasks/:id
router.delete('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  runScoped(req, "DELETE FROM project_tasks WHERE id = :id AND org_id = :org_id", { ':id': id });
  res.json({ ok: true });
});

// DELETE /dashboard/api/milestones/:id — also deletes child tasks
router.delete('/api/milestones/:id', (req, res) => {
  const id = parseInt(req.params.id);
  runScoped(req, "DELETE FROM project_tasks WHERE milestone_id = :id AND org_id = :org_id", { ':id': id });
  runScoped(req, "DELETE FROM project_milestones WHERE id = :id AND org_id = :org_id", { ':id': id });
  res.json({ ok: true });
});

// PUT /dashboard/api/tasks/reorder — batch update sort_order + status (for Kanban drag-drop)
router.put('/api/tasks/reorder', (req, res) => {
  const { tasks } = req.body; // [{ id, status, sort_order }]
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks array required' });
  for (const t of tasks) {
    const existing = getScoped(req, "SELECT * FROM project_tasks WHERE id = :id AND org_id = :org_id", { ':id': t.id });
    if (!existing) continue;
    const updates = ["sort_order = :sort"];
    const params = { ':id': t.id, ':sort': t.sort_order ?? 0 };
    if (t.status !== undefined) {
      updates.push("status = :status");
      params[':status'] = t.status;
      if (t.status === 'done' && existing.status !== 'done') updates.push("completed_at = datetime('now','localtime')");
      if (t.status !== 'done') updates.push("completed_at = NULL");
    }
    runScoped(req, `UPDATE project_tasks SET ${updates.join(', ')} WHERE id = :id AND org_id = :org_id`, params);
  }
  res.json({ ok: true, updated: tasks.length });
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
    const existing = getScoped(req,
      "SELECT id FROM project_milestones WHERE project_id = :pid AND name = :name AND org_id = :org_id",
      { ':pid': pid, ':name': milestone_name }
    );
    if (existing) {
      milestoneId = existing.id;
    } else {
      const maxOrder = getScoped(req, "SELECT MAX(sort_order) as m FROM project_milestones WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
      milestoneId = insertScoped(req,
        "INSERT INTO project_milestones (project_id, name, sort_order, org_id) VALUES (:pid, :name, :order, :org_id)",
        { ':pid': pid, ':name': milestone_name, ':order': (maxOrder?.m || 0) + 1 }
      );
    }
  }

  let created = 0;
  for (const task of tasks) {
    const title = typeof task === 'string' ? task : task.title;
    const status = (typeof task === 'object' && task.status) || 'todo';
    if (!title) continue;
    insertScoped(req,
      "INSERT INTO project_tasks (project_id, milestone_id, title, status, sort_order, org_id) VALUES (:pid, :mid, :title, :status, :order, :org_id)",
      { ':pid': pid, ':mid': milestoneId, ':title': title, ':status': status, ':order': created }
    );
    created++;
  }
  res.json({ ok: true, created, milestone_id: milestoneId });
});

// PUT /dashboard/api/projects/:id/bulk-tasks — bulk update/upsert tasks
// Body: { tasks: [{ id?, title, status, milestone_name?, priority? }] }
router.put('/api/projects/:id/bulk-tasks', (req, res) => {
  const pid = parseInt(req.params.id);
  const { tasks } = req.body;
  if (!tasks || !Array.isArray(tasks)) return res.status(400).json({ error: 'tasks array required' });

  let updated = 0, created = 0;
  for (const task of tasks) {
    if (task.id) {
      // Update existing
      const sets = [];
      const params = { ':id': task.id };
      if (task.title) { sets.push('title = :title'); params[':title'] = task.title; }
      if (task.status) { sets.push('status = :status'); params[':status'] = task.status; }
      if (task.priority != null) { sets.push('priority = :priority'); params[':priority'] = task.priority; }
      if (sets.length > 0) {
        runScoped(req, `UPDATE project_tasks SET ${sets.join(', ')} WHERE id = :id AND org_id = :org_id`, params);
        updated++;
      }
    } else if (task.title) {
      // Create new — find/create milestone if specified
      let mid = task.milestone_id || null;
      if (!mid && task.milestone_name) {
        const existing = getScoped(req, "SELECT id FROM project_milestones WHERE project_id = :pid AND name = :name AND org_id = :org_id",
          { ':pid': pid, ':name': task.milestone_name });
        if (existing) mid = existing.id;
        else mid = insertScoped(req, "INSERT INTO project_milestones (project_id, name, org_id) VALUES (:pid, :name, :org_id)",
          { ':pid': pid, ':name': task.milestone_name });
      }
      insertScoped(req, "INSERT INTO project_tasks (project_id, milestone_id, title, status, priority, org_id) VALUES (:pid, :mid, :title, :status, :pri, :org_id)",
        { ':pid': pid, ':mid': mid, ':title': task.title, ':status': task.status || 'todo', ':pri': task.priority || 0 });
      created++;
    }
  }
  res.json({ ok: true, updated, created });
});

// DELETE /dashboard/api/projects/:id/all-tasks — delete all tasks (and optionally milestones) for a project
router.delete('/api/projects/:id/all-tasks', (req, res) => {
  const pid = parseInt(req.params.id);
  const deleteMilestones = req.query.milestones === 'true';
  const taskCount = getScoped(req, "SELECT COUNT(*) as c FROM project_tasks WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  runScoped(req, "DELETE FROM project_tasks WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  if (deleteMilestones) {
    runScoped(req, "DELETE FROM project_milestones WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  }
  res.json({ ok: true, deleted: taskCount?.c || 0, milestones_deleted: deleteMilestones });
});

// DELETE /dashboard/api/projects/:id — unlink a project from PAN (removes DB records + .pan file, does NOT delete project files)
router.delete('/api/projects/:id', (req, res) => {
  const pid = parseInt(req.params.id);
  const proj = getScoped(req, "SELECT * FROM projects WHERE id = :pid AND org_id = :org_id", { ':pid': pid });
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  // Remove all PAN data for this project (nullify session links, don't delete history)
  runScoped(req, "UPDATE sessions SET project_id = NULL WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  runScoped(req, "DELETE FROM section_items WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  runScoped(req, "DELETE FROM project_tasks WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  runScoped(req, "DELETE FROM project_milestones WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  runScoped(req, "DELETE FROM project_sections WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  runScoped(req, "DELETE FROM open_tabs WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  runScoped(req, "DELETE FROM projects WHERE id = :pid AND org_id = :org_id", { ':pid': pid });

  // Remove .pan file so sync doesn't re-add it
  try {
    const panFile = join(proj.path, '.pan');
    if (existsSync(panFile)) unlinkSync(panFile);
  } catch (e) {
    console.log(`[PAN] Could not remove .pan file: ${e.message}`);
  }

  console.log(`[PAN] Unlinked project: ${proj.name} (${proj.path})`);
  res.json({ ok: true, name: proj.name });
});

// GET /dashboard/api/tasks/search — search tasks across all projects
router.get('/api/tasks/search', (req, res) => {
  const q = req.query.q || '';
  const status = req.query.status || null;
  let where = ['t.org_id = :org_id'];
  let params = {};
  if (q) { where.push('t.title LIKE :q'); params[':q'] = `%${q}%`; }
  if (status) { where.push('t.status = :status'); params[':status'] = status; }
  const tasks = allScoped(req, `SELECT t.*, p.name as project_name, m.name as milestone_name
    FROM project_tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN project_milestones m ON m.id = t.milestone_id
    WHERE ${where.join(' AND ')}
    ORDER BY t.priority DESC, t.created_at DESC
    LIMIT 100`, params);
  res.json(tasks);
});

// POST /dashboard/api/open-tabs — save all open tabs (upsert, mark missing as closed)
router.post('/api/open-tabs', (req, res) => {
  const { tabs } = req.body;
  if (!tabs || !Array.isArray(tabs)) return res.status(400).json({ error: 'tabs array required' });

  const openIds = tabs.filter(t => t.session_id).map(t => t.session_id);

  // Mark tabs not in the list as closed (instead of deleting)
  if (openIds.length > 0) {
    const params = {};
    const placeholders = openIds.map((id, i) => { params[`:s${i}`] = id; return `:s${i}`; }).join(',');
    runScoped(req, `UPDATE open_tabs SET closed_at = datetime('now','localtime') WHERE session_id NOT IN (${placeholders}) AND closed_at IS NULL AND org_id = :org_id`, params);
  } else {
    runScoped(req, "UPDATE open_tabs SET closed_at = datetime('now','localtime') WHERE closed_at IS NULL AND org_id = :org_id");
  }

  // Upsert each open tab — reuse closed tabs with same name+project instead of creating duplicates
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    if (!tab.session_id) continue;
    const existing = getScoped(req, "SELECT id FROM open_tabs WHERE session_id = :sid AND org_id = :org_id", { ':sid': tab.session_id });
    if (existing) {
      runScoped(req,
        `UPDATE open_tabs SET tab_name = :name, project_id = :pid, cwd = :cwd, tab_index = :idx,
         claude_session_ids = :csids, closed_at = NULL, last_active = datetime('now','localtime')
         WHERE session_id = :sid AND org_id = :org_id`,
        { ':sid': tab.session_id, ':name': tab.tab_name || '', ':pid': tab.project_id || null,
          ':cwd': tab.cwd || null, ':idx': i, ':csids': tab.claude_session_ids || '[]' }
      );
    } else {
      // Check for a closed tab with the same name+project — reuse it instead of creating a duplicate
      const closedDupe = tab.project_id
        ? getScoped(req, "SELECT id FROM open_tabs WHERE tab_name = :name AND project_id = :pid AND closed_at IS NOT NULL AND org_id = :org_id ORDER BY last_active DESC LIMIT 1",
            { ':name': tab.tab_name || '', ':pid': tab.project_id })
        : null;
      if (closedDupe) {
        // Reuse the closed row: update session_id and reopen
        runScoped(req,
          `UPDATE open_tabs SET session_id = :sid, tab_name = :name, project_id = :pid, cwd = :cwd, tab_index = :idx,
           claude_session_ids = :csids, closed_at = NULL, last_active = datetime('now','localtime')
           WHERE id = :id AND org_id = :org_id`,
          { ':id': closedDupe.id, ':sid': tab.session_id, ':name': tab.tab_name || '', ':pid': tab.project_id || null,
            ':cwd': tab.cwd || null, ':idx': i, ':csids': tab.claude_session_ids || '[]' }
        );
        // Purge any other closed duplicates with same name+project
        runScoped(req, "DELETE FROM open_tabs WHERE tab_name = :name AND project_id = :pid AND closed_at IS NOT NULL AND org_id = :org_id",
          { ':name': tab.tab_name || '', ':pid': tab.project_id });
      } else {
        insertScoped(req,
          `INSERT INTO open_tabs (session_id, tab_name, project_id, cwd, tab_index, claude_session_ids, org_id)
           VALUES (:sid, :name, :pid, :cwd, :idx, :csids, :org_id)`,
          { ':sid': tab.session_id, ':name': tab.tab_name || '', ':pid': tab.project_id || null,
            ':cwd': tab.cwd || null, ':idx': i, ':csids': tab.claude_session_ids || '[]' }
        );
      }
    }
  }
  res.json({ ok: true, saved: tabs.length });
});

// PUT /dashboard/api/open-tabs/:sessionId — upsert a single tab (create or update)
router.put('/api/open-tabs/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const { tab_name, project_id, cwd, tab_index, claude_session_ids } = req.body;
  const existing = getScoped(req, "SELECT * FROM open_tabs WHERE session_id = :sid AND org_id = :org_id", { ':sid': sessionId });
  if (existing) {
    const updates = [];
    const params = { ':sid': sessionId };
    if (tab_name !== undefined) { updates.push("tab_name = :name"); params[':name'] = tab_name; }
    if (project_id !== undefined) { updates.push("project_id = :pid"); params[':pid'] = project_id; }
    if (cwd !== undefined) { updates.push("cwd = :cwd"); params[':cwd'] = cwd; }
    if (tab_index !== undefined) { updates.push("tab_index = :idx"); params[':idx'] = tab_index; }
    if (claude_session_ids !== undefined) { updates.push("claude_session_ids = :csids"); params[':csids'] = JSON.stringify(claude_session_ids); }
    updates.push("last_active = datetime('now','localtime')");
    if (updates.length > 0) runScoped(req, `UPDATE open_tabs SET ${updates.join(', ')} WHERE session_id = :sid AND org_id = :org_id`, params);
    res.json({ ok: true, action: 'updated' });
  } else {
    // Check for closed tab with same name+project to reuse
    const closedDupe = project_id
      ? getScoped(req, "SELECT id FROM open_tabs WHERE tab_name = :name AND project_id = :pid AND closed_at IS NOT NULL AND org_id = :org_id ORDER BY last_active DESC LIMIT 1",
          { ':name': tab_name || '', ':pid': project_id })
      : null;
    if (closedDupe) {
      runScoped(req,
        `UPDATE open_tabs SET session_id = :sid, tab_name = :name, project_id = :pid, cwd = :cwd, tab_index = :idx,
         claude_session_ids = :csids, closed_at = NULL, last_active = datetime('now','localtime')
         WHERE id = :id AND org_id = :org_id`,
        { ':id': closedDupe.id, ':sid': sessionId, ':name': tab_name || '', ':pid': project_id || null,
          ':cwd': cwd || null, ':idx': tab_index || 0, ':csids': JSON.stringify(claude_session_ids || []) }
      );
      runScoped(req, "DELETE FROM open_tabs WHERE tab_name = :name AND project_id = :pid AND closed_at IS NOT NULL AND org_id = :org_id",
        { ':name': tab_name || '', ':pid': project_id });
      res.json({ ok: true, action: 'reused' });
    } else {
      insertScoped(req,
        `INSERT INTO open_tabs (session_id, tab_name, project_id, cwd, tab_index, claude_session_ids, org_id)
         VALUES (:sid, :name, :pid, :cwd, :idx, :csids, :org_id)`,
        { ':sid': sessionId, ':name': tab_name || '', ':pid': project_id || null, ':cwd': cwd || null,
          ':idx': tab_index || 0, ':csids': JSON.stringify(claude_session_ids || []) }
      );
      res.json({ ok: true, action: 'created' });
    }
  }
});

// PATCH /dashboard/api/open-tabs/:sessionId/rename — rename a tab
router.patch('/api/open-tabs/:sessionId/rename', (req, res) => {
  const { name } = req.body;
  if (name === undefined) return res.status(400).json({ error: 'name required' });
  runScoped(req, "UPDATE open_tabs SET tab_name = :name, last_active = datetime('now','localtime') WHERE session_id = :sid AND org_id = :org_id",
    { ':name': name, ':sid': req.params.sessionId });
  // Rename the per-tab transcript file to match the new tab name
  try { setSessionName(req.params.sessionId, name); } catch {}
  res.json({ ok: true });
});

// DELETE /dashboard/api/open-tabs/:sessionId — mark tab as closed (never delete)
router.delete('/api/open-tabs/:sessionId', (req, res) => {
  runScoped(req, "UPDATE open_tabs SET closed_at = datetime('now','localtime') WHERE session_id = :sid AND org_id = :org_id", { ':sid': req.params.sessionId });
  res.json({ ok: true });
});

// DELETE /dashboard/api/open-tabs/:id/purge — permanently delete a closed tab
router.delete('/api/open-tabs/:id/purge', (req, res) => {
  const id = parseInt(req.params.id);
  runScoped(req, "DELETE FROM open_tabs WHERE id = :id AND closed_at IS NOT NULL AND org_id = :org_id", { ':id': id });
  res.json({ ok: true });
});

// Custom sections per project
router.get('/api/projects/:id/sections', (req, res) => {
  const pid = parseInt(req.params.id);
  const sections = allScoped(req, "SELECT * FROM project_sections WHERE project_id = :pid AND org_id = :org_id ORDER BY sort_order, name", { ':pid': pid });
  const result = sections.map(s => {
    const items = allScoped(req, "SELECT * FROM section_items WHERE section_id = :sid AND org_id = :org_id ORDER BY sort_order", { ':sid': s.id });
    return { ...s, items };
  });
  res.json(result);
});

router.post('/api/projects/:id/sections', (req, res) => {
  const pid = parseInt(req.params.id);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const maxOrder = getScoped(req, "SELECT MAX(sort_order) as m FROM project_sections WHERE project_id = :pid AND org_id = :org_id", { ':pid': pid });
  const id = insertScoped(req,
    "INSERT INTO project_sections (project_id, name, sort_order, org_id) VALUES (:pid, :name, :order, :org_id)",
    { ':pid': pid, ':name': name, ':order': (maxOrder?.m || 0) + 1 }
  );
  res.json({ id, name });
});

router.delete('/api/sections/:id', (req, res) => {
  const id = parseInt(req.params.id);
  runScoped(req, "DELETE FROM section_items WHERE section_id = :id AND org_id = :org_id", { ':id': id });
  runScoped(req, "DELETE FROM project_sections WHERE id = :id AND org_id = :org_id", { ':id': id });
  res.json({ ok: true });
});

router.post('/api/sections/:id/items', (req, res) => {
  const sid = parseInt(req.params.id);
  const section = getScoped(req, "SELECT * FROM project_sections WHERE id = :id AND org_id = :org_id", { ':id': sid });
  if (!section) return res.status(404).json({ error: 'section not found' });
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const id = insertScoped(req,
    "INSERT INTO section_items (section_id, project_id, content, org_id) VALUES (:sid, :pid, :content, :org_id)",
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
  runScoped(req, `UPDATE section_items SET ${updates.join(', ')} WHERE id = :id AND org_id = :org_id`, params);
  res.json({ ok: true });
});

router.delete('/api/section-items/:id', (req, res) => {
  runScoped(req, "DELETE FROM section_items WHERE id = :id AND org_id = :org_id", { ':id': parseInt(req.params.id) });
  res.json({ ok: true });
});

// GET /dashboard/api/open-tabs — get all open (not closed) tabs for session restore
router.get('/api/open-tabs', (req, res) => {
  const tabs = allScoped(req, `
    SELECT ot.*, p.name as project_name, p.path as project_path
    FROM open_tabs ot
    LEFT JOIN projects p ON p.id = ot.project_id
    WHERE ot.closed_at IS NULL AND ot.org_id = :org_id
    ORDER BY ot.tab_index
  `);
  res.json(tabs);
});

// GET /dashboard/api/all-tabs — get ALL tabs (open + closed) for a project
router.get('/api/all-tabs', (req, res) => {
  const projectId = req.query.project_id;
  let tabs;
  if (projectId) {
    tabs = allScoped(req, `
      SELECT ot.*, p.name as project_name, p.path as project_path
      FROM open_tabs ot
      LEFT JOIN projects p ON p.id = ot.project_id
      WHERE ot.project_id = :pid AND ot.org_id = :org_id
      ORDER BY ot.closed_at IS NULL DESC, ot.last_active DESC
    `, { ':pid': projectId });
  } else {
    tabs = allScoped(req, `
      SELECT ot.*, p.name as project_name, p.path as project_path
      FROM open_tabs ot
      LEFT JOIN projects p ON p.id = ot.project_id
      WHERE ot.org_id = :org_id
      ORDER BY ot.closed_at IS NULL DESC, ot.last_active DESC
    `);
  }
  res.json(tabs);
});

// POST /dashboard/api/open-tabs/:id/reopen — reopen a closed tab
router.post('/api/open-tabs/:id/reopen', (req, res) => {
  const id = parseInt(req.params.id);
  const tab = getScoped(req, "SELECT * FROM open_tabs WHERE id = :id AND org_id = :org_id", { ':id': id });
  if (!tab) return res.status(404).json({ error: 'tab not found' });
  runScoped(req, "UPDATE open_tabs SET closed_at = NULL, last_active = datetime('now','localtime') WHERE id = :id AND org_id = :org_id", { ':id': id });
  res.json({ ok: true, tab });
});

// ==================== ALERTS ====================

// Alert type registry — single source of truth for all alert types in the system.
// Every createAlert() call must use a type from this registry.
// Frontend uses this to populate filter dropdowns and show type metadata.
const ALERT_TYPES = {
  orphan_processes:     { label: 'Orphan Processes',     category: 'process',   defaultSeverity: 'warning',  source: 'steward',  description: 'Claude CLI processes detected without a tracked PTY parent' },
  service_crash:        { label: 'Service Crash',        category: 'service',   defaultSeverity: 'critical', source: 'steward',  description: 'A service failed too many restart cycles and gave up' },
  uncaught_exception:   { label: 'Uncaught Exception',   category: 'server',    defaultSeverity: 'critical', source: 'server',   description: 'Unhandled JS error caught by process handler' },
  unhandled_rejection:  { label: 'Unhandled Rejection',  category: 'server',    defaultSeverity: 'warning',  source: 'server',   description: 'Unhandled Promise rejection caught by process handler' },
  pty_crash:            { label: 'PTY Crash',            category: 'terminal',  defaultSeverity: 'critical', source: 'terminal', description: 'A PTY process exited unexpectedly' },
  health_check_fail:    { label: 'Health Check Failed',  category: 'service',   defaultSeverity: 'warning',  source: 'steward',  description: 'A service health check failed' },
  startup_error:        { label: 'Startup Error',        category: 'server',    defaultSeverity: 'critical', source: 'server',   description: 'Error during server boot sequence' },
  transcript_error:     { label: 'Transcript Error',     category: 'terminal',  defaultSeverity: 'warning',  source: 'terminal', description: 'Transcript read/write or watcher failure' },
  claude_cli_exit:      { label: 'Claude CLI Exit',      category: 'terminal',  defaultSeverity: 'warning',  source: 'terminal', description: 'Claude CLI process exited inside PTY (shell still alive)' },
  audit_chain_broken:   { label: 'Audit Chain Broken',   category: 'security',  defaultSeverity: 'critical', source: 'server',   description: 'HMAC audit chain verification failed — potential tampering detected' },
  context_bloat:        { label: 'Context Bloat',        category: 'usage',     defaultSeverity: 'warning',  source: 'hooks',    description: 'CLAUDE.md or injected context exceeds size threshold — burns tokens every message' },
  high_burn_rate:       { label: 'High Burn Rate',       category: 'usage',     defaultSeverity: 'warning',  source: 'hooks',    description: 'Session is consuming tokens faster than expected per message' },
};

// GET /dashboard/api/alerts/types — registry of all known alert types (for dropdowns)
router.get('/api/alerts/types', (req, res) => {
  const types = Object.entries(ALERT_TYPES).map(([id, meta]) => ({ id, ...meta }));
  res.json(types);
});

// GET /dashboard/api/alerts — list alerts (default: open only)
// Query params: status (open|acknowledged|resolved|dismissed|all), type (alert_type filter), limit
router.get('/api/alerts', (req, res) => {
  const status = req.query.status || 'open';
  const type = req.query.type || null;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const conditions = ['org_id = :org_id'];
  const params = {};
  if (status !== 'all') { conditions.push('status = :status'); params[':status'] = status; }
  if (type) { conditions.push('alert_type = :type'); params[':type'] = type; }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const alerts = allScoped(req, `SELECT * FROM alerts ${where} ORDER BY created_at DESC LIMIT ${limit}`, params);
  res.json(alerts);
});

// GET /dashboard/api/alerts/count — count open alerts (for badge)
router.get('/api/alerts/count', (req, res) => {
  const row = getScoped(req, "SELECT COUNT(*) as count FROM alerts WHERE status = 'open' AND org_id = :org_id");
  res.json({ count: row?.count || 0 });
});

// GET /dashboard/api/alerts/:id — single alert detail
router.get('/api/alerts/:id', (req, res) => {
  const alert = getScoped(req, "SELECT * FROM alerts WHERE id = :id AND org_id = :org_id", { ':id': parseInt(req.params.id) });
  if (!alert) return res.status(404).json({ error: 'alert not found' });
  res.json(alert);
});

// POST /dashboard/api/alerts — create a new alert
router.post('/api/alerts', (req, res) => {
  const { alert_type, severity, title, detail } = req.body;
  if (!alert_type || !title) return res.status(400).json({ error: 'alert_type and title required' });
  const id = insertScoped(req,
    `INSERT INTO alerts (alert_type, severity, title, detail, org_id) VALUES (:type, :sev, :title, :detail, :org_id)`,
    { ':type': alert_type, ':sev': severity || 'warning', ':title': title, ':detail': detail || '' }
  );
  try { broadcastNotification('widget_update', { widget: 'alerts' }); } catch {}
  res.json({ ok: true, id });
});

// PATCH /dashboard/api/alerts/:id — update alert status (acknowledge, resolve, dismiss)
router.patch('/api/alerts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const alert = getScoped(req, "SELECT * FROM alerts WHERE id = :id AND org_id = :org_id", { ':id': id });
  if (!alert) return res.status(404).json({ error: 'alert not found' });

  const { status, resolution, resolved_by } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });

  const validStatuses = ['open', 'acknowledged', 'resolved', 'dismissed'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });

  const resolvedAt = (status === 'resolved' || status === 'dismissed') ? "datetime('now','localtime')" : 'NULL';
  runScoped(req,
    `UPDATE alerts SET status = :status, resolution = :resolution, resolved_by = :resolved_by,
     updated_at = datetime('now','localtime'), resolved_at = ${resolvedAt} WHERE id = :id AND org_id = :org_id`,
    { ':id': id, ':status': status, ':resolution': resolution || null, ':resolved_by': resolved_by || 'user' }
  );
  try { broadcastNotification('widget_update', { widget: 'alerts' }); } catch {}
  res.json({ ok: true });
});

// Helper: create alert from server code (exported for use by steward, terminal, etc.)
// Uses ALERT_TYPES registry for validation and default severity.
export function createAlert({ alert_type, severity, title, detail = '', org_id = 1 }) {
  const typeMeta = ALERT_TYPES[alert_type];
  if (!typeMeta) {
    console.warn(`[Alerts] Unknown alert_type "${alert_type}" — add it to ALERT_TYPES in dashboard.js`);
  }
  const sev = severity || typeMeta?.defaultSeverity || 'warning';
  const result = insert(
    `INSERT INTO alerts (alert_type, severity, title, detail, org_id) VALUES (:type, :sev, :title, :detail, :org_id)`,
    { ':type': alert_type, ':sev': sev, ':title': title, ':detail': detail, ':org_id': org_id }
  );
  // Push to all connected dashboard clients so alerts panel updates instantly
  try { broadcastNotification('widget_update', { widget: 'alerts' }); } catch {}
  return result;
}

// Generic widget update broadcast — call from any subsystem when data changes.
// The dashboard client listens for these and refetches only the affected widget.
export function broadcastWidgetUpdate(widget) {
  try { broadcastNotification('widget_update', { widget }); } catch {}
}

export { ALERT_TYPES };

export default router;

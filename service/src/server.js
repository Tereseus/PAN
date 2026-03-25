// PAN Service — the core server running on port 7777
//
// Runs as a Windows service (WinSW via daemon/pan.exe), auto-starts on boot.
// Uses local Claude Code CLI for AI (no API key needed — claude-runner.cjs
// shells out to `claude -p` which uses the user's Claude Code subscription).
//
// On startup: syncs project DB with disk reality (scans for .pan files),
// then re-syncs every 10 minutes to pick up renames, new projects, deletions.
//
// Routes:
//   /hooks          - Claude Code session hooks (SessionStart/SessionEnd)
//   /api/v1         - Phone/Pandant API (audio, photos, queries, actions)
//   /api/v1/devices - Device registry and command queue
//   /dashboard      - Web UI dashboard + API
//   /health         - Health check

import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import hooksRouter from './routes/hooks.js';
import apiRouter from './routes/api.js';
import authRouter from './routes/auth.js';
import devicesRouter from './routes/devices.js';
import dashboardRouter from './routes/dashboard.js';
import sensorsRouter, { seedSensors } from './routes/sensors.js';
import { extractUser } from './middleware/auth.js';
import { startClassifier, stopClassifier } from './classifier.js';
import { startScout, stopScout } from './scout.js';
import { startDream, stopDream } from './dream.js';
import { startAutoDev, stopAutoDev, getConfig as getAutoDevConfig, saveConfig as saveAutoDevConfig, getAutoDevLog } from './autodev.js';
import { startStackScanner, stopStackScanner, getAllStacks, scanStacks, getProjectBriefing, getEnvironmentBriefing } from './stack-scanner.js';
import { syncProjects, get, all, insert, run, indexEventFTS } from './db.js';
import { readFileSync, existsSync } from 'fs';
import { startTerminalServer, listSessions, killSession, getTerminalProjects, sendToSession, getPendingPermissions, clearPermission, respondToPermission } from './terminal.js';
import { hostname } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = 7777;
const HOST = '0.0.0.0'; // Listen on all interfaces (phone needs LAN access)

const app = express();
app.use(express.json({ limit: '10mb' }));

// Auto-register/update phone device from any route (phone sends X-Device-Name header)
app.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const deviceName = req.headers['x-device-name'];
  if (deviceName && ip !== '127.0.0.1' && ip !== '::1' && !ip.endsWith('127.0.0.1')) {
    const phoneHost = `phone-${ip.replace(/[^0-9.]/g, '')}`;
    const existing = get("SELECT * FROM devices WHERE hostname = :h", { ':h': phoneHost });
    if (existing) {
      run("UPDATE devices SET name = :name, last_seen = datetime('now','localtime') WHERE hostname = :h",
        { ':name': deviceName, ':h': phoneHost });
    }
  }
  next();
});

// Auth routes (some endpoints skip auth — login-related stuff)
app.use('/api/v1/auth', (req, res, next) => {
  const publicPaths = ['/oauth', '/google-callback', '/github-callback', '/dev-token'];
  if (publicPaths.includes(req.path)) return next();
  // GET /providers is public (login page needs it), POST needs auth
  if (req.path === '/providers' && req.method === 'GET') return next();
  extractUser(req, res, next);
}, authRouter);

// Clipboard image upload — saves pasted image to temp file, returns path (no auth — local only)
app.post('/api/v1/clipboard-image', async (req, res) => {
  try {
    const { data, mimeType } = req.body;
    if (!data) return res.status(400).json({ ok: false, error: 'No image data' });
    const ext = (mimeType || 'image/png').split('/')[1] || 'png';
    const filename = `clipboard_${Date.now()}.${ext}`;
    const { join } = await import('path');
    const { writeFileSync, mkdirSync } = await import('fs');
    const dir = join(process.env.TEMP || 'C:\\Users\\tzuri\\AppData\\Local\\Temp', 'pan-clipboard');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, filename);
    writeFileSync(filePath, Buffer.from(data, 'base64'));
    res.json({ ok: true, path: filePath });
  } catch (err) {
    console.error('[PAN Clipboard] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Auth middleware — all other /api routes get req.user
app.use('/api', extractUser);

// Hook events from Claude Code
app.use('/hooks', hooksRouter);

// API for Android app / Pandant data
app.use('/api/v1', apiRouter);

// Device management
app.use('/api/v1/devices', devicesRouter);

// Sensor management API
app.use('/api/sensors', sensorsRouter);

// Dashboard (web UI + API)
app.use('/dashboard', dashboardRouter);
app.use('/dashboard', express.static(join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// GitHub OAuth callback — redirect to dashboard with code param so JS handles it
app.get('/auth/github/callback', (req, res) => {
  res.redirect(`/dashboard/?code=${req.query.code}`);
});

// Google OAuth callback — send code back to opener window, then close popup
app.get('/auth/google/callback', (req, res) => {
  const code = req.query.code || '';
  const error = req.query.error || '';
  res.send(`<!DOCTYPE html><html><head><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 40px; text-align: center; max-width: 400px; }
    h2 { margin-bottom: 12px; font-size: 20px; }
    p { color: #8b949e; margin-bottom: 24px; font-size: 14px; }
    .btn { display: inline-block; padding: 10px 24px; background: #58a6ff; color: #0d1117; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px; }
    .btn:hover { background: #79b8ff; }
  </style></head><body>
  <div class="card">
    <h2>${error ? 'Sign-in Failed' : 'Completing sign-in...'}</h2>
    <p>${error ? 'Google returned an error. This may be a temporary issue — try again in a few minutes.' : 'You should be redirected automatically.'}</p>
    <a class="btn" href="/dashboard/">Back to Dashboard</a>
  </div>
  <script>
    if ('${code}' && window.opener) {
      window.opener.postMessage({ type: 'google-oauth', code: '${code}', error: '${error}' }, window.location.origin);
      window.close();
    } else if ('${code}' && !window.opener) {
      window.location.href = '/dashboard/?google_code=${code}';
    }
  </script></body></html>`);
});

// Serve captured photos (stored in src/data/photos by api.js)
app.use('/photos', express.static(join(__dirname, 'data', 'photos')));

// Serve clipboard images (pasted screenshots from dashboard)
app.use('/clipboard', express.static(join(process.env.TEMP || 'C:\\Users\\tzuri\\AppData\\Local\\Temp', 'pan-clipboard')));

// Terminal API — list sessions, projects for terminal
app.get('/api/v1/terminal/sessions', (req, res) => {
  res.json({ sessions: listSessions() });
});
app.get('/api/v1/terminal/projects', (req, res) => {
  res.json({ projects: getTerminalProjects() });
});
app.delete('/api/v1/terminal/sessions/:id', (req, res) => {
  const killed = killSession(req.params.id);
  res.json({ ok: killed });
});
// Permission prompts — mobile polls this to show Allow/Deny buttons
app.get('/api/v1/terminal/permissions', (req, res) => {
  res.json({ permissions: getPendingPermissions() });
});
app.delete('/api/v1/terminal/permissions/:id', (req, res) => {
  clearPermission(parseInt(req.params.id));
  res.json({ ok: true });
});
// Send text to active terminal (phone voice commands → terminal)
app.post('/api/v1/terminal/send', (req, res) => {
  const { text, session_id, raw } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  // raw=true sends without appending \r (for single-keypress responses like permission prompts)
  const toSend = raw ? text : text + '\r';
  const sent = sendToSession(session_id || null, toSend);
  console.log(`[PAN Send] "${text}" → ${session_id || 'auto'} (raw=${!!raw}, sent=${sent})`);

  // Log as event so mobile sends are tracked
  const dataStr = JSON.stringify({
    text, session_id: session_id || 'auto', sent, raw: !!raw,
    source: 'mobile_dashboard', timestamp: Date.now()
  });
  const eventId = insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
    ':sid': session_id || 'mobile-send', ':type': 'MobileSend', ':data': dataStr
  });
  indexEventFTS(eventId, 'MobileSend', dataStr);

  const sessInfo = listSessions();
  res.json({ ok: sent, session: session_id || 'auto', active_sessions: sessInfo.map(s => s.id + '(' + s.clients + ')') });
});

// Permission response — mobile user tapped Allow or Deny
// Sets the response on the pending permission so the blocking PermissionRequest hook can return
app.post('/api/v1/terminal/permissions/respond', (req, res) => {
  const { response, perm_id } = req.body;
  if (!response) return res.status(400).json({ error: 'response required (allow or deny)' });
  if (!perm_id) return res.status(400).json({ error: 'perm_id required' });

  // Normalize response: accept various formats from mobile
  const normalized = (response === '1' || response === 'allow' || response === 'yes' || response === true)
    ? 'allow' : 'deny';

  const allPerms = getPendingPermissions();
  console.log(`[PAN Perm] Trying to respond: perm_id=${perm_id} (type=${typeof perm_id}), pending=${allPerms.length}, ids=${allPerms.map(p=>p.id).join(',')}`);
  const found = respondToPermission(parseInt(perm_id), normalized);
  console.log(`[PAN Perm] Response: ${normalized} for perm ${perm_id} (found=${found})`);

  res.json({ ok: found, response: normalized, method: 'hook' });
});

// AutoDev API
app.get('/api/v1/autodev/config', (req, res) => res.json(getAutoDevConfig()));
app.put('/api/v1/autodev/config', (req, res) => {
  saveAutoDevConfig(req.body);
  res.json({ ok: true });
});
app.get('/api/v1/autodev/log', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(getAutoDevLog(limit));
});
app.post('/api/v1/autodev/run', async (req, res) => {
  const { autodev } = await import('./autodev.js');
  autodev();
  res.json({ ok: true, message: 'AutoDev triggered' });
});

// Wait for next terminal response — polls events DB for a Stop event after a given timestamp
app.get('/api/v1/terminal/wait-response', async (req, res) => {
  const since = req.query.since || new Date().toISOString().replace('T', ' ').slice(0, 19);
  const maxWait = Math.min(parseInt(req.query.timeout) || 30000, 60000);
  const startTime = Date.now();

  const poll = setInterval(() => {
    const event = get(
      `SELECT data FROM events WHERE event_type = 'Stop' AND created_at > :since ORDER BY created_at DESC LIMIT 1`,
      { ':since': since }
    );
    if (event) {
      clearInterval(poll);
      try {
        const parsed = JSON.parse(event.data);
        res.json({ ok: true, response: parsed.last_assistant_message || '' });
      } catch {
        res.json({ ok: false, error: 'parse error' });
      }
    } else if (Date.now() - startTime > maxWait) {
      clearInterval(poll);
      res.json({ ok: false, error: 'timeout' });
    }
  }, 1000);
});

// Stack Scanner API
app.get('/api/v1/stacks', (req, res) => res.json(getAllStacks()));
app.post('/api/v1/stacks/scan', (req, res) => {
  scanStacks();
  res.json({ ok: true });
});

// Context briefing — living state doc + recent chat for new Claude sessions
app.get('/api/v1/context-briefing', (req, res) => {
  const projectPath = req.query.project_path || '';

  // 1. Read the living state document (maintained by dream cycle)
  const stateFile = join(process.cwd(), '.pan-state.md');
  let stateDoc = '';
  try {
    if (existsSync(stateFile)) stateDoc = readFileSync(stateFile, 'utf8');
  } catch {}

  // 2. Recent conversation for this project (last 30 exchanges)
  let recentChat = [];
  if (projectPath) {
    const fwd = projectPath.replace(/\\/g, '/');
    const bk = fwd.replace(/\//g, '\\\\');
    recentChat = all(
      `SELECT event_type, data, created_at FROM events
       WHERE (event_type = 'UserPromptSubmit' OR event_type = 'Stop' OR event_type = 'AssistantMessage')
       AND (data LIKE :pp1 OR data LIKE :pp2)
       ORDER BY created_at DESC LIMIT 30`,
      { ':pp1': '%' + bk + '%', ':pp2': '%' + fwd + '%' }
    );
  } else {
    recentChat = all(
      `SELECT event_type, data, created_at FROM events
       WHERE event_type IN ('UserPromptSubmit', 'Stop', 'AssistantMessage')
       ORDER BY created_at DESC LIMIT 30`
    );
  }

  // 3. Open tasks for this project
  let tasks = [];
  if (projectPath) {
    const fwd = projectPath.replace(/\\/g, '/');
    const project = get("SELECT id FROM projects WHERE path = :p", { ':p': fwd });
    if (project) {
      tasks = all(
        `SELECT title, status, priority FROM project_tasks
         WHERE project_id = :pid AND status != 'done'
         ORDER BY priority DESC LIMIT 15`,
        { ':pid': project.id }
      );
    }
  }

  // 4. Project environment & tech stack (so Claude knows what "terminal", "app", etc. mean)
  let projectBrief = '';
  if (projectPath) {
    const fwd = projectPath.replace(/\\/g, '/');
    const proj = get("SELECT id FROM projects WHERE path = :p", { ':p': fwd });
    if (proj) projectBrief = getProjectBriefing(proj.id);
  }
  if (!projectBrief) {
    // No project match — still include environment info
    projectBrief = '## Development Environment\n' + getEnvironmentBriefing() + '\n';
  }

  // 5. Build briefing
  let briefing = '=== PAN SESSION CONTEXT BRIEFING ===\n\n';

  // Environment context first — so Claude knows the tools before anything else
  briefing += projectBrief + '\n';

  // State doc is the primary context source
  if (stateDoc) {
    briefing += stateDoc + '\n\n';
  }

  if (tasks.length > 0) {
    briefing += '## Open Tasks\n';
    for (const t of tasks) briefing += '- [' + t.status + (t.priority > 0 ? ' P' + t.priority : '') + '] ' + t.title + '\n';
    briefing += '\n';
  }

  if (recentChat.length > 0) {
    briefing += '## Recent Conversation\n';
    const chatItems = [...recentChat].reverse();
    for (const e of chatItems) {
      try {
        const d = JSON.parse(e.data);
        if (e.event_type === 'UserPromptSubmit' && d.prompt)
          briefing += 'User (' + e.created_at + '): ' + d.prompt.substring(0, 300) + '\n';
        else if (e.event_type === 'Stop' && d.last_assistant_message)
          briefing += 'Claude (' + e.created_at + '): ' + d.last_assistant_message.substring(0, 500) + '\n';
      } catch {}
    }
    briefing += '\n';

    // Last few messages at full length for real context
    const lastMessages = chatItems.slice(-6);
    if (lastMessages.length > 0) {
      briefing += '## Last Messages (Full)\n';
      for (const e of lastMessages) {
        try {
          const d = JSON.parse(e.data);
          if (e.event_type === 'UserPromptSubmit' && d.prompt)
            briefing += 'User (' + e.created_at + '):\n' + d.prompt.substring(0, 3000) + '\n\n';
          else if (e.event_type === 'Stop' && d.last_assistant_message)
            briefing += 'Claude (' + e.created_at + '):\n' + d.last_assistant_message.substring(0, 3000) + '\n\n';
        } catch {}
      }
    }
  }

  briefing += '## Instructions\nThis is a fresh session. Your FIRST message to the user MUST be a brief summary of the Recent Conversation above — start with "Last time we were working on..." and list the key topics/issues. The user should NEVER have to ask what they were working on. You tell them immediately, every single time. Then pick up where they left off.\n';

  res.json({ briefing, state: stateDoc.length > 0, tasks: tasks.length, chat: recentChat.length });
});

// Dictation — record from PC mic, transcribe via Haiku, return text
app.post('/api/v1/dictate', async (req, res) => {
  const duration = Math.min(req.body?.duration || 5, 30); // max 30 seconds
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dir = dirname(fileURLToPath(import.meta.url));

    // Record audio using Python sounddevice
    const recordScript = join(__dir, 'dictate.py');
    const { stdout } = await execFileAsync('python', [recordScript, String(duration)], {
      timeout: (duration + 5) * 1000
    });
    const result = JSON.parse(stdout.trim());

    if (result.text) {
      res.json({ ok: true, text: result.text });
    } else {
      res.json({ ok: false, error: result.error || 'No transcription' });
    }
  } catch (err) {
    console.error('[PAN Dictate] Error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'running', timestamp: new Date().toISOString() });
});

let server;

function start() {
  return new Promise((resolve, reject) => {
    server = app.listen(PORT, HOST, () => {
      console.log(`[PAN] Service running on http://${HOST}:${PORT}`);
      console.log(`[PAN] Listening for Claude Code hooks...`);

      // Start WebSocket terminal server on same HTTP server
      startTerminalServer(server);

      // Sync projects with disk reality on startup
      syncProjects();

      // Seed sensor definitions (22 sensors)
      seedSensors();

      // Auto-register this PC as a device
      const pcHost = hostname();
      const existing = get("SELECT * FROM devices WHERE hostname = :h", { ':h': pcHost });
      if (!existing) {
        insert(`INSERT INTO devices (hostname, name, device_type, capabilities, last_seen)
          VALUES (:h, :name, 'pc', '["terminal","files","browser","apps"]', datetime('now','localtime'))`, {
          ':h': pcHost, ':name': pcHost
        });
        console.log(`[PAN] Registered PC: ${pcHost}`);
      } else {
        run("UPDATE devices SET last_seen = datetime('now','localtime') WHERE hostname = :h", { ':h': pcHost });
      }

      // Re-sync projects every 10 minutes (picks up renames, new .pan files)
      setInterval(syncProjects, 10 * 60 * 1000);

      // Start classification engine (every 5 minutes)
      startClassifier(5 * 60 * 1000);

      // Start tool scout (every 12 hours — discovers new CLIs and tools)
      startScout(12 * 60 * 60 * 1000);

      // Start auto-dream (every 6 hours — consolidates events into structured memory)
      startDream(6 * 60 * 60 * 1000);

      // Start Stack Scanner (every 6 hours — discovers tech stacks per project)
      startStackScanner(6 * 60 * 60 * 1000);

      // Start AutoDev (checks hourly, runs at configured time — disabled by default)
      startAutoDev(60 * 60 * 1000);

      resolve(server);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[PAN] Port ${PORT} already in use — is PAN already running?`);
      }
      reject(err);
    });
  });
}

function stop() {
  stopClassifier();
  stopScout();
  stopDream();
  stopAutoDev();
  stopStackScanner();
  if (server) server.close();
}

export { start, stop, app };

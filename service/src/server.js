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
import devicesRouter from './routes/devices.js';
import dashboardRouter from './routes/dashboard.js';
import { startClassifier, stopClassifier } from './classifier.js';
import { startScout, stopScout } from './scout.js';
import { startDream, stopDream } from './dream.js';
import { startAutoDev, stopAutoDev, getConfig as getAutoDevConfig, saveConfig as saveAutoDevConfig, getAutoDevLog } from './autodev.js';
import { startStackScanner, stopStackScanner, getAllStacks, scanStacks } from './stack-scanner.js';
import { syncProjects, get, insert, run, indexEventFTS } from './db.js';
import { startTerminalServer, listSessions, killSession, getTerminalProjects, sendToSession, getPendingPermissions, clearPermission, respondToPermission } from './terminal.js';
import { hostname } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = 7777;
const HOST = '0.0.0.0'; // Listen on all interfaces (phone needs LAN access)

const app = express();
app.use(express.json({ limit: '10mb' }));

// Hook events from Claude Code
app.use('/hooks', hooksRouter);

// API for Android app / Pandant data
app.use('/api/v1', apiRouter);

// Device management
app.use('/api/v1/devices', devicesRouter);

// Dashboard (web UI + API)
app.use('/dashboard', dashboardRouter);
app.use('/dashboard', express.static(join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Serve captured photos (stored in src/data/photos by api.js)
app.use('/photos', express.static(join(__dirname, 'data', 'photos')));

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

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
import { syncProjects, get, insert, run } from './db.js';
import { startTerminalServer, listSessions, killSession, getTerminalProjects, sendToSession } from './terminal.js';
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
// Send text to active terminal (phone voice commands → terminal)
app.post('/api/v1/terminal/send', (req, res) => {
  const { text, session_id } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const sent = sendToSession(session_id || null, text + '\n');
  res.json({ ok: sent, session: session_id || 'auto' });
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
  if (server) server.close();
}

export { start, stop, app };

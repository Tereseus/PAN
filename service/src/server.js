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
import { join, dirname, resolve as pathResolve, basename } from 'path';
import { fileURLToPath } from 'url';
import hooksRouter, { injectSessionContext } from './routes/hooks.js';
import apiRouter from './routes/api.js';
import authRouter from './routes/auth.js';
import devicesRouter from './routes/devices.js';
import dashboardRouter, { createAlert } from './routes/dashboard.js';
import sensorsRouter, { seedSensors } from './routes/sensors.js';
import runnerRouter from './routes/runner.js';
import { extractUser } from './middleware/auth.js';
import { evolve } from './evolution/engine.js';
import { buildContext as buildMemoryContext } from './memory/index.js';
import { getConfig as getAutoDevConfig, saveConfig as saveAutoDevConfig, getAutoDevLog } from './autodev.js';
import { getAllStacks, scanStacks, getProjectBriefing, getEnvironmentBriefing } from './stack-scanner.js';
import { bootAll, shutdownAll, getAtlasData, getServiceStatus, reportServiceRun } from './steward.js';
import { PAN_MODE, IS_USER_MODE, IS_SERVICE_MODE, MODE_INFO } from './mode.js';
import { syncProjects, get, all, insert, run, indexEventFTS, db } from './db.js';
import { searchMemory, backfillEmbeddings } from './memory-search.js';
import { listScopes, wipeScope } from './db-registry.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import https from 'https';
import { execFileSync, execSync, spawn as spawnChild } from 'child_process';
import { startTerminalServer, startDevTerminalServer, listSessions, killSession, killAllSessions, getActivePtyPids, getTerminalProjects, sendToSession, broadcastToSession, broadcastNotification, getPendingPermissions, clearPermission, respondToPermission, getProcessRegistry, pipeSend, pipeInterrupt, getSessionMessages } from './terminal-bridge.js';
const IS_CRAFT = process.env.PAN_CRAFT === '1';
import { hostname, homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PAN_PORT) || 7777;
const HOST = '0.0.0.0'; // Listen on all interfaces (phone needs LAN access)
// Dev mode: PAN_DEV=1 runs server on a separate port with no side-effects.
// Skips steward, device registration, service boots — just
// Express + API + DB (read-safe via WAL) + test runner. Safe to run alongside prod.
const IS_DEV = process.env.PAN_DEV === '1' || process.env.PAN_DEV === 'true';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ==================== API Performance Tracking ====================
// Tracks request latency per route for the /dashboard/api/perf endpoint.
const _perfStats = { requests: 0, slowRequests: 0, totalMs: 0, slowest: [] };
const _perfByRoute = new Map(); // route → { count, totalMs, maxMs }
app.use((req, res, next) => {
  const start = performance.now();
  const original = res.end;
  res.end = function (...args) {
    const ms = +(performance.now() - start).toFixed(1);
    const route = req.route?.path || req.path;
    _perfStats.requests++;
    _perfStats.totalMs += ms;
    if (ms > 2000) _perfStats.slowRequests++;
    // Track per-route stats
    let r = _perfByRoute.get(route);
    if (!r) { r = { count: 0, totalMs: 0, maxMs: 0 }; _perfByRoute.set(route, r); }
    r.count++;
    r.totalMs += ms;
    if (ms > r.maxMs) r.maxMs = ms;
    // Keep top 10 slowest requests (rolling)
    if (_perfStats.slowest.length < 10 || ms > _perfStats.slowest[_perfStats.slowest.length - 1].ms) {
      _perfStats.slowest.push({ route, ms, ts: Date.now() });
      _perfStats.slowest.sort((a, b) => b.ms - a.ms);
      if (_perfStats.slowest.length > 10) _perfStats.slowest.length = 10;
    }
    return original.apply(this, args);
  };
  next();
});

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

// Setup status — no auth required (first-run needs this before they have a token)
app.get('/api/setup-status', async (req, res) => {
  const result = { configured: false, model: null, provider: null, error: null };

  // Check if a Server API Model is set
  try {
    const row = get("SELECT value FROM settings WHERE key = 'ai_model'");
    if (row) {
      const model = row.value.replace(/^"|"$/g, '');
      if (model) {
        result.model = model;
        result.configured = true;
      }
    }
  } catch {}

  // Also check if a CLI Provider is set (e.g. "claude" uses Claude Code subscription directly)
  if (!result.configured) {
    try {
      const row = get("SELECT value FROM settings WHERE key = 'terminal_ai'");
      if (row) {
        const ta = JSON.parse(row.value);
        const provider = ta.provider || '';
        if (provider) {
          result.model = provider + ' (CLI)';
          result.configured = true;
        }
      }
    } catch {}
  }

  // Default: PAN always has Claude CLI available via subscription
  if (!result.configured) {
    result.model = 'claude (CLI)';
    result.configured = true;
  }

  if (result.configured) {
    // If using CLI provider, just mark as working — no API test needed
    if (result.model && result.model.endsWith('(CLI)')) {
      result.provider = 'working';
    } else {
      try {
        const { claude } = await import('./claude.js');
        const test = await claude('Say "ok" and nothing else.', { timeout: 10000, maxTokens: 10, caller: 'setup-check' });
        if (test) result.provider = 'working';
      } catch (e) {
        result.error = e.message;
        result.configured = false;
      }
    }
  }

  try {
    const row = get("SELECT value FROM settings WHERE key = 'custom_models'");
    if (row) {
      const models = JSON.parse(row.value);
      if (models.length > 0) result.has_custom_models = true;
    }
  } catch {}

  res.json(result);
});

// Auth middleware — all other /api routes get req.user
// Tailscale or localhost requests with X-Device-Name header auto-authenticate
app.use('/api', (req, res, next) => {
  // Bootstrap endpoints skip auth
  if (req.path === '/v1/tailscale/auto-auth' || req.path === '/v1/tailscale/status') {
    req.user = { id: 1, email: 'bootstrap@localhost', display_name: 'Bootstrap', role: 'owner' };
    return next();
  }
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const deviceName = req.headers['x-device-name'];
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1') || ip === '::ffff:127.0.0.1';
  const isTailscale = ip.startsWith('100.') || ip.startsWith('::ffff:100.');
  const isLan = ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.');
  if (deviceName && (isLocalhost || isTailscale || isLan)) {
    req.user = { id: 1, email: 'owner@localhost', display_name: 'Owner', role: 'owner' };
    return next();
  }
  if (isLocalhost || isTailscale) {
    // Tailscale connections are trusted — already behind WireGuard mesh VPN.
    // Browser dashboard on phone doesn't send X-Device-Name header.
    req.user = { id: 1, email: 'owner@localhost', display_name: 'Owner', role: 'owner' };
    return next();
  }
  extractUser(req, res, next);
});

// Hook events from Claude Code
app.use('/hooks', hooksRouter);

// PAN Process Scanner
const PAN_SIGNATURES = [
  { pattern: 'pan.js start', name: 'PAN Server', vital: true },
  { pattern: 'pan-atc.js', name: 'ATC', vital: true },
  { pattern: 'mcp-server.js', name: 'MCP Server', vital: true },
  { pattern: 'dev-server.js', name: 'Dev Server', vital: false },
  { pattern: 'vosk-server', name: 'Vosk STT', vital: true },
  { pattern: 'claude-code/cli.js', name: 'Claude Session', vital: false },
  { pattern: 'chrome-devtools-mcp', name: 'Chrome MCP', vital: false },
  { pattern: 'vite', name: 'Vite Dev', vital: false },
  { pattern: 'wrapper.js', name: 'Service Wrapper', vital: true },
];

// Performance metrics endpoint — API latency, heap, DB, connections
app.get('/dashboard/api/perf', async (req, res) => {
  const mem = process.memoryUsage();
  const avgMs = _perfStats.requests ? +( _perfStats.totalMs / _perfStats.requests).toFixed(1) : 0;
  // Top 10 slowest routes by max latency
  const topRoutes = [..._perfByRoute.entries()]
    .map(([route, s]) => ({ route, count: s.count, avgMs: +(s.totalMs / s.count).toFixed(1), maxMs: +s.maxMs.toFixed(1) }))
    .sort((a, b) => b.maxMs - a.maxMs)
    .slice(0, 10);
  // WebSocket connection count
  let wsConnections = 0;
  try {
    const sessions = await listSessions();
    wsConnections = sessions.reduce((sum, s) => sum + (s.clients || 0), 0);
  } catch {}
  res.json({
    total_requests: _perfStats.requests,
    slow_requests: _perfStats.slowRequests,
    avg_ms: avgMs,
    slowest: _perfStats.slowest,
    top_routes: topRoutes,
    heap_mb: Math.round(mem.heapUsed / 1048576),
    heap_total_mb: Math.round(mem.heapTotal / 1048576),
    rss_mb: Math.round(mem.rss / 1048576),
    external_mb: Math.round((mem.external || 0) / 1048576),
    ws_connections: wsConnections,
    uptime_s: Math.round(process.uptime()),
    event_loop_lag_ms: null, // placeholder for future event loop monitoring
    scanned_at: new Date().toISOString(),
  });
});

app.get('/dashboard/api/processes', (req, res) => {
  // Single source of truth: the steward service registry. Each registered
  // PAN service either runs in the main pan-server process (interval/function
  // health checks) or as its own OS process (port/process health checks).
  // We resolve OS-process services to real PIDs by matching the Windows
  // process list against each service's port or processName, and surface
  // their real CPU/mem/uptime alongside the canonical name from the registry.
  //
  // Anything Node/Python eating >10% CPU that ISN'T a PAN service shows up
  // in a small `other` list so the user can still spot zombie hogs without
  // them polluting the main PAN process panel.
  try {
    const raw = execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('node.exe','python.exe','python3.exe','AutoHotkey64.exe','tailscaled.exe','ollama.exe','claude.exe')} | Select-Object ProcessId, Name, CommandLine, CreationDate, KernelModeTime, UserModeTime, WorkingSetSize | ConvertTo-Json -Depth 2\"",
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    const parsed = JSON.parse(raw || '[]');
    const procList = Array.isArray(parsed) ? parsed : [parsed];
    const now = Date.now();
    const enriched = procList.map(p => {
      const cmd = p.CommandLine || '';
      const cpuSec = ((p.KernelModeTime || 0) + (p.UserModeTime || 0)) / 10000000;
      const memMB = Math.round((p.WorkingSetSize || 0) / 1048576);
      let uptimeHrs = 0, createdAt = null;
      if (p.CreationDate) {
        const m = String(p.CreationDate).match(/\/Date\((\d+)[+-]/);
        if (m) { createdAt = new Date(parseInt(m[1])).toISOString(); uptimeHrs = +((now - parseInt(m[1])) / 3600000).toFixed(1); }
      }
      return { pid: p.ProcessId, exe: p.Name, cmd, cpuSec: +cpuSec.toFixed(1), memMB, uptimeHrs, createdAt };
    });

    // Match a steward service to a Windows process. Returns the matching
    // enriched proc or null if not found.
    function matchProcForService(svc) {
      // 1. Self — pan-server is THIS node process (server.js).
      if (svc.id === 'pan-server') {
        return enriched.find(p => p.exe === 'node.exe' && /server\.js/i.test(p.cmd)) || null;
      }
      // 2. processName-based services (AHK, Tailscale).
      if (svc.processName) {
        const candidates = enriched.filter(p => p.exe.toLowerCase() === svc.processName.toLowerCase());
        if (svc.processCmdLineMatch) {
          const re = new RegExp(svc.processCmdLineMatch.replace(/\\\\/g, '\\\\'), 'i');
          return candidates.find(p => re.test(p.cmd)) || candidates[0] || null;
        }
        return candidates[0] || null;
      }
      // 3. Port-based services. Match by port appearing in the command line —
      // works for whisper-server.py (port 7782) and ollama (port 11434).
      // Less reliable than netstat but doesn't require admin or extra calls.
      if (svc.port) {
        const portStr = String(svc.port);
        const byCmd = enriched.find(p => p.cmd.includes(portStr));
        if (byCmd) return byCmd;
        // Ollama special-case: it's `ollama.exe`, no port in cmdline.
        if (svc.id === 'ollama') return enriched.find(p => p.exe === 'ollama.exe') || null;
        return null;
      }
      // 4. In-process services (interval/function health checks). They share
      // the main pan-server process — return null so the UI knows to mark
      // them as "in-process" rather than missing.
      return null;
    }

    const atlas = getAtlasData();
    const services = (atlas.services || []).map(svc => {
      const proc = matchProcForService(svc);
      const inProcess = !proc && (svc.healthCheck === 'interval' || svc.healthCheck === 'function');
      return {
        id: svc.id,
        name: svc.name,
        status: svc.status,
        lastError: svc.lastError,
        lastRun: svc.lastRun,
        port: svc.port,
        modelTier: svc.modelTier,
        modelTierLabel: svc.modelTierLabel,
        // Real OS metrics (or null if in-process / not running)
        pid: proc?.pid || null,
        cpuSec: proc?.cpuSec ?? null,
        memMB: proc?.memMB ?? null,
        uptimeHrs: proc?.uptimeHrs ?? null,
        createdAt: proc?.createdAt || null,
        inProcess,
      };
    });

    // Anything else eating >10% CPU that ISN'T claimed by a PAN service —
    // surfaced separately as "other" so zombie processes are visible without
    // muddying the canonical PAN list.
    const claimedPids = new Set(services.map(s => s.pid).filter(Boolean));
    const other = enriched
      .filter(p => !claimedPids.has(p.pid) && p.cpuSec > 10)
      .map(p => ({
        pid: p.pid,
        exe: p.exe,
        cmd: p.cmd.length > 120 ? p.cmd.substring(0, 117) + '...' : p.cmd,
        cpuSec: p.cpuSec,
        memMB: p.memMB,
        uptimeHrs: p.uptimeHrs,
      }))
      .sort((a, b) => b.cpuSec - a.cpuSec);

    // Legacy `processes` field kept for backwards compat with the existing
    // dashboard widget — flat list of just the running PAN services with
    // real PIDs, sorted by CPU. The new `services` and `other` fields are
    // the preferred shape for the rebuilt panel.
    const processes = services
      .filter(s => s.pid)
      .map(s => ({ pid: s.pid, name: s.name, vital: true, cpuSec: s.cpuSec, memMB: s.memMB, uptimeHrs: s.uptimeHrs, createdAt: s.createdAt, isPan: true, isZombie: false, cmd: '' }))
      .sort((a, b) => (b.cpuSec || 0) - (a.cpuSec || 0));

    res.json({ ok: true, services, other, processes, scannedAt: new Date().toISOString() });
  } catch (err) {
    res.json({ ok: false, error: err.message, services: [], other: [], processes: [] });
  }
});

app.post('/dashboard/api/processes/kill', async (req, res) => {
  const { pid } = req.body;
  if (!pid) return res.status(400).json({ ok: false, error: 'No PID' });
  // Protect PTY pids — never let dashboard kill a terminal session process
  const ptyPids = new Set(await getActivePtyPids());
  if (ptyPids.has(pid)) {
    return res.status(403).json({ ok: false, error: 'Cannot kill active PTY process — use session kill instead' });
  }
  try { process.kill(pid, 'SIGTERM'); res.json({ ok: true, killed: pid }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

// API for Android app / Pandant data
app.use('/api/v1', apiRouter);

// Device management
app.use('/api/v1/devices', devicesRouter);

// Sensor management API
app.use('/api/sensors', sensorsRouter);

// Project Runner — start/stop/monitor project services
app.use('/api/v1/runner', runnerRouter);

// Feature registry — maps feature names to Steward services for toggle API
// Import start/stop directly for the toggle endpoint (Steward handles boot, this handles runtime toggles)
import { startScout, stopScout, getFindings, updateFinding } from './scout.js';
import { startDream, stopDream } from './dream.js';
import { startClassifier, stopClassifier } from './classifier.js';
import { startAutoDev, stopAutoDev } from './autodev.js';
import { startStackScanner, stopStackScanner } from './stack-scanner.js';

const featureRegistry = {
  scout: { start: startScout, stop: stopScout, interval: '12h', defaultMs: 12 * 60 * 60 * 1000 },
  dream: { start: startDream, stop: stopDream, interval: '6h', defaultMs: 6 * 60 * 60 * 1000 },
  autodev: { start: startAutoDev, stop: stopAutoDev, interval: '1h', defaultMs: 60 * 60 * 1000 },
  evolution: { start: () => console.log('[PAN] Evolution enabled — runs after each dream cycle'), stop: () => console.log('[PAN] Evolution disabled'), interval: 'after-dream', defaultMs: 0 },
};

// GET /api/automation/status — current feature toggle states
app.get('/api/automation/status', (req, res) => {
  let toggles = {};
  try {
    const row = get("SELECT value FROM settings WHERE key = 'feature_toggles'");
    if (row) toggles = JSON.parse(row.value);
  } catch {}

  const features = {
    scout: { enabled: toggles.scout !== false, interval: '12h' },
    dream: { enabled: toggles.dream !== false, interval: '6h' },
    autodev: { enabled: toggles.autodev === true, interval: '1h' },
    evolution: { enabled: toggles.evolution === true, interval: 'after-dream' },
    classifier: { enabled: true, interval: '5m', required: true },
    project_sync: { enabled: true, interval: '10m', required: true },
  };
  res.json({ features });
});

// POST /api/automation/toggle — toggle a feature on/off
app.post('/api/automation/toggle', (req, res) => {
  const { feature, enabled } = req.body;
  if (!feature || !featureRegistry[feature]) {
    return res.status(400).json({ error: 'Invalid feature. Valid: ' + Object.keys(featureRegistry).join(', ') });
  }

  // Load current toggles
  let toggles = {};
  try {
    const row = get("SELECT value FROM settings WHERE key = 'feature_toggles'");
    if (row) toggles = JSON.parse(row.value);
  } catch {}

  toggles[feature] = !!enabled;
  run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('feature_toggles', :val, datetime('now','localtime'))", {
    ':val': JSON.stringify(toggles)
  });

  // Actually start/stop the feature
  const reg = featureRegistry[feature];
  if (enabled) {
    console.log(`[PAN] Starting ${feature}...`);
    reg.start(reg.defaultMs);
  } else {
    console.log(`[PAN] Stopping ${feature}...`);
    reg.stop();
  }

  res.json({ ok: true, feature, enabled: !!enabled });
});

// GET /api/automation/usage — AI usage stats
app.get('/api/automation/usage', (req, res) => {
  try {
    // Today
    const todayStats = get(`SELECT COALESCE(SUM(cost_cents), 0) as total_cost_cents, COUNT(*) as total_calls
      FROM ai_usage WHERE date(created_at) = date('now','localtime')`);
    const todayByCaller = all(`SELECT caller, COUNT(*) as calls, COALESCE(SUM(cost_cents), 0) as cost_cents,
      COALESCE(SUM(input_tokens), 0) as input_tokens, COALESCE(SUM(output_tokens), 0) as output_tokens
      FROM ai_usage WHERE date(created_at) = date('now','localtime') GROUP BY caller`);

    // This week
    const weekStats = get(`SELECT COALESCE(SUM(cost_cents), 0) as total_cost_cents, COUNT(*) as total_calls
      FROM ai_usage WHERE created_at >= datetime('now','localtime', '-7 days')`);
    const weekByCaller = all(`SELECT caller, COUNT(*) as calls, COALESCE(SUM(cost_cents), 0) as cost_cents
      FROM ai_usage WHERE created_at >= datetime('now','localtime', '-7 days') GROUP BY caller`);

    // All time
    const allTimeStats = get(`SELECT COALESCE(SUM(cost_cents), 0) as total_cost_cents, COUNT(*) as total_calls
      FROM ai_usage`);
    const allTimeByCaller = all(`SELECT caller, COUNT(*) as calls, COALESCE(SUM(cost_cents), 0) as cost_cents
      FROM ai_usage GROUP BY caller`);

    const toMap = (rows) => {
      const m = {};
      for (const r of rows) m[r.caller] = { calls: r.calls, cost_cents: r.cost_cents, input_tokens: r.input_tokens, output_tokens: r.output_tokens };
      return m;
    };

    res.json({
      today: { ...todayStats, by_caller: toMap(todayByCaller) },
      week: { ...weekStats, by_caller: toMap(weekByCaller) },
      all_time: { ...allTimeStats, by_caller: toMap(allTimeByCaller) },
    });
  } catch (e) {
    console.error('[PAN Usage] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== SCOUT ENDPOINTS ====================

// GET /dashboard/api/scout — list scout findings
app.get('/dashboard/api/scout', (req, res) => {
  try {
    const status = req.query.status || 'new';
    const limit = parseInt(req.query.limit) || 20;
    const findings = getFindings({ status, limit });
    res.json({ findings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /dashboard/api/scout/run — trigger a scout scan (does NOT enable the scout service)
app.post('/dashboard/api/scout/run', async (req, res) => {
  try {
    const { scout } = await import('./scout.js');
    await scout();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /dashboard/api/scout/:id — approve/dismiss a finding
app.patch('/dashboard/api/scout/:id', (req, res) => {
  try {
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status required' });
    updateFinding(parseInt(req.params.id), status);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v1/claude-usage — Claude Code session token usage from JSONL files
app.get('/api/v1/claude-usage', async (req, res) => {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const sessDir = join(homeDir, '.claude', 'sessions');
    const projBase = join(homeDir, '.claude', 'projects');

    // Read active sessions
    const sessionFiles = existsSync(sessDir) ? readdirSync(sessDir).filter(f => f.endsWith('.json')) : [];
    const sessions = sessionFiles.map(f => {
      try { return JSON.parse(readFileSync(join(sessDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);

    // Find JSONL files for sessions and sum tokens
    function sumJsonlTokens(filePath) {
      const result = { input: 0, output: 0, cache_read: 0, cache_create: 0, messages: 0, model: '' };
      try {
        const data = readFileSync(filePath, 'utf8');
        for (const line of data.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.message?.usage) {
              const u = msg.message.usage;
              result.input += u.input_tokens || 0;
              result.output += u.output_tokens || 0;
              result.cache_read += u.cache_read_input_tokens || 0;
              result.cache_create += u.cache_creation_input_tokens || 0;
              result.messages++;
            }
            if (msg.message?.model && !result.model) result.model = msg.message.model;
          } catch {}
        }
      } catch {}
      return result;
    }

    // Search project dirs for each session's JSONL
    const projectDirs = existsSync(projBase) ? readdirSync(projBase).filter(f => {
      try { return statSync(join(projBase, f)).isDirectory(); } catch { return false; }
    }) : [];

    const now = Date.now();
    const twoHours = 2 * 60 * 60 * 1000;
    const oneDay = 24 * 60 * 60 * 1000;
    const oneWeek = 7 * oneDay;

    let sessionTokens = { input: 0, output: 0, cache_read: 0, cache_create: 0, messages: 0 };
    let todayTokens = { input: 0, output: 0, cache_read: 0, cache_create: 0, messages: 0 };
    let weekTokens = { input: 0, output: 0, cache_read: 0, cache_create: 0, messages: 0 };
    let model = '';
    let activeSessions = 0;
    let currentSessionStart = null;

    // Process all JSONL files from all projects
    for (const pd of projectDirs) {
      const pdPath = join(projBase, pd);
      const jsonlFiles = readdirSync(pdPath).filter(f => f.endsWith('.jsonl'));

      for (const jf of jsonlFiles) {
        const sessionId = jf.replace('.jsonl', '');
        const session = sessions.find(s => s.sessionId === sessionId);
        const filePath = join(pdPath, jf);
        const stat = statSync(filePath);
        const fileAge = now - stat.mtimeMs;

        // Current session (matches active session files)
        if (session) {
          activeSessions++;
          const tokens = sumJsonlTokens(filePath);
          if (tokens.model) model = tokens.model;

          // This is an active session — count its tokens
          sessionTokens.input += tokens.input;
          sessionTokens.output += tokens.output;
          sessionTokens.cache_read += tokens.cache_read;
          sessionTokens.cache_create += tokens.cache_create;
          sessionTokens.messages += tokens.messages;
          if (!currentSessionStart || (session.startedAt && session.startedAt < currentSessionStart)) {
            currentSessionStart = session.startedAt;
          }
        }

        // Today's tokens (modified today)
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        if (stat.mtimeMs >= todayStart.getTime()) {
          const tokens = session ? { ...sessionTokens } : sumJsonlTokens(filePath);
          if (!session) {
            todayTokens.input += tokens.input;
            todayTokens.output += tokens.output;
            todayTokens.cache_read += tokens.cache_read;
            todayTokens.cache_create += tokens.cache_create;
            todayTokens.messages += tokens.messages;
          }
        }

        // Week tokens
        if (fileAge < oneWeek) {
          if (!session) {
            const tokens = sumJsonlTokens(filePath);
            weekTokens.input += tokens.input;
            weekTokens.output += tokens.output;
            weekTokens.cache_read += tokens.cache_read;
            weekTokens.cache_create += tokens.cache_create;
            weekTokens.messages += tokens.messages;
          }
        }
      }
    }

    // Add session tokens to today and week
    todayTokens.input += sessionTokens.input;
    todayTokens.output += sessionTokens.output;
    todayTokens.cache_read += sessionTokens.cache_read;
    todayTokens.cache_create += sessionTokens.cache_create;
    todayTokens.messages += sessionTokens.messages;
    weekTokens.input += todayTokens.input;
    weekTokens.output += todayTokens.output;
    weekTokens.cache_read += todayTokens.cache_read;
    weekTokens.cache_create += todayTokens.cache_create;
    weekTokens.messages += todayTokens.messages;

    // Fetch real rate limit data by making a tiny Haiku call and reading response headers
    // The /api/oauth/usage endpoint rate-limits aggressively, but every Anthropic API
    // response includes rate limit headers (anthropic-ratelimit-unified-*)
    let rateLimits = null;
    try {
      const credsPath = join(homeDir, '.claude', '.credentials.json');
      if (existsSync(credsPath)) {
        const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
        const token = creds.claudeAiOauth?.accessToken;
        const subType = creds.claudeAiOauth?.subscriptionType || 'unknown';
        const tier = creds.claudeAiOauth?.rateLimitTier || 'unknown';
        if (token) {
          const body = JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          });
          const rlData = await new Promise((resolve) => {
            const req = https.request('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'x-api-key': token,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(body),
              },
              timeout: 15000,
            }, (resp) => {
              const headers = {};
              for (const [k, v] of Object.entries(resp.headers)) {
                if (k.toLowerCase().includes('ratelimit')) headers[k] = v;
              }
              // Drain the response body
              resp.on('data', () => {});
              resp.on('end', () => resolve(headers));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
          });
          if (rlData) {
            const h = rlData;
            rateLimits = {
              subscriptionType: subType,
              rateLimitTier: tier,
              status: h['anthropic-ratelimit-unified-status'] || 'unknown',
            };
            // 5-hour session window
            if (h['anthropic-ratelimit-unified-5h-utilization']) {
              rateLimits.five_hour = {
                utilization: parseFloat(h['anthropic-ratelimit-unified-5h-utilization']) * 100,
                resets_at: h['anthropic-ratelimit-unified-5h-reset'] ? parseInt(h['anthropic-ratelimit-unified-5h-reset']) * 1000 : null,
                status: h['anthropic-ratelimit-unified-5h-status'] || 'unknown',
              };
            }
            // 7-day weekly
            if (h['anthropic-ratelimit-unified-7d-utilization']) {
              rateLimits.seven_day = {
                utilization: parseFloat(h['anthropic-ratelimit-unified-7d-utilization']) * 100,
                resets_at: h['anthropic-ratelimit-unified-7d-reset'] ? parseInt(h['anthropic-ratelimit-unified-7d-reset']) * 1000 : null,
                status: h['anthropic-ratelimit-unified-7d-status'] || 'unknown',
              };
            }
            // Overage / extra usage
            if (h['anthropic-ratelimit-unified-overage-utilization']) {
              rateLimits.extra_usage = {
                utilization: parseFloat(h['anthropic-ratelimit-unified-overage-utilization']) * 100,
                resets_at: h['anthropic-ratelimit-unified-overage-reset'] ? parseInt(h['anthropic-ratelimit-unified-overage-reset']) * 1000 : null,
                status: h['anthropic-ratelimit-unified-overage-status'] || 'unknown',
              };
            }
          }
        }
      }
    } catch (rlErr) {
      console.error('[Claude Usage] Rate limit fetch error:', rlErr.message);
    }

    res.json({
      session: {
        ...sessionTokens,
        total: sessionTokens.input + sessionTokens.output + sessionTokens.cache_read + sessionTokens.cache_create,
        startedAt: currentSessionStart,
        activeSessions,
      },
      today: {
        ...todayTokens,
        total: todayTokens.input + todayTokens.output + todayTokens.cache_read + todayTokens.cache_create,
      },
      week: {
        ...weekTokens,
        total: weekTokens.input + weekTokens.output + weekTokens.cache_read + weekTokens.cache_create,
      },
      model: model || 'unknown',
      rateLimits,
    });
  } catch (e) {
    console.error('[Claude Usage] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v1/settings — read all PAN settings (for mobile sync + dashboard)
app.get('/api/v1/settings', (req, res) => {
  try {
    const rows = all("SELECT key, value FROM settings");
    const settings = {};
    for (const r of rows) {
      try { settings[r.key] = JSON.parse(r.value); } catch { settings[r.key] = r.value; }
    }
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/v1/settings — update settings (partial merge — only keys sent are updated)
app.put('/api/v1/settings', (req, res) => {
  try {
    const updates = req.body;
    const keys = Object.keys(updates);
    for (const [key, value] of Object.entries(updates)) {
      const valStr = typeof value === 'string' ? value : JSON.stringify(value);
      run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (:key, :val, datetime('now','localtime'))", {
        ':key': key, ':val': valStr
      });
    }
    console.log(`[PAN Settings] Updated: ${keys.join(', ')} (from ${req.headers['x-device-name'] || req.ip})`);
    // Return the saved values so clients can confirm the write succeeded
    const saved = {};
    for (const key of keys) {
      const row = get("SELECT value FROM settings WHERE key = :k", { ':k': key });
      if (row) { try { saved[key] = JSON.parse(row.value); } catch { saved[key] = row.value; } }
    }
    res.json({ ok: true, saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== TTS / Voice Profiles ====================
// Lazy-load TTS module (heavy imports, only load when needed)
let ttsModule = null;
async function getTTS() {
  if (!ttsModule) ttsModule = await import('./tts.js');
  return ttsModule;
}

// List voice profiles
app.get('/api/v1/voice/profiles', async (req, res) => {
  try {
    const tts = await getTTS();
    res.json({ profiles: tts.listVoiceProfiles() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload reference audio for a voice profile
app.post('/api/v1/voice/profile/:name', async (req, res) => {
  try {
    const tts = await getTTS();
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 1000) return res.status(400).json({ error: 'Audio too short (need 10-15 seconds)' });
      tts.saveReference(req.params.name, buf);
      res.json({ ok: true, voice: req.params.name, bytes: buf.length });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Synthesize speech (returns WAV audio)
app.post('/api/v1/voice/speak', async (req, res) => {
  try {
    const tts = await getTTS();
    const { text, voice } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    if (!voice) return res.status(400).json({ error: 'voice required' });

    const result = await tts.synthesize(text, voice);
    res.set('Content-Type', 'audio/wav');
    res.set('X-TTS-Cached', result.cached ? '1' : '0');
    tts.streamWav(result.path).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pre-generate common phrases for a voice (background task)
app.post('/api/v1/voice/pregenerate/:name', async (req, res) => {
  try {
    const tts = await getTTS();
    if (!tts.hasVoiceProfile(req.params.name)) {
      return res.status(404).json({ error: `Voice "${req.params.name}" has no reference audio` });
    }
    res.json({ ok: true, message: `Pre-generating phrases for "${req.params.name}"...` });
    // Run in background — don't block the response
    tts.pregenerate(req.params.name, (progress) => {
      console.log(`[TTS] ${req.params.name}: ${progress.done}/${progress.total} phrases (${progress.errors} errors)`);
    }).then(r => {
      console.log(`[TTS] Pre-generation complete for "${req.params.name}": ${r.done}/${r.total} (${r.errors} errors)`);
    }).catch(e => {
      console.error(`[TTS] Pre-generation failed for "${req.params.name}": ${e.message}`);
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Download voice pack (reference + cached phrases as ZIP)
app.get('/api/v1/voice/pack/:name', async (req, res) => {
  try {
    const tts = await getTTS();
    if (!tts.hasVoiceProfile(req.params.name)) {
      return res.status(404).json({ error: `Voice "${req.params.name}" not found` });
    }
    // For now just return profile info — ZIP packaging is a TODO
    const profiles = tts.listVoiceProfiles();
    const profile = profiles.find(p => p.name === req.params.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_'));
    res.json({ profile: profile || null, downloadUrl: 'TODO: ZIP packaging' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dashboard (web UI + API)
app.use('/dashboard', dashboardRouter);

// Redirect /dashboard/ to /v2/ (Svelte dashboard)
app.get('/dashboard', (req, res) => res.redirect('/v2/'));
app.get('/dashboard/', (req, res) => res.redirect('/v2/'));

// Svelte v2 dashboard — static files
app.use('/v2', express.static(join(__dirname, '..', 'public', 'v2'), {
  etag: false,
  lastModified: true,
  index: 'index.html',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
  }
}));
// SPA fallback — any /v2/* that isn't a file gets index.html
app.get('/v2/*path', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(join(__dirname, '..', 'public', 'v2', 'index.html'));
});

// Mobile dashboard — static files, no ES modules, no caching
app.use('/mobile', express.static(join(__dirname, '..', 'public', 'mobile'), {
  etag: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

// Legacy inline mobile route (removed — now static)
app.get('/mobile-old/', (req, res) => { res.redirect('/mobile/'); });
/*
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>PAN Mobile</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0a0f; color:#cdd6f4; font-family:-apple-system,system-ui,sans-serif; font-size:14px; }
  .tabs { display:flex; border-bottom:1px solid #313244; overflow-x:auto; position:sticky; top:0; background:#0a0a0f; z-index:10; }
  .tab { padding:10px 14px; color:#6c7086; cursor:pointer; white-space:nowrap; border-bottom:2px solid transparent; font-size:13px; }
  .tab.active { color:#89b4fa; border-bottom-color:#89b4fa; }
  .page { display:none; padding:12px; }
  .page.active { display:flex; flex-direction:column; gap:8px; }
  select { width:100%; background:#1e1e2e; color:#cdd6f4; border:1px solid #313244; border-radius:8px; padding:10px 12px; font-size:14px; margin-bottom:8px; }
  .chat-area { flex:1; display:flex; flex-direction:column; min-height:60vh; }
  .messages { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:6px; padding:8px 0; }
  .msg-user { background:#89b4fa; color:#000; border-radius:14px 14px 4px 14px; padding:8px 12px; align-self:flex-end; max-width:80%; }
  .msg-pan { background:#1e1e2e; border-radius:14px 14px 14px 4px; padding:8px 12px; align-self:flex-start; max-width:80%; }
  .input-bar { display:flex; gap:8px; padding:8px 0; position:sticky; bottom:0; background:#0a0a0f; }
  .input-bar input { flex:1; background:#1e1e2e; color:#cdd6f4; border:1px solid #313244; border-radius:8px; padding:10px 12px; font-size:14px; outline:none; }
  .input-bar button { background:#89b4fa; color:#000; border:none; border-radius:8px; padding:10px 16px; font-weight:600; }
  .card { background:#1e1e2e; border:1px solid #313244; border-radius:8px; padding:12px; }
  .stat { font-size:20px; font-weight:600; color:#89b4fa; }
  .label { font-size:11px; color:#6c7086; text-transform:uppercase; letter-spacing:0.5px; }
  .sensor-row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #181825; }
  h3 { font-size:15px; color:#cdd6f4; margin-bottom:8px; }
  .muted { color:#6c7086; text-align:center; padding:20px; }
</style>
</head>
<body>
<div class="tabs">
  <div class="tab active" onclick="switchTab('chat')">Chat</div>
  <div class="tab" onclick="switchTab('terminal')">Terminal</div>
  <div class="tab" onclick="switchTab('projects')">Projects</div>
  <div class="tab" onclick="switchTab('sensors')">Sensors</div>
  <div class="tab" onclick="switchTab('data')">Data</div>
  <div class="tab" onclick="switchTab('settings')">Settings</div>
</div>

<div id="chat" class="page active">
  <select id="project-select" onchange="loadChat()">
    <option value="">Select project...</option>
  </select>
  <div class="chat-area">
    <div class="messages" id="chat-messages"><div class="muted">Select a project</div></div>
    <div class="input-bar">
      <input id="chat-input" placeholder="Message PAN..." onkeydown="if(event.key==='Enter')sendMsg()">
      <button onclick="sendMsg()">Send</button>
    </div>
  </div>
</div>

<div id="terminal" class="page">
  <select id="term-project-select" onchange="loadTerminal()">
    <option value="">Select project...</option>
  </select>
  <div class="card"><div class="muted">Terminal view — select a project</div></div>
</div>

<div id="projects" class="page">
  <div id="projects-list"><div class="muted">Loading...</div></div>
</div>

<div id="sensors" class="page">
  <div id="sensors-list"><div class="muted">Loading...</div></div>
</div>

<div id="data" class="page">
  <div id="stats-cards" style="display:grid;grid-template-columns:1fr 1fr;gap:8px"></div>
  <div id="recent-events" style="margin-top:12px"><div class="muted">Loading...</div></div>
</div>

<div id="settings" class="page">
  <div class="card"><div class="muted">Settings available on desktop dashboard</div></div>
</div>

<script>
const API = window.location.origin;
let projects = [];

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelector('.tab[onclick*="'+name+'"]').classList.add('active');
  document.getElementById(name).classList.add('active');
  if (name === 'projects') loadProjects();
  if (name === 'sensors') loadSensors();
  if (name === 'data') loadData();
}

async function loadProjectSelects() {
  try {
    const res = await fetch(API + '/dashboard/api/projects');
    projects = await res.json();
    ['project-select','term-project-select'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '<option value="">Select project...</option>';
      projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
      // Auto-select PAN
      const pan = projects.find(p => p.name === 'PAN');
      if (pan) { sel.value = pan.path; }
    });
    loadChat();
  } catch(e) { console.error('Projects:', e); }
}

async function loadChat() {
  const msgs = document.getElementById('chat-messages');
  try {
    const res = await fetch(API + '/dashboard/api/events?limit=30&event_type=RouterCommand');
    const data = await res.json();
    const events = (data.events || []).reverse();
    if (!events.length) { msgs.innerHTML = '<div class="muted">No conversations yet</div>'; return; }
    msgs.innerHTML = '';
    events.forEach(e => {
      try {
        const d = JSON.parse(e.data);
        const text = d.text || d.query || '';
        const resp = d.result || d.response || '';
        if (text) { const div = document.createElement('div'); div.className='msg-user'; div.textContent=text; msgs.appendChild(div); }
        if (resp && resp !== '[AMBIENT]') { const div = document.createElement('div'); div.className='msg-pan'; div.textContent=resp; msgs.appendChild(div); }
      } catch {}
    });
    msgs.scrollTop = msgs.scrollHeight;
  } catch(e) { msgs.innerHTML = '<div class="muted">Error: '+e.message+'</div>'; }
}

async function sendMsg() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const msgs = document.getElementById('chat-messages');
  const div = document.createElement('div'); div.className='msg-user'; div.textContent=text; msgs.appendChild(div);
  const typing = document.createElement('div'); typing.className='msg-pan'; typing.textContent='...'; msgs.appendChild(typing);
  msgs.scrollTop = msgs.scrollHeight;
  try {
    const res = await fetch(API + '/api/v1/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message:text,source:'dashboard'}) });
    const data = await res.json();
    typing.textContent = data.response || data.result || 'No response';
  } catch(e) { typing.textContent = 'Error: ' + e.message; }
  msgs.scrollTop = msgs.scrollHeight;
}

async function loadProjects() {
  const el = document.getElementById('projects-list');
  try {
    const res = await fetch(API + '/dashboard/api/projects');
    const data = await res.json();
    el.innerHTML = data.map(p => '<div class="card" style="margin-bottom:8px"><h3>'+p.name+'</h3><div style="font-size:12px;color:#6c7086">'+p.path+'</div><div style="font-size:12px;color:#a6adc8;margin-top:4px">'+(p.description||'')+'</div></div>').join('');
  } catch(e) { el.innerHTML = '<div class="muted">Error: '+e.message+'</div>'; }
}

async function loadSensors() {
  const el = document.getElementById('sensors-list');
  try {
    const res = await fetch(API + '/api/sensors/devices/latest');
    const data = await res.json();
    if (!data || !Object.keys(data).length) { el.innerHTML = '<div class="muted">No sensor data</div>'; return; }
    el.innerHTML = Object.entries(data).map(([k,v]) => '<div class="sensor-row"><span>'+k+'</span><span style="color:#89b4fa">'+JSON.stringify(v)+'</span></div>').join('');
  } catch(e) {
    // Fallback to device sensors
    try {
      const res2 = await fetch(API + '/api/sensors/devices/9');
      const d2 = await res2.json();
      el.innerHTML = (d2.assignments||[]).map(s => '<div class="sensor-row"><span>'+s.sensor_key+'</span><span style="color:#89b4fa">'+(s.enabled?'ON':'OFF')+'</span></div>').join('') || '<div class="muted">No sensors configured</div>';
    } catch { el.innerHTML = '<div class="muted">Sensors unavailable</div>'; }
  }
}

async function loadData() {
  try {
    const res = await fetch(API + '/dashboard/api/stats');
    const s = await res.json();
    document.getElementById('stats-cards').innerHTML =
      '<div class="card"><div class="stat">'+s.total_events+'</div><div class="label">Events</div></div>'+
      '<div class="card"><div class="stat">'+s.total_sessions+'</div><div class="label">Sessions</div></div>'+
      '<div class="card"><div class="stat">'+s.total_projects+'</div><div class="label">Projects</div></div>'+
      '<div class="card"><div class="stat">'+s.total_devices+'</div><div class="label">Devices</div></div>';
  } catch {}
  try {
    const res = await fetch(API + '/dashboard/api/events?limit=10');
    const data = await res.json();
    document.getElementById('recent-events').innerHTML = '<h3>Recent Events</h3>' +
      (data.events||[]).map(e => '<div class="sensor-row"><span style="font-size:11px">'+e.event_type+'</span><span style="font-size:11px;color:#6c7086">'+e.created_at.slice(11,19)+'</span></div>').join('');
  } catch {}
}

// Auto-refresh chat every 5 seconds
setInterval(loadChat, 5000);

// Init
loadProjectSelects();
</script>
</body>
</html>`);
});

*/

// Old dashboard static files (fallback)
app.use('/dashboard', express.static(join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Auth check — returns current user (used by SvelteKit dashboard layout)
app.get('/auth/me', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1') || ip === '::ffff:127.0.0.1';
  const isTailscale = ip.startsWith('100.') || ip.startsWith('::ffff:100.');
  if (isLocalhost || isTailscale) {
    res.json({ authenticated: true, user: { id: 1, email: 'owner@localhost', display_name: 'Owner', role: 'owner' } });
  } else if (req.user) {
    res.json({ authenticated: true, user: req.user });
  } else {
    res.json({ authenticated: false });
  }
});

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

// Dev instance — detect running dev server (dev-server.js on 7781 or Vite on 5173+)
app.post('/api/v1/dev/start', async (req, res) => {
  const DEV_PORT = 7781;
  // Check if already running
  for (const port of [DEV_PORT, 5173, 5174, 5175, 5180, 5181, 5190]) {
    try {
      const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return res.json({ ok: true, port, running: true });
    } catch {}
    if (port !== DEV_PORT) {
      try {
        const r = await fetch(`http://localhost:${port}/v2/`, { signal: AbortSignal.timeout(500) });
        if (r.ok) return res.json({ ok: true, port, running: true });
      } catch {}
    }
  }
  // Not running — launch it
  try {
    const { spawn } = await import('child_process');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    const serviceDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const devServerPath = join(serviceDir, 'dev-server.js');
    const child = spawn('node', [devServerPath], {
      cwd: serviceDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    });
    child.unref();
    // Wait for it to come up (poll for up to 10 seconds)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const r = await fetch(`http://localhost:${DEV_PORT}/health`, { signal: AbortSignal.timeout(500) });
        if (r.ok) return res.json({ ok: true, port: DEV_PORT, running: true, started: true });
      } catch {}
    }
    res.json({ ok: false, error: 'Dev server launched but not responding yet — try again in a few seconds' });
  } catch (err) {
    res.json({ ok: false, error: 'Failed to start dev server: ' + err.message });
  }
});

// Dev restart — kill existing dev server and start fresh
app.post('/api/v1/dev/restart', async (req, res) => {
  const DEV_PORT = 7781;
  const { spawn } = await import('child_process');
  const { killProcessOnPort } = await import('./platform.js');

  // Kill existing dev server
  const killed = await killProcessOnPort(DEV_PORT);
  if (killed.size > 0) await new Promise(r => setTimeout(r, 2000));

  // Start new dev server
  try {
    const serviceDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const child = spawn('node', [join(serviceDir, 'dev-server.js')], {
      cwd: serviceDir, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env },
    });
    child.unref();

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const r = await fetch(`http://localhost:${DEV_PORT}/health`, { signal: AbortSignal.timeout(500) });
        if (r.ok) return res.json({ ok: true, port: DEV_PORT, restarted: true });
      } catch {}
    }
    res.json({ ok: false, error: 'Dev server launched but not responding yet' });
  } catch (err) {
    res.json({ ok: false, error: 'Failed to restart dev server: ' + err.message });
  }
});

// Dev proxy — forwards test API calls to dev server (avoids CORS issues with browser-to-dev)
app.all('/api/v1/dev/proxy/*proxyPath', async (req, res) => {
  const devPort = 7781;
  const targetPath = Array.isArray(req.params.proxyPath) ? req.params.proxyPath.join('/') : req.params.proxyPath; // Express 5 returns array for wildcard params
  const url = `http://127.0.0.1:${devPort}/${targetPath}`;
  try {
    const opts = { method: req.method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000) };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      opts.body = JSON.stringify(req.body);
    }
    const r = await fetch(url, opts);
    const text = await r.text();
    res.status(r.status).type('json').send(text);
  } catch (err) {
    res.status(502).json({ ok: false, error: `Dev server proxy failed: ${err.message}` });
  }
});

// Terminal API — list sessions, projects for terminal
app.get('/api/v1/terminal/sessions', async (req, res) => {
  res.json({ sessions: await listSessions() });
});
app.get('/api/v1/terminal/projects', (req, res) => {
  res.json({ projects: getTerminalProjects() });
});
app.delete('/api/v1/terminal/sessions/:id', (req, res) => {
  const killed = killSession(req.params.id);
  res.json({ ok: killed });
});

// Process registry — all PIDs spawned by PAN (PTY, Claude CLI, agent-sdk)
app.get('/api/v1/processes', async (req, res) => {
  const processes = await getProcessRegistry();
  const alive = processes.filter(p => p.alive);
  const dead = processes.filter(p => !p.alive);
  res.json({ processes, summary: { total: processes.length, alive: alive.length, dead: dead.length } });
});

// Permission prompts — mobile polls this to show Allow/Deny buttons
app.get('/api/v1/terminal/permissions', (req, res) => {
  res.json({ permissions: getPendingPermissions() });
});
app.delete('/api/v1/terminal/permissions/:id', (req, res) => {
  clearPermission(parseInt(req.params.id));
  res.json({ ok: true });
});
// Send text to active terminal (phone voice commands → terminal, or
// the desktop dashboard's own input — same endpoint, different source).
// Falls back to pipe mode if PTY send fails (mobile dashboard uses pipe mode now).
app.post('/api/v1/terminal/send', async (req, res) => {
  const { text, session_id, raw, source: bodySource } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  // Try pipe mode first — resolves session ID prefix matches (e.g. dash-pan → dash-pan-1)
  let resolvedSessionId = session_id || null;
  if (resolvedSessionId) {
    const sessions = await listSessions();
    const exact = sessions.find(s => s.id === resolvedSessionId);
    if (!exact) {
      const prefix = sessions.find(s => s.id.startsWith(resolvedSessionId));
      if (prefix) resolvedSessionId = prefix.id;
    }
  }
  const piped = await pipeSend(resolvedSessionId, text);
  if (piped) {
    console.log(`[PAN Send] Routed to pipe mode: "${text.substring(0, 60)}" → ${resolvedSessionId}`);
    return res.json({ ok: true, session: resolvedSessionId, method: 'pipe' });
  }

  // Fallback: raw PTY write (legacy)
  const toSend = raw ? text : text + '\r';
  const sent = sendToSession(session_id || null, toSend);

  // Immediate echo — broadcast user message to all WS clients for this session
  // so it appears in the transcript instantly, without waiting for Claude Code
  // to write it to the JSONL file (which can take seconds if Claude is busy).
  // The transcript watcher's dedup will handle the overlap when JSONL catches up.
  // Echo when: non-raw sends (legacy), OR raw sends that contain actual text
  // (not just control chars like \r). The dashboard splits sends into text+\r,
  // both with raw:true, so we need to echo the text part.
  const echoText = (text || '').trim();
  if (sent && echoText && !/^[\r\n\x03\x1b]/.test(echoText)) {
    broadcastToSession(session_id || null, 'user_echo', {
      text: echoText,
      ts: new Date().toISOString(),
    });
  }

  // Derive the real client source. Priority:
  //   1) explicit body.source (caller knows best)
  //   2) X-PAN-Source header
  //   3) User-Agent sniff (Electron/Chrome on desktop vs Android/Mobile)
  //   4) fallback to 'unknown'
  // The old code hardcoded everything to 'mobile_dashboard' / 'MobileSend',
  // which made the desktop terminal lie about itself in the event log.
  const ua = String(req.headers['user-agent'] || '');
  const headerSource = req.headers['x-pan-source'];
  let source = bodySource || headerSource;
  if (!source) {
    if (/Electron/i.test(ua)) source = 'desktop_electron';
    else if (/Android|iPhone|Mobile/i.test(ua)) source = 'mobile';
    else if (/Mozilla/i.test(ua)) source = 'desktop_browser';
    else source = 'unknown';
  }
  const isMobile = /mobile/i.test(source);
  const eventType = isMobile ? 'MobileSend' : 'DesktopSend';
  console.log(`[PAN Send] (${source}) "${String(text).substring(0,60)}" → ${session_id || 'auto'} (raw=${!!raw}, sent=${sent})`);

  // Log as event with the REAL source so the event log shows where it came from
  const dataStr = JSON.stringify({
    text, session_id: session_id || 'auto', sent, raw: !!raw,
    source, user_agent: ua.substring(0, 120), timestamp: Date.now()
  });
  const eventId = insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
    ':sid': session_id || (isMobile ? 'mobile-send' : 'desktop-send'), ':type': eventType, ':data': dataStr
  });
  indexEventFTS(eventId, eventType, dataStr);

  const sessInfo = await listSessions();
  res.json({ ok: sent, session: session_id || 'auto', active_sessions: sessInfo.map(s => s.id + '(' + s.clients + ')') });
});

// Get transcript messages for a session (fallback for page load when WebSocket push hasn't arrived)
app.get('/api/v1/terminal/messages/:session_id', async (req, res) => {
  try {
    const messages = await getSessionMessages(req.params.session_id);
    res.json({ ok: true, messages: messages || [] });
  } catch (err) {
    res.json({ ok: false, messages: [], error: err.message });
  }
});

// HTTP interrupt fallback — for when WebSocket is dead but user presses Escape
app.post('/api/v1/terminal/interrupt', (req, res) => {
  const sessionId = req.query.session || req.body?.session_id;
  if (sessionId) {
    const ok = pipeInterrupt(sessionId);
    res.json({ ok, session: sessionId });
  } else {
    // No session specified — interrupt all active sessions
    const sessions = listSessions();
    let interrupted = 0;
    for (const s of sessions) {
      if (s.claudeRunning) {
        pipeInterrupt(s.id);
        interrupted++;
      }
    }
    res.json({ ok: true, interrupted });
  }
});

// PIPE MODE: send user message to a terminal session via pipe_send.
// Spawns claude -p as a child process, returns clean JSON responses.
app.post('/api/v1/terminal/pipe', async (req, res) => {
  const { text, session_id } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  console.log(`[PAN Pipe] POST /pipe session_id=${session_id} text=${(text||'').slice(0,50)} ip=${ip} user=${req.user?.email || 'NONE'}`);
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  const ok = await pipeSend(session_id, text);
  console.log(`[PAN Pipe] pipeSend result: ok=${ok} session=${session_id}`);
  res.json({ ok: !!ok, session: session_id });
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

// ==================== Test Runner API ====================
import { runTests, getTestStatus, resumeRestartTest, cancelTests } from './routes/tests.js';

// Storage for external test results (from test-restart.js and other external scripts)
let externalResults = [];

app.get('/api/v1/tests', (req, res) => {
  const status = getTestStatus();
  // Merge external results into the response
  if (externalResults.length > 0) {
    status.externalResults = externalResults;
  }
  res.json(status);
});

app.post('/api/v1/tests/run', async (req, res) => {
  const { suite } = req.body || {};
  const result = await runTests(suite || 'all');
  res.json(result);
});

app.post('/api/v1/tests/cancel', (req, res) => {
  const cancelled = cancelTests();
  res.json({ ok: cancelled, message: cancelled ? 'Tests cancelled' : 'No tests running' });
});

// Accept results from external test scripts (like test-restart.js)
app.post('/api/v1/tests/external-result', (req, res) => {
  const { suite, results, summary } = req.body || {};
  if (!suite || !results) return res.status(400).json({ error: 'suite and results required' });
  externalResults.unshift({
    suite,
    results,
    summary,
    receivedAt: new Date().toISOString(),
  });
  // Keep last 10 external results
  if (externalResults.length > 10) externalResults.length = 10;
  console.log(`[PAN Tests] External result received: ${suite} — ${summary?.passed || 0} passed, ${summary?.failed || 0} failed`);
  res.json({ ok: true });
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
// Atlas — service graph data from Steward registry
app.get('/api/v1/atlas/services', (req, res) => {
  res.json(getAtlasData());
});

// Hybrid memory search — FTS5 (lexical) + sqlite-vec (semantic) fused with
// reciprocal rank fusion. Multi-tenant via the `scope` query param.
//
// Usage:
//   GET /api/v1/memory/search?q=onedrive%20removal&scope=main&limit=20
app.get('/api/v1/memory/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const scope = String(req.query.scope || 'main');
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  if (!q) return res.status(400).json({ error: 'q (query) required' });
  try {
    const results = await searchMemory(q, { scope, limit });
    res.json({ scope, q, count: results.length, results });
  } catch (err) {
    console.error('[PAN MemorySearch] endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List registered DB scopes (for debugging / Atlas surfacing).
app.get('/api/v1/memory/scopes', (req, res) => {
  res.json({ scopes: listScopes() });
});

// Tier 0 Phase 4: org policy lookup for the phone.
// Returns the active org's policy fields so the phone can grey out toggles
// (incognito, blackout) when the org disallows them.
app.get('/api/v1/org/policy', async (req, res) => {
  try {
    const { getActiveOrg } = await import('./org-policy.js');
    const org = getActiveOrg(req);
    res.json({
      org_id: org.id,
      org_slug: org.slug,
      org_name: org.name,
      incognito_allowed: org.policy_incognito_allowed !== 0,
      blackout_allowed: org.policy_blackout_allowed !== 0,
      data_retention_days: org.policy_data_retention_days,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wipe a non-main scope (close + delete its SQLCipher file). Used by the
// phone when toggling incognito OFF — true "forget everything" semantics.
// Refuses to wipe `main`.
//
// Tier 0 Phase 4: writes an audit log entry when a non-personal org wipes
// a scope. Personal mode is intentionally NOT audited (the user owns it
// and the whole point of personal incognito is privacy).
app.post('/api/v1/memory/scope/:scope/wipe', async (req, res) => {
  const scope = String(req.params.scope || '').trim();
  if (!scope || scope === 'main') return res.status(400).json({ error: 'cannot wipe main' });
  if (!/^[a-z0-9-]{1,32}$/.test(scope)) return res.status(400).json({ error: 'invalid scope name' });
  try {
    const result = wipeScope(scope);

    // Audit only when in an org context. Personal mode = no audit (privacy).
    try {
      const { getActiveOrg } = await import('./org-policy.js');
      const org = getActiveOrg(req);
      if (org.id !== 'org_personal') {
        const { auditLog } = await import('./middleware/org-context.js');
        // Synthesize the minimum req shape auditLog expects
        const auditReq = { user: { id: req.user?.id || 1 }, org_id: org.id };
        auditLog(auditReq, 'incognito.wipe', scope, { wiped_path: result.path });
      }
    } catch (auditErr) {
      console.warn('[scope/wipe] audit failed:', auditErr.message);
    }

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/atlas/service/:id', (req, res) => {
  const svc = getServiceStatus(req.params.id);
  if (!svc) return res.status(404).json({ error: 'Service not found' });
  res.json(svc);
});

// Inject context into CLAUDE.md — called by frontend before launching Claude
app.post('/api/v1/inject-context', async (req, res) => {
  const { cwd } = req.body || {};
  if (!cwd) return res.status(400).json({ error: 'cwd required' });
  try {
    injectSessionContext(cwd);
    res.json({ ok: true, message: 'Context injected into CLAUDE.md' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/context-briefing', async (req, res) => {
  const projectPath = req.query.project_path || '';
  const tabSessionIds = req.query.session_ids ? req.query.session_ids.split(',').filter(Boolean) : [];

  // 1. Read the living state document (maintained by dream cycle)
  const stateFile = join(process.cwd(), '.pan-state.md');
  let stateDoc = '';
  try {
    if (existsSync(stateFile)) stateDoc = readFileSync(stateFile, 'utf8');
  } catch {}

  // 2. Recent conversation — scoped to tab's session IDs if available, else project path
  let recentChat = [];
  if (tabSessionIds.length > 0) {
    // Tab-specific transcript: only load conversation from this tab's Claude sessions
    const params = {};
    const placeholders = tabSessionIds.map((id, i) => { params[`:ts${i}`] = id; return `:ts${i}`; }).join(',');
    recentChat = all(
      `SELECT event_type, data, created_at FROM events
       WHERE event_type IN ('UserPromptSubmit', 'Stop', 'AssistantMessage')
       AND session_id IN (${placeholders})
       ORDER BY created_at DESC LIMIT 30`,
      params
    );
  } else if (projectPath) {
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

  // 5. Vector memory context — semantic facts, episodic memories, procedures
  let memorySection = '';
  try {
    const memResult = await buildMemoryContext('session context', { tokenBudget: 8000 });
    if (memResult.context) {
      memorySection = memResult.context;
      console.log(`[PAN Briefing] Memory context: ${memResult.stats.facts} facts, ${memResult.stats.episodes} episodes, ${memResult.stats.procedures} procedures`);
    }
  } catch (err) {
    console.error('[PAN Briefing] Memory context failed:', err.message);
  }

  // 6. Build briefing
  let briefing = '=== PAN SESSION CONTEXT BRIEFING ===\n\n';

  // Environment context first — so Claude knows the tools before anything else
  briefing += projectBrief + '\n';

  // State doc is the primary context source
  if (stateDoc) {
    briefing += stateDoc + '\n\n';
  }

  // Vector memory — accumulated knowledge from past sessions
  if (memorySection) {
    briefing += memorySection + '\n\n';
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

// Voice trigger — mouse button actions routed from dashboard JS
// action: "winh" (Win+H system voice) or "dictate" (PAN whisper)
app.post('/api/v1/voice/trigger', async (req, res) => {
  const { action } = req.body || {};
  console.log(`[PAN Voice] trigger: ${action}`);
  if (action === 'winh') {
    // Send Win+H via Tauri shell
    try {
      await fetch('http://127.0.0.1:7790/winh', { method: 'POST', signal: AbortSignal.timeout(2000) });
      res.json({ ok: true, action: 'winh' });
    } catch {
      // Fallback: PowerShell keybd_event if Tauri is down
      const { exec } = await import('child_process');
      exec('powershell -NoProfile -Command "Add-Type -MemberDefinition \'[DllImport(\\\"user32.dll\\\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);\' -Name W -Namespace K; [K.W]::keybd_event(0x5B,0,0,[UIntPtr]::Zero); [K.W]::keybd_event(0x48,0,0,[UIntPtr]::Zero); [K.W]::keybd_event(0x48,0,2,[UIntPtr]::Zero); [K.W]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)"', { windowsHide: true });
      res.json({ ok: true, action: 'winh', via: 'powershell-fallback' });
    }
  } else if (action === 'dictate') {
    // Forward to existing dictate endpoint logic
    try {
      const resp = await fetch('http://127.0.0.1:7790/dictate', { method: 'POST', signal: AbortSignal.timeout(2000) });
      const data = await resp.json();
      res.json({ ok: true, action: 'dictate', result: data });
    } catch {
      res.json({ ok: false, error: 'Tauri shell not reachable' });
    }
  } else {
    res.status(400).json({ error: 'action must be winh or dictate' });
  }
});

// Voice toggle — AHK or other clients can trigger dashboard mic streaming
app.post('/api/v1/voice/toggle', (req, res) => {
  broadcastNotification('voice_toggle', {});
  res.json({ ok: true });
});

// Voice dictate — forwards to Tauri shell's /dictate endpoint (Tauri owns mouse buttons + audio session)
// Fallback: if Tauri shell is down, spawn dictate-vad.py directly from server
let _dictateActive = false;
app.post('/api/v1/voice/dictate', async (req, res) => {
  try {
    // Try Tauri shell first (has user session audio access + mouse button hooks)
    const resp = await fetch('http://127.0.0.1:7790/dictate', { method: 'POST', signal: AbortSignal.timeout(2000) });
    const data = await resp.json();
    _dictateActive = data.action === 'started';
    res.json({ ok: true, action: data.action, via: 'tauri' });
  } catch {
    // Tauri shell not running — fall back to direct spawn
    const stopFile = join('C:\\Users\\tzuri\\AppData\\Local\\Temp', 'pan_dictate.wav.stop');
    if (_dictateActive) {
      try { writeFileSync(stopFile, 'stop'); } catch {}
      _dictateActive = false;
      res.json({ ok: true, action: 'stopping', via: 'direct' });
      return;
    }
    try {
      const { spawn: spawnProc } = await import('child_process');
      spawnProc('python.exe', [join(__dirname, 'dictate-vad.py'), '--no-sounds'], { stdio: 'ignore', detached: true }).unref();
      _dictateActive = true;
      setTimeout(() => { _dictateActive = false; }, 300000);
      res.json({ ok: true, action: 'started', via: 'direct' });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  }
});

// Voice result — receives partial/final transcription from dictate-vad.py and pushes to dashboard
app.post('/api/v1/voice/result', (req, res) => {
  const { text, action, partial } = req.body || {};
  console.log(`[PAN Voice] voice_result: partial=${partial} action=${action} text="${(text||'').substring(0,50)}"`);
  broadcastNotification('voice_result', { text: text || '', action: action || '', partial: !!partial });
  // Reset dictate state when final result arrives
  if (!partial) _dictateActive = false;
  res.json({ ok: true });
});

// Whisper transcription — accepts multipart form with WebM audio from dashboard mic button
app.post('/api/v1/whisper/transcribe', express.raw({ type: 'audio/webm', limit: '10mb' }), async (req, res) => {
  try {
    const { writeFileSync, unlinkSync } = await import('fs');
    const { join } = await import('path');
    const tmpDir = process.env.TEMP || 'C:\\Users\\tzuri\\AppData\\Local\\Temp';

    // Parse multipart or raw body
    let audioBuffer = req.body;
    if (!audioBuffer || audioBuffer.length < 500) {
      return res.json({ ok: false, error: 'Audio too short' });
    }

    // Save as temp WebM file
    const tmpFile = join(tmpDir, `pan-whisper-${Date.now()}.webm`);
    writeFileSync(tmpFile, audioBuffer);

    // Send to Whisper server (it handles WebM → WAV conversion)
    const whisperRes = await fetch('http://127.0.0.1:7782/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wav_path: tmpFile }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await whisperRes.json();
    try { unlinkSync(tmpFile); } catch {}

    if (result.text) {
      res.json({ ok: true, text: result.text, seconds: result.seconds });
    } else {
      res.json({ ok: false, error: result.error || 'No transcription' });
    }
  } catch (err) {
    console.error('[PAN Whisper] Transcribe error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// Whisper transcription — accepts raw WAV audio (legacy endpoint)
app.post('/api/v1/whisper', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  try {
    const { writeFileSync, unlinkSync } = await import('fs');
    const { join } = await import('path');
    const tmpDir = process.env.TEMP || 'C:\\Users\\tzuri\\AppData\\Local\\Temp';

    if (!req.body || req.body.length < 1000) {
      return res.json({ ok: false, error: 'Audio too short' });
    }

    // Save as temp WAV file
    const tmpFile = join(tmpDir, `pan-whisper-${Date.now()}.wav`);
    writeFileSync(tmpFile, req.body);

    // Send to Whisper server
    const whisperRes = await fetch('http://127.0.0.1:7782/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wav_path: tmpFile }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await whisperRes.json();

    // Cleanup
    try { unlinkSync(tmpFile); } catch {}

    if (result.text) {
      res.json({ ok: true, text: result.text, seconds: result.seconds });
    } else {
      res.json({ ok: false, error: result.error || 'No transcription' });
    }
  } catch (err) {
    console.error('[PAN Whisper] Error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// Health check
let _serverStartedAt = Date.now();
app.get('/health', (req, res) => {
  const uptimeMs = Date.now() - _serverStartedAt;
  const secs = Math.floor(uptimeMs / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  const uptime = hrs > 0 ? `${hrs}h ${mins % 60}m` : mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
  // Include Tailscale IP so phone can discover the server's remote address
  let tailscaleIp = null;
  try {
    tailscaleIp = execFileSync('C:\\Program Files\\Tailscale\\tailscale.exe', ['ip', '-4'], { timeout: 3000, encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    // Try PATH fallback
    try {
      tailscaleIp = execFileSync('tailscale', ['ip', '-4'], { timeout: 3000, encoding: 'utf8', windowsHide: true }).trim();
    } catch {}
  }
  res.json({ status: 'running', timestamp: new Date().toISOString(), startedAt: _serverStartedAt, uptime, tailscaleIp, mode: PAN_MODE, craftId: process.env.PAN_CRAFT_ID || null, craftVersion: 'A' });
});

// Detailed deployment-mode info for debugging which features are gated.
app.get('/api/v1/mode', (req, res) => {
  res.json({ ...MODE_INFO, features: { pty: IS_USER_MODE, ahk: IS_USER_MODE, screenshots: IS_USER_MODE, hooks: true, api: true, db: true } });
});

// Library: unified browsable list of docs, memory, .pan files, reports
app.get('/api/v1/library', (req, res) => {
  try {
    const ROOT = pathResolve(__dirname, '..', '..');
    const items = [];

    function walk(dir, type, baseRel) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.pan') continue;
        if (e.name === 'node_modules') continue;
        const full = join(dir, e.name);
        const rel = baseRel ? join(baseRel, e.name) : e.name;
        if (e.isDirectory()) {
          walk(full, type, rel);
        } else if (/\.(md|pan|tex)$/i.test(e.name) || e.name === '.pan') {
          let stat; try { stat = statSync(full); } catch { continue; }
          let snippet = '';
          try {
            const buf = readFileSync(full, 'utf8');
            snippet = buf.replace(/^---[\s\S]*?---/, '').replace(/[#>*`_\-]/g, '').trim().split('\n').find(l => l.trim()) || '';
            if (snippet.length > 120) snippet = snippet.slice(0, 117) + '...';
          } catch {}
          items.push({
            type,
            title: e.name.replace(/\.(md|pan|tex)$/i, '').replace(/[-_]/g, ' '),
            path: full.replace(/\\/g, '/'),
            rel: rel.replace(/\\/g, '/'),
            modified: stat.mtimeMs,
            snippet,
          });
        }
      }
    }

    walk(join(ROOT, 'docs'), 'doc');
    walk(join(homedir(), '.claude', 'projects', 'C--Users-tzuri-Desktop-PAN', 'memory'), 'memory');
    // .pan project files
    try {
      const panFiles = ['.pan', 'service/.pan', 'CLAUDE.md'];
      for (const f of panFiles) {
        const full = join(ROOT, f);
        if (existsSync(full)) {
          const stat = statSync(full);
          items.push({ type: 'pan', title: f, path: full.replace(/\\/g, '/'), rel: f, modified: stat.mtimeMs, snippet: '' });
        }
      }
    } catch {}

    items.sort((a, b) => b.modified - a.modified);
    res.json({ items, count: items.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/v1/library/view', (req, res) => {
  try {
    const p = req.query.path;
    if (!p || typeof p !== 'string') return res.status(400).send('missing path');
    // Safety: only serve files under PAN root or claude memory dir
    const ROOT = pathResolve(__dirname, '..', '..').replace(/\\/g, '/');
    const MEM = join(homedir(), '.claude', 'projects', 'C--Users-tzuri-Desktop-PAN').replace(/\\/g, '/');
    const norm = pathResolve(p).replace(/\\/g, '/');
    if (!norm.startsWith(ROOT) && !norm.startsWith(MEM)) return res.status(403).send('forbidden');
    if (!existsSync(norm)) return res.status(404).send('not found');
    const content = readFileSync(norm, 'utf8');
    const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const title = basename(norm);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
body{background:#0a0e14;color:#cdd6f4;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.55;margin:0;padding:24px 32px;}
h1{font-size:14px;color:#89b4fa;border-bottom:1px solid #313244;padding-bottom:8px;margin-top:0;}
pre{white-space:pre-wrap;word-wrap:break-word;margin:0;}
</style></head><body><h1>${title}</h1><pre>${escaped}</pre></body></html>`);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// Auto-detect local model providers (Ollama, LM Studio)
async function autoDetectLocalModels() {
  const detected = [];

  // Check Ollama (default port 11434)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('http://localhost:11434/api/tags', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const models = data.models || [];
      console.log(`[PAN Setup] Ollama detected with ${models.length} models`);
      for (const m of models) {
        detected.push({
          id: m.name || m.model,
          name: (m.name || m.model).split(':')[0] + ' (Ollama)',
          provider: 'ollama',
          url: 'http://localhost:11434',
        });
      }
    }
  } catch {}

  // Check LM Studio (default port 1234)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('http://localhost:1234/v1/models', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const models = data.data || [];
      console.log(`[PAN Setup] LM Studio detected with ${models.length} models`);
      for (const m of models) {
        detected.push({
          id: m.id,
          name: m.id + ' (LM Studio)',
          provider: 'lmstudio',
          url: 'http://localhost:1234',
        });
      }
    }
  } catch {}

  if (detected.length === 0) {
    console.log('[PAN Setup] No local model providers detected');
    return;
  }

  // Check if we already have custom models configured
  let existing = [];
  try {
    const row = get("SELECT value FROM settings WHERE key = 'custom_models'");
    if (row) existing = JSON.parse(row.value);
  } catch {}

  // Add newly detected models that aren't already configured
  const existingIds = new Set(existing.map(m => m.id));
  let added = 0;
  for (const m of detected) {
    if (!existingIds.has(m.id)) {
      existing.push(m);
      added++;
    }
  }

  if (added > 0) {
    run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('custom_models', :val, datetime('now','localtime'))", {
      ':val': JSON.stringify(existing)
    });
    console.log(`[PAN Setup] Auto-added ${added} local model(s) to providers`);

    // If no default model is set, use the first detected one
    const currentModel = get("SELECT value FROM settings WHERE key = 'ai_model'");
    if (!currentModel || !currentModel.value || currentModel.value === '""') {
      const firstModel = detected[0].id;
      run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('ai_model', :val, datetime('now','localtime'))", {
        ':val': JSON.stringify(firstModel)
      });
      console.log(`[PAN Setup] Auto-set default model to: ${firstModel}`);
    }
  }
}

let server;
let _startupIntervals = []; // Track intervals so soft restart can clear them

function start() {
  _serverStartedAt = Date.now();
  // Clear any intervals from previous start (soft restart)
  for (const id of _startupIntervals) clearInterval(id);
  _startupIntervals = [];

  return new Promise((resolve, reject) => {
    server = app.listen(PORT, HOST, () => {
      console.log(`[PAN] Service running on http://${HOST}:${PORT}`);
      console.log(`[PAN] Listening for Claude Code hooks...`);

      // ── SHARED BOOT (prod + dev) ─────────────────────────────────
      // Dev is an exact copy of prod on a different port + database.
      // Only system-wide singletons (steward, device heartbeat) are
      // skipped in dev — they're one-per-machine and would conflict
      // with the running prod server.

      // Start WebSocket terminal server (PTY sessions).
      // Gated to user-session mode only — node-pty's ConPTY backend
      // crashes with "AttachConsole failed" when there's no real
      // console (Session 0 services).
      // When running as Craft under Carrier, terminal is owned by Carrier — skip here.
      if (IS_CRAFT) {
        console.log('[PAN Craft] Terminal server SKIPPED — owned by Carrier');
      } else if (IS_USER_MODE) {
        (IS_DEV ? startDevTerminalServer(server) : startTerminalServer(server))
          .catch(e => console.error('[PAN] Terminal init error:', e));
      } else {
        console.log('[PAN] Terminal server SKIPPED — service mode (no console)');
      }

      // Sync projects with disk reality on startup
      syncProjects();

      // Migrate timestamp-based tab session IDs to stable name-based IDs.
      // e.g. "dash-pan-1775843785916" → "dash-pan-main" (derived from tab_name).
      // This runs once — stable IDs don't change, so future boots are no-ops.
      try {
        const openTabs = all("SELECT ot.id, ot.session_id, ot.tab_name, p.name as project_name FROM open_tabs ot LEFT JOIN projects p ON p.id = ot.project_id WHERE ot.closed_at IS NULL");
        for (const t of openTabs) {
          if (t.session_id && /^dash-.*\d{10,}$/.test(t.session_id)) {
            const name = (t.tab_name || t.project_name || 'shell').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const stableId = 'dash-' + name;
            run("UPDATE open_tabs SET session_id = :newId WHERE id = :tabId", { ':newId': stableId, ':tabId': t.id });
            console.log(`[PAN] Migrated tab "${t.tab_name}" session: ${t.session_id} → ${stableId}`);
          }
        }
      } catch (err) {
        console.error('[PAN] Tab migration error:', err.message);
      }

      // Seed sensor definitions (22 sensors)
      seedSensors();

      // Auto-detect local model providers (Ollama, LM Studio)
      autoDetectLocalModels();

      // Re-sync projects every 10 minutes (picks up renames, new .pan files)
      _startupIntervals.push(setInterval(syncProjects, 10 * 60 * 1000));

      if (IS_DEV) {
        // ── DEV-ONLY ──────────────────────────────────────────────────
        // Full server copy — terminal, dashboard, all routes — just no
        // system-wide singletons that would fight with prod.
        console.log('[PAN DEV] Full server on port ' + PORT + ' (terminal + dashboard + API)');
        console.log('[PAN DEV] Skipping: steward, device heartbeat');
        console.log(`[PAN DEV] Dashboard: http://localhost:${PORT}`);
      } else {
        // ── PROD-ONLY ─────────────────────────────────────────────────

        // Hybrid memory search: backfill embeddings
        setImmediate(() => {
          backfillEmbeddings('main')
            .then(r => console.log(`[PAN MemorySearch] backfill: +${r.added} embeddings (${r.indexed}/${r.total})`))
            .catch(err => console.warn('[PAN MemorySearch] backfill error:', err.message));
        });

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

        // Keep PC device heartbeat alive (every 60 seconds)
        _startupIntervals.push(setInterval(() => {
          try {
            run("UPDATE devices SET last_seen = datetime('now','localtime') WHERE hostname = :h", { ':h': pcHost });
          } catch {}
        }, 60 * 1000));

        // Steward boots all background services in dependency order.
        bootAll().catch(err => console.error('[Steward] Boot error:', err.message));
      }

      // Resume restart test if one was in progress before we died
      resumeRestartTest().catch(err => console.error('[PAN Tests] Resume failed:', err.message));

      resolve(server);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Retry with delay — port may be in TIME_WAIT from previous process
        if (!server._retryCount) server._retryCount = 0;
        server._retryCount++;
        if (server._retryCount <= 15) {
          console.log(`[PAN] Port ${PORT} in use — retry ${server._retryCount}/15 in 2s...`);
          setTimeout(() => server.listen(PORT, HOST), 2000);
          return;
        }
        console.error(`[PAN] Port ${PORT} still in use after 15 retries (30s). Exiting.`);
        process.exit(1);
        return;
      }
      reject(err);
    });
  });
}

async function stop() {
  // Kill every tracked PTY child first on graceful shutdown.
  // Two-phase: broadcast server_restarting FIRST, wait 200ms for WS
  // delivery, THEN kill PTYs. This ensures the frontend receives the
  // flag before the connection drops — without it, wasServerRestart is
  // false and Claude never auto-relaunches after restart.
  try {
    const n = await killAllSessions();
    if (n) console.log(`[PAN] Killed ${n} tracked PTY session(s) on shutdown`);
  } catch (e) {
    console.warn(`[PAN] killAllSessions failed: ${e.message}`);
  }
  shutdownAll();
  return new Promise((resolve) => {
    if (server) {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };
      server.close(done);
      // Force-destroy all open connections so server.close() doesn't hang on keep-alive/websockets
      if (server._connections || server.connections) {
        try { server.closeAllConnections(); } catch {}
      }
      // Safety net — force resolve after 3 seconds
      setTimeout(done, 3000);
    } else {
      resolve();
    }
  });
}

// Graceful shutdown — kill all background jobs and close the port
async function gracefulShutdown(signal) {
  console.log(`\n[PAN] ${signal} received — shutting down...`);
  await stop();
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Catch unhandled errors so the server doesn't crash and kill all PTY sessions
process.on('uncaughtException', (err) => {
  console.error(`[PAN] Uncaught exception (server kept alive):`, err);
  try {
    createAlert({
      alert_type: 'uncaught_exception',
      severity: 'critical',
      title: `Uncaught exception: ${err.message?.slice(0, 100)}`,
      detail: JSON.stringify({ message: err.message, stack: err.stack, time: new Date().toISOString() })
    });
  } catch {}
});
process.on('unhandledRejection', (reason) => {
  console.error(`[PAN] Unhandled rejection (server kept alive):`, reason);
  try {
    createAlert({
      alert_type: 'unhandled_rejection',
      severity: 'warning',
      title: `Unhandled rejection: ${String(reason)?.slice(0, 100)}`,
      detail: JSON.stringify({ reason: String(reason), stack: reason?.stack, time: new Date().toISOString() })
    });
  } catch {}
});

// ==================== UI Commands (dashboard frontend polls this, not Electron main) ====================
const uiCommandQueue = [];

app.get('/api/v1/ui-commands', (req, res) => {
  const cmds = uiCommandQueue.splice(0);
  res.json(cmds);
});

app.post('/api/v1/ui-commands', async (req, res) => {
  const cmd = req.body;
  if (!cmd || !cmd.type) return res.status(400).json({ error: 'type required' });
  // Route window commands to Tauri shell
  if (cmd.type === 'open_window') {
    tauriFetch('/open', { method: 'POST', body: JSON.stringify(cmd) }).catch(() => {});
  } else if (cmd.type === 'focus_window') {
    tauriFetch('/focus', { method: 'POST', body: JSON.stringify(cmd) }).catch(() => {});
  } else if (cmd.type === 'close_window') {
    tauriFetch('/close', { method: 'POST', body: JSON.stringify(cmd) }).catch(() => {});
  } else if (cmd.type === 'screenshot') {
    tauriFetch('/screenshot', { method: 'POST', body: JSON.stringify({ windowId: cmd.windowId || null }) }).catch(() => {});
  }
  uiCommandQueue.push(cmd);
  res.json({ ok: true });
});

// ==================== Tauri Shell (port 7790) — direct HTTP, no polling ====================
const TAURI_URL = 'http://127.0.0.1:7790';

async function tauriFetch(path, options = {}) {
  const res = await fetch(`${TAURI_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

// Screenshot (full screen)
app.get('/api/v1/screenshot', async (req, res) => {
  try {
    const windowId = req.query.window || null;
    const result = await tauriFetch('/screenshot', {
      method: 'POST',
      body: JSON.stringify({ windowId }),
    });
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: `Tauri shell not responding: ${err.message}` });
  }
});

// List all Tauri windows
app.get('/api/v1/windows', async (req, res) => {
  try {
    const result = await tauriFetch('/windows');
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: `Tauri shell not responding: ${err.message}` });
  }
});

// Open window
app.post('/api/v1/windows/open', async (req, res) => {
  try {
    const result = await tauriFetch('/open', {
      method: 'POST',
      body: JSON.stringify({ url: req.body.url, title: req.body.title }),
    });
    console.log(`[PAN Windows] Opened: ${req.body.url} → ${result.windowId}`);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: `Tauri shell not responding: ${err.message}` });
  }
});

// Focus a window by ID
app.post('/api/v1/windows/focus', async (req, res) => {
  try {
    const result = await tauriFetch('/focus', {
      method: 'POST',
      body: JSON.stringify({ windowId: req.body.windowId }),
    });
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Close a window by ID
app.post('/api/v1/windows/close', async (req, res) => {
  try {
    const result = await tauriFetch('/close', {
      method: 'POST',
      body: JSON.stringify({ windowId: req.body.windowId }),
    });
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Client Logs — universal telemetry from all devices
// ═══════════════════════════════════════════════════════════════════

// POST /api/v1/logs — accept single or batch logs
app.post('/api/v1/logs', (req, res) => {
  try {
    const entries = Array.isArray(req.body) ? req.body : [req.body];
    if (entries.length === 0) return res.json({ ok: true, inserted: 0 });
    if (entries.length > 100) return res.status(400).json({ error: 'Max 100 logs per batch' });

    const stmt = db.prepare(`INSERT INTO client_logs (device_id, device_type, level, source, message, meta, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))`);

    let inserted = 0;
    for (const e of entries) {
      if (!e.message) continue;
      stmt.run(
        e.device_id || 'unknown',
        e.device_type || 'browser',
        e.level || 'error',
        e.source || 'console',
        String(e.message).slice(0, 4000),
        JSON.stringify(e.meta || {})
      );
      inserted++;
    }
    res.json({ ok: true, inserted });
  } catch (err) {
    console.error('[Client Logs] Insert error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/logs — query logs with filters
app.get('/api/v1/logs', (req, res) => {
  try {
    const { device, device_type, level, source, since, limit: lim } = req.query;
    let sql = 'SELECT * FROM client_logs WHERE 1=1';
    const params = [];

    if (device) { sql += ' AND device_id = ?'; params.push(device); }
    if (device_type) { sql += ' AND device_type = ?'; params.push(device_type); }
    if (level) { sql += ' AND level = ?'; params.push(level); }
    if (source) { sql += ' AND source = ?'; params.push(source); }
    if (since) {
      // since=1h, since=24h, since=7d
      const match = since.match(/^(\d+)([hmd])$/);
      if (match) {
        const [, n, unit] = match;
        const mins = unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : parseInt(n);
        sql += ` AND created_at >= datetime('now','localtime','-${mins} minutes')`;
      }
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(lim) || 100);

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) {
    console.error('[Client Logs] Query error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/v1/logs — retention cleanup
app.delete('/api/v1/logs', (req, res) => {
  try {
    const { older_than } = req.query; // e.g. 7d, 30d
    const match = (older_than || '30d').match(/^(\d+)([hmd])$/);
    if (!match) return res.status(400).json({ error: 'Invalid older_than format (e.g. 7d, 24h)' });
    const [, n, unit] = match;
    const mins = unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : parseInt(n);
    const result = db.prepare(`DELETE FROM client_logs WHERE created_at < datetime('now','localtime','-${mins} minutes')`).run();
    res.json({ ok: true, deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/logs/summary — quick overview of log counts by device/level
app.get('/api/v1/logs/summary', (req, res) => {
  try {
    const since = req.query.since || '24h';
    const match = since.match(/^(\d+)([hmd])$/);
    const mins = match ? (match[2] === 'h' ? match[1] * 60 : match[2] === 'd' ? match[1] * 1440 : parseInt(match[1])) : 1440;
    const rows = db.prepare(`SELECT device_id, device_type, level, COUNT(*) as count
      FROM client_logs WHERE created_at >= datetime('now','localtime','-${mins} minutes')
      GROUP BY device_id, device_type, level ORDER BY count DESC`).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restart endpoint — always does a full process restart that reloads all code from disk.
// The node-windows wrapper automatically revives the process after exit.
app.post('/api/admin/restart', async (req, res) => {
  if (IS_CRAFT) {
    // Running under Carrier — restart the WHOLE Carrier (not just hot-swap Craft).
    // Hot-swap only replaces Craft (server.js). To pick up Carrier code changes,
    // we need to kill the old Carrier and spawn a fresh `node pan.js start`.
    // The new Carrier will kill whatever is on port 7777 (via killProcessOnPort)
    // and boot a brand new Carrier + Craft from disk.
    res.json({ ok: true, message: 'Carrier restart initiated — spawning fresh Carrier...' });
    console.log('[PAN Craft] Full Carrier restart requested — spawning new Carrier process');
    setTimeout(async () => {
      try {
        const { spawn } = await import('child_process');
        const child = spawn(process.execPath, ['pan.js', 'start'], {
          cwd: join(__dirname, '..'),
          stdio: 'ignore',
          detached: true,
          windowsHide: true,
          env: { ...process.env, PAN_CRAFT: undefined }
        });
        child.unref();
        console.log(`[PAN Craft] New Carrier spawned (PID ${child.pid}) — old Carrier will be killed on port bind`);
      } catch (err) {
        console.error('[PAN Craft] Failed to spawn new Carrier:', err.message);
      }
    }, 500);
    return;
  }
  res.json({ ok: true, message: 'Restarting — process will exit and reload all code...' });
  console.log('[PAN] Restart requested');
  setTimeout(async () => {
    console.log('[PAN] Stopping all services...');
    await stop();
    await new Promise(r => setTimeout(r, 1000));

    const isDev = process.env.PAN_PORT && parseInt(process.env.PAN_PORT) !== 7777;
    if (isDev) {
      console.log('[PAN] Dev mode — spawning fresh dev server...');
      const { spawn } = await import('child_process');
      const child = spawn(process.execPath, ['dev-server.js', String(process.env.PAN_PORT)], {
        cwd: join(__dirname, '..'),
        stdio: 'inherit',
        detached: true,
        windowsHide: true,
        env: { ...process.env }
      });
      child.unref();
    }

    console.log(`[PAN] Exiting for restart (${isDev ? 'dev' : 'prod — wrapper will restart'})`);
    process.exit(0);
  }, 500);
});

export { start, stop, app };

// Auto-start when forked by Carrier (PAN_CRAFT=1).
// Carrier forks this file as a child process — it doesn't call start() itself.
if (process.env.PAN_CRAFT === '1') {
  start().catch(err => {
    console.error('[PAN Craft] Failed to start:', err.message);
    process.exit(1);
  });
}

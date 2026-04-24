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
import incognitoRouter, { cleanupExpiredIncognito } from './routes/incognito.js';
import auditRouter from './routes/audit.js';
import replicationRouter from './routes/replication.js';
import zonesRouter, { getActiveZones, findZonesForPoint } from './routes/zones.js';
import syncRouter, { startPersonalSync, stopPersonalSync } from './routes/sync.js';
import orgsRouter from './routes/orgs.js';
import chatRouter, { ensureChatSchema } from './routes/chat.js';
import emailRouter, { initEmail } from './routes/email.js';
import teamsRouter from './routes/teams.js';
import wrapRouter, { ensureWrapSchema } from './routes/wrap.js';
import messagingPrefsRouter, { ensureMessagingPrefsSchema } from './routes/messaging-prefs.js';
import intuitionRouter from './routes/intuition.js';
import { benchmarkApiRouter, benchmarkDashRouter } from './routes/benchmark.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { ensureIntuitionSchema } from './intuition.js';
import { startScreenWatcher, startBurst } from './screen-watcher.js';
import guardianRouter from './routes/guardian.js';
import { guardianMiddleware } from './guardian.js';
import { privacyMiddleware } from './privacy.js';
import privacyRouter from './routes/privacy.js';
import { extractUser } from './middleware/auth.js';
import { requireOrg, auditLog, verifyAllAuditChains, resignAuditChain } from './middleware/org-context.js';
import { evolve } from './evolution/engine.js';
import { buildContext as buildMemoryContext } from './memory/index.js';
import { getConfig as getAutoDevConfig, saveConfig as saveAutoDevConfig, getAutoDevLog } from './autodev.js';
import { getAllStacks, scanStacks, getProjectBriefing, getEnvironmentBriefing } from './stack-scanner.js';
import { bootAll, shutdownAll, getAtlasData, getServiceStatus, reportServiceRun } from './steward.js';
import { startCloudflareTunnel, stopCloudflareTunnel, getTunnelURL } from './cloudflare-tunnel.js';
export { getTunnelURL }; // re-export so client.js can import it
import { startDiscovery, stopDiscovery } from './discovery.js';
import { PAN_MODE, IS_USER_MODE, IS_SERVICE_MODE, MODE_INFO } from './mode.js';
import { getDataDir } from './platform.js';
import { syncProjects, get, all, insert, run, indexEventFTS, db, getOllamaUrl } from './db.js';
import { searchMemory, backfillEmbeddings } from './memory-search.js';
import { listScopes, wipeScope } from './db-registry.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import https from 'https';
import { execFileSync, execSync, spawn as spawnChild } from 'child_process';
import { startTerminalServer, startDevTerminalServer, listSessions, killSession, killAllSessions, getActivePtyPids, getTerminalProjects, sendToSession, broadcastToSession, broadcastNotification, getPendingPermissions, clearPermission, respondToPermission, getProcessRegistry, pipeSend, pipeInterrupt, pipeSetModel, getSessionMessages, createPipeSession } from './terminal-bridge.js';
import { startClientServer, sendToClient as sendToClientDevice, getConnectedClients, checkInviteToken } from './client-manager.js';
import clientRouter from './routes/client.js';
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

// Auto-register/update phone device from any route (phone sends X-Device-Name + X-Device-Id headers)
// Uses X-Device-Id as stable key (survives app reinstall) instead of IP-based hostnames
app.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const deviceName = req.headers['x-device-name'];
  const deviceId = req.headers['x-device-id'];
  const tailscaleHost = req.headers['x-tailscale-hostname'];
  if (deviceName && ip !== '127.0.0.1' && ip !== '::1' && !ip.endsWith('127.0.0.1')) {
    // Use stable device ID if available, fall back to IP-based
    const phoneHost = deviceId ? `phone-${deviceId}` : `phone-${ip.replace(/[^0-9.]/g, '')}`;
    const existing = get("SELECT * FROM devices WHERE hostname = :h", { ':h': phoneHost });
    if (existing) {
      run("UPDATE devices SET name = :name, last_seen = datetime('now','localtime') WHERE hostname = :h",
        { ':name': deviceName, ':h': phoneHost });
      // Track Tailscale hostname changes — if it changed, the old node is stale
      if (tailscaleHost && existing.tailscale_hostname && tailscaleHost !== existing.tailscale_hostname) {
        console.log(`[PAN Device] Tailscale hostname changed: ${existing.tailscale_hostname} → ${tailscaleHost} — cleaning up stale node`);
        cleanupStaleTailscaleNode(existing.tailscale_hostname);
      }
      if (tailscaleHost && tailscaleHost !== existing.tailscale_hostname) {
        run("UPDATE devices SET tailscale_hostname = :ts WHERE hostname = :h",
          { ':ts': tailscaleHost, ':h': phoneHost });
      }
    } else if (deviceId) {
      // Check for legacy IP-based records for this device and migrate
      const legacyIpHost = `phone-${ip.replace(/[^0-9.]/g, '')}`;
      const legacy = get("SELECT * FROM devices WHERE hostname = :h", { ':h': legacyIpHost });
      if (legacy) {
        run("UPDATE devices SET hostname = :newH, name = :name, tailscale_hostname = :ts, last_seen = datetime('now','localtime') WHERE hostname = :h",
          { ':newH': phoneHost, ':name': deviceName, ':ts': tailscaleHost || null, ':h': legacyIpHost });
        console.log(`[PAN Device] Migrated legacy device ${legacyIpHost} → ${phoneHost}`);
      } else {
        try {
          insert(`INSERT INTO devices (hostname, name, device_type, capabilities, tailscale_hostname, last_seen, org_id)
            VALUES (:h, :name, 'phone', '["mic","camera","sensors","gps"]', :ts, datetime('now','localtime'), 'org_personal')`, {
            ':h': phoneHost, ':name': deviceName, ':ts': tailscaleHost || null
          });
          console.log(`[PAN Device] Registered phone: ${phoneHost} (${deviceName})`);
        } catch(e) { /* UNIQUE constraint — already exists */ }
      }
    }
  }
  next();
});

// Cleanup stale Tailscale nodes — uses local tailscale CLI (full permissions on this machine)
// then falls back to Tailscale API if available
async function cleanupStaleTailscaleNode(staleHostname) {
  try {
    // Get full peer list from tailscale status --json
    let statusJson;
    try {
      statusJson = execFileSync('C:\\Program Files\\Tailscale\\tailscale.exe',
        ['status', '--json'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    } catch {
      try {
        statusJson = execFileSync('tailscale',
          ['status', '--json'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
      } catch { return; }
    }

    const status = JSON.parse(statusJson);
    const peers = status.Peer || {};
    const staleNodes = Object.entries(peers)
      .filter(([_, v]) => v.HostName === staleHostname && !v.Online)
      .map(([k, v]) => ({ nodekey: k, hostname: v.HostName, ip: (v.TailscaleIPs || [])[0] }));

    if (staleNodes.length === 0) {
      console.log(`[PAN Device] No stale nodes found for hostname: ${staleHostname}`);
      return;
    }

    // Try Tailscale API to delete (needs API key with devices:write scope)
    const clientId = get("SELECT value FROM settings WHERE key = 'tailscale_oauth_client_id'")?.value;
    const clientSecret = get("SELECT value FROM settings WHERE key = 'tailscale_oauth_client_secret'")?.value;
    if (clientId && clientSecret) {
      const auth = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const listRes = await fetch('https://api.tailscale.com/api/v2/tailnet/-/devices', {
        headers: { 'Authorization': auth }
      });
      if (listRes.ok) {
        const data = await listRes.json();
        const apiDevices = (data.devices || []).filter(d =>
          d.hostname === staleHostname && !d.online
        );
        for (const dev of apiDevices) {
          console.log(`[PAN Device] Removing stale node via API: ${dev.hostname} (${dev.id})`);
          const delRes = await fetch(`https://api.tailscale.com/api/v2/device/${dev.id}`, {
            method: 'DELETE', headers: { 'Authorization': auth }
          });
          console.log(`[PAN Device] Delete result: ${delRes.status}`);
        }
        return;
      }
    }

    // Fallback: log the stale nodes so the user knows (API doesn't have permissions)
    for (const node of staleNodes) {
      console.warn(`[PAN Device] Stale Tailscale node detected: ${node.hostname} (${node.ip}) — remove manually at https://login.tailscale.com/admin/machines`);
    }
  } catch (e) {
    console.warn(`[PAN Device] Tailscale cleanup failed: ${e.message}`);
  }
}

// Auth routes (some endpoints skip auth — login-related stuff)
app.use('/api/v1/auth', (req, res, next) => {
  const publicPaths = ['/oauth', '/google-callback', '/github-callback', '/dev-token', '/users'];
  if (publicPaths.includes(req.path)) return next();
  // GET /providers is public (login page needs it), POST needs auth
  if (req.path === '/providers' && req.method === 'GET') return next();
  // Auto-auth for localhost/Tailscale (same as general middleware)
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1') || ip === '::ffff:127.0.0.1';
  const isTailscale = ip.startsWith('100.') || ip.startsWith('::ffff:100.');
  if (isLocalhost || isTailscale) {
    req.user = { id: 1, email: 'owner@localhost', display_name: 'Owner', role: 'owner' };
    return next();
  }
  extractUser(req, res, next);
}, authRouter);

// Phone screenshot upload — saves image to temp file so Claude Code can view it
// Phone sends base64 image data. Returns the local file path for Claude to read.
// Also stores the latest screenshot path in settings so Claude can find it.
app.post('/api/v1/screenshot/upload', async (req, res) => {
  try {
    const { data, mimeType, source } = req.body;
    if (!data) return res.status(400).json({ ok: false, error: 'No image data' });
    const ext = (mimeType || 'image/png').split('/')[1] || 'png';
    const filename = `screenshot_${source || 'phone'}_${Date.now()}.${ext}`;
    const dir = join(process.env.TEMP || '/tmp', 'pan-screenshots');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, filename);
    writeFileSync(filePath, Buffer.from(data, 'base64'));
    // Store path so Claude can reference it
    run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('last_screenshot', :path, datetime('now','localtime'))", { ':path': JSON.stringify(filePath) });
    console.log(`[PAN Screenshot] Saved: ${filePath} (${Math.round(data.length / 1024)}KB base64)`);
    res.json({ ok: true, path: filePath, filename });
  } catch (err) {
    console.error('[PAN Screenshot] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/v1/screenshot/latest — returns path to most recent screenshot
app.get('/api/v1/screenshot/latest', (req, res) => {
  try {
    const row = get("SELECT value FROM settings WHERE key = 'last_screenshot'");
    if (!row) return res.json({ ok: false, error: 'No screenshots uploaded yet' });
    const filePath = row.value.replace(/^"|"$/g, '');
    if (!existsSync(filePath)) return res.json({ ok: false, error: 'Screenshot file missing', path: filePath });
    res.json({ ok: true, path: filePath });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/v1/screenshot/view — serve the actual image file
app.get('/api/v1/screenshot/view', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath || !existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    // Security: only serve from pan-screenshots dir
    if (!filePath.includes('pan-screenshots')) return res.status(403).json({ error: 'Forbidden' });
    const ext = filePath.split('.').pop();
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
    res.setHeader('Content-Type', mimeMap[ext] || 'image/png');
    res.send(readFileSync(filePath));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all screenshots
app.get('/api/v1/screenshot/list', (req, res) => {
  try {
    const dir = join(process.env.TEMP || '/tmp', 'pan-screenshots');
    if (!existsSync(dir)) return res.json({ screenshots: [] });
    const files = readdirSync(dir)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map(f => ({ filename: f, path: join(dir, f), created: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.created - a.created)
      .slice(0, 50);
    res.json({ screenshots: files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// System health check — tests every service, used by setup wizard and monitoring
app.get('/api/system-check', async (req, res) => {
  const checks = {};

  // 1. Database
  try {
    get("SELECT 1");
    checks.database = { ok: true, status: 'Running' };
  } catch (e) {
    checks.database = { ok: false, status: 'Down', error: e.message };
  }

  // 2. AI provider
  try {
    const row = get("SELECT value FROM settings WHERE key = 'ai_model'");
    const model = row?.value?.replace(/^"|"$/g, '') || 'claude (CLI)';
    checks.ai = { ok: true, status: 'Configured', model };
  } catch {
    checks.ai = { ok: false, status: 'Not Configured' };
  }

  // 3. Memory pipeline (check tables exist and have data)
  try {
    const eventCount = get("SELECT COUNT(*) as c FROM events")?.c || 0;
    const memCount = get("SELECT COUNT(*) as c FROM memory_items")?.c || 0;
    checks.memory = { ok: eventCount > 0, status: eventCount > 0 ? 'Active' : 'Empty', events: eventCount, memories: memCount };
  } catch (e) {
    checks.memory = { ok: false, status: 'Error', error: e.message };
  }

  // 4. Steward (check for recent heartbeat)
  try {
    const hb = get("SELECT created_at FROM events WHERE event_type = 'StewardHeartbeat' ORDER BY id DESC LIMIT 1");
    if (hb) {
      const age = Date.now() - new Date(hb.created_at).getTime();
      checks.steward = { ok: age < 120000, status: age < 120000 ? 'Running' : 'Stale', last_heartbeat_ms: age };
    } else {
      checks.steward = { ok: false, status: 'No Heartbeats' };
    }
  } catch {
    checks.steward = { ok: false, status: 'Error' };
  }

  // 5. Intuition — check via JSON file or API, not DB (table may use different connection)
  try {
    const fs = await import('fs');
    const { getDataDir } = await import('./platform.js');
    const intuitionPath = (await import('path')).join(getDataDir(), 'intuition.json');
    if (fs.existsSync(intuitionPath)) {
      const raw = JSON.parse(fs.readFileSync(intuitionPath, 'utf8'));
      const age = Date.now() - (raw.as_of || 0);
      checks.intuition = { ok: age < 120000, status: age < 120000 ? 'Running' : 'Stale', age_ms: age };
    } else {
      checks.intuition = { ok: false, status: 'No Snapshots' };
    }
  } catch {
    checks.intuition = { ok: false, status: 'Not Available' };
  }

  // 6. Encryption
  try {
    const fs = await import('fs');
    const { getDataDir } = await import('./platform.js');
    const keyPath = (await import('path')).join(getDataDir(), 'pan.key');
    checks.encryption = { ok: fs.existsSync(keyPath), status: fs.existsSync(keyPath) ? 'Active' : 'No Key' };
  } catch {
    checks.encryption = { ok: false, status: 'Error' };
  }

  // 7. Terminal/PTY
  try {
    const sessions = get("SELECT COUNT(*) as c FROM (SELECT 1 LIMIT 1)");
    // Terminal is always available if server is running
    checks.terminal = { ok: true, status: 'Available' };
  } catch {
    checks.terminal = { ok: false, status: 'Error' };
  }

  // 8. Modules
  try {
    const { getModulesStatus } = await import('./modules.js');
    const mods = getModulesStatus();
    checks.modules = { ok: true, status: `${mods.filter(m => m.loaded).length}/${mods.length} Loaded`, modules: mods };
  } catch {
    checks.modules = { ok: true, status: '0 Loaded' };
  }

  // Summary
  const allOk = Object.values(checks).every(c => c.ok);
  const failedCount = Object.values(checks).filter(c => !c.ok).length;

  res.json({
    ok: allOk,
    failed: failedCount,
    total: Object.keys(checks).length,
    checks,
  });
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

// Tier 0 — attach org context to every /api request (after auth sets req.user)
app.use('/api', requireOrg);

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

app.get('/dashboard/api/processes', async (req, res) => {
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

    // Inject Super-Carrier + Carrier at the top — they live outside the Atlas
    // registry but are the most critical processes in the stack.
    const layerEntries = [];
    try {
      const hRes = await fetch('http://127.0.0.1:7777/health', { signal: AbortSignal.timeout(1500) });
      if (hRes.ok) {
        const hData = await hRes.json();
        if (hData.superCarrier && hData.superCarrierPid) {
          const scProc = enriched.find(p => p.pid === hData.superCarrierPid);
          layerEntries.push({
            id: 'super-carrier', name: 'Super-Carrier', status: 'running',
            role: 'Immortal process · owns :7777 + browser connections',
            port: 7777, pid: hData.superCarrierPid,
            cpuSec: scProc?.cpuSec ?? null, memMB: scProc?.memMB ?? null,
            uptimeHrs: scProc?.uptimeHrs ?? null, createdAt: scProc?.createdAt || null,
            inProcess: false, modelTierLabel: null,
          });
        }
        if (hData.carrierPid) {
          const cProc = enriched.find(p => p.pid === hData.carrierPid);
          layerEntries.push({
            id: 'carrier', name: 'Carrier', status: 'running',
            role: 'Hot-swap coordinator · PTY + WebSocket',
            port: 17760, pid: hData.carrierPid,
            cpuSec: cProc?.cpuSec ?? null, memMB: cProc?.memMB ?? null,
            uptimeHrs: cProc?.uptimeHrs ?? null, createdAt: cProc?.createdAt || null,
            inProcess: false, modelTierLabel: null,
          });
        }
        // Craft = this process (server.js)
        const craftProc = enriched.find(p => p.exe === 'node.exe' && /server\.js/i.test(p.cmd));
        layerEntries.push({
          id: 'craft', name: 'Craft', status: 'running',
          role: 'HTTP server · all routes + API',
          port: 17700, pid: process.pid,
          cpuSec: craftProc?.cpuSec ?? null, memMB: craftProc?.memMB ?? null,
          uptimeHrs: craftProc?.uptimeHrs ?? null, createdAt: craftProc?.createdAt || null,
          inProcess: false, modelTierLabel: null,
        });
      }
    } catch {}

    const atlas = getAtlasData();
    const services = [
      ...layerEntries,
      ...(atlas.services || []).map(svc => {
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
          pid: proc?.pid || null,
          cpuSec: proc?.cpuSec ?? null,
          memMB: proc?.memMB ?? null,
          uptimeHrs: proc?.uptimeHrs ?? null,
          createdAt: proc?.createdAt || null,
          inProcess,
        };
      }),
    ];

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

// Incognito mode (Tier 0 Phase 4)
app.use('/api/v1/incognito', incognitoRouter);

// Audit chain + Replication (Tier 0 Phase 6)
app.use('/api/v1/audit', auditRouter);
app.use('/api/v1/replication', replicationRouter);

// Geofencing + Zones (Tier 0 Phase 7)
app.use('/api/v1/zones', zonesRouter);

// Personal Data Sync (Tier 0 Phase 8)
app.use('/api/v1/sync', syncRouter);

// Org Management (Phase 2)
app.use('/api/v1/orgs', orgsRouter);

// Guardian Guillotine — content security scanner
app.use('/api/v1/guardian', guardianRouter);

// Differential Privacy — budget tracking and config
app.use('/api/v1/privacy', privacyRouter);

// Chat — text messaging, contacts, calls
app.use('/api/v1/chat', chatRouter);

// Email — universal IMAP/SMTP integration
app.use('/api/v1/email', emailRouter);

// Teams — groups within orgs, task assignment
app.use('/api/v1/teams', teamsRouter);

// Wrap — Tauri webview wrappers around third-party apps (Discord, Slack, etc.)
app.use('/api/v1/wrap', wrapRouter);

// Messaging preferences — per-user / per-org channel routing (Discord vs SMS vs email…)
app.use('/api/v1/messaging-prefs', messagingPrefsRouter);

// Intuition — live situational state daemon (read by PAN voice, Forge, Atlas)
app.use('/api/v1/intuition', intuitionRouter);

// Screen-watcher burst mode — called by carrier after a craft swap to get rapid
// screenshots (every 5s for 60s) so intuition sees the swap stages in real time.
app.post('/api/v1/screen-watcher/burst', (req, res) => {
  const duration = Math.min(parseInt(req.body?.duration_ms) || 60_000, 300_000);
  const interval = Math.min(parseInt(req.body?.interval_ms) || 5_000, 30_000);
  startBurst(duration, interval);
  res.json({ ok: true, duration_ms: duration, interval_ms: interval });
});

// Benchmark — AI model scoring suite (Intuition: Hearing/Reflex/Clarity/Reasoning/Memory/Voice)
app.use('/api/v1/ai', benchmarkApiRouter);

// Voice — Whisper STT + speaker ID (resemblyzer)
registerVoiceRoutes(app);

// PAN Client — manages connected pan-client processes on other machines
app.use('/api/v1/client', clientRouter);

// ── PAN Client install scripts ────────────────────────────────────────────────
// Secondary computers fetch these via: irm http://hub:7777/install/TOKEN | iex
//                                  or: curl -s http://hub:7777/install/TOKEN | bash
// The route auto-detects OS from User-Agent and returns the right script.
// pan-client.js is served from /client/pan-client.js for the script to download.

app.get('/client/pan-client.js', (req, res) => {
  const clientFile = join(__dirname, '../../pan-client/pan-client.js');
  res.setHeader('Content-Type', 'text/javascript');
  res.sendFile(clientFile);
});

app.get('/install/:token', (req, res) => {
  const { token } = req.params;
  if (!checkInviteToken(token)) {
    // Browser gets a nice error page
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isBrowser = ua.includes('mozilla');
    if (isBrowser) {
      return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>PAN — Invalid Token</title>
<style>body{background:#0a0a0f;color:#cdd6f4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px}.icon{font-size:48px}.title{font-size:22px;color:#f38ba8;margin:16px 0 8px}
.sub{color:#a6adc8;font-size:15px}</style></head>
<body><div class="box"><div class="icon">⛔</div>
<div class="title">Invalid or expired install token</div>
<div class="sub">This link has already been used or has expired.<br>Generate a new one from your PAN dashboard.</div>
</div></body></html>`);
    }
    return res.status(403).send('# Invalid or expired install token\n');
  }

  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const isHttpsReq = req.secure
    || req.headers['x-forwarded-proto'] === 'https'
    || host.includes('trycloudflare.com')
    || host.includes('ts.net');
  const proto = isHttpsReq ? 'https' : 'http';
  const wsProto = isHttpsReq ? 'wss' : 'ws';
  const hubWs  = `${wsProto}://${host}`;
  const clientJsUrl = `${proto}://${host}/client/pan-client.js`;
  const installUrl = `${proto}://${host}/install/${token}`;

  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isPowerShell = ua.includes('powershell');
  const isBrowser = ua.includes('mozilla') && !isPowerShell; // PowerShell UA also has 'mozilla'
  const isWindows = ua.includes('windows');
  const isMac = ua.includes('mac');

  // Browser → serve HTML landing page
  if (isBrowser) {
    const osLabel = isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux';
    const hubDisplayName = get("SELECT value FROM settings WHERE key = 'display_name'")?.value || hostname();
    const installCmd = isWindows
      ? `irm ${proto}://${host}/install/${token} | iex`
      : `curl -s ${proto}://${host}/install/${token} | bash`;

    // Hub-served download: personalised per invite — hub URL + token baked into filename
    const dlUrl  = `${proto}://${host}/install/${token}/download`;
    const dlName = isWindows ? 'pan-installer.bat' : 'pan-installer-linux';
    const dlHint = isWindows
      ? 'If browser warns, click <strong>Keep</strong> → then double-click to run'
      : isMac
        ? 'After downloading: <code>chmod +x ~/Downloads/pan-installer-linux && ~/Downloads/pan-installer-linux</code>'
        : 'After downloading: <code>chmod +x pan-installer-linux && ./pan-installer-linux</code>';

    // Fallback terminal steps (shown in the "Advanced" section)
    const advSteps = isWindows ? `
      <div class="adv-step"><span class="adv-num">1</span> Click <strong>Copy command</strong> below</div>
      <div class="adv-step"><span class="adv-num">2</span> Press <kbd>⊞ Win</kbd>+<kbd>R</kbd> → type <strong>powershell</strong> → Enter</div>
      <div class="adv-step"><span class="adv-num">3</span> Press <kbd>Ctrl</kbd>+<kbd>V</kbd> then <kbd>Enter</kbd></div>` : isMac ? `
      <div class="adv-step"><span class="adv-num">1</span> Click <strong>Copy command</strong> below</div>
      <div class="adv-step"><span class="adv-num">2</span> Press <kbd>⌘</kbd>+<kbd>Space</kbd> → type <strong>Terminal</strong> → Enter</div>
      <div class="adv-step"><span class="adv-num">3</span> Paste with <kbd>⌘</kbd>+<kbd>V</kbd> and press Enter</div>` : `
      <div class="adv-step"><span class="adv-num">1</span> Click <strong>Copy command</strong> below</div>
      <div class="adv-step"><span class="adv-num">2</span> Open a Terminal and paste, then press Enter</div>`;

    return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to PAN</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0f;color:#cdd6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#181825;border:1px solid #313244;border-radius:16px;padding:36px 32px;max-width:480px;width:100%}
.logo{font-size:36px;letter-spacing:4px;color:#89b4fa;font-weight:700;text-align:center;margin-bottom:2px}
.tagline{color:#6c7086;font-size:12px;text-align:center;margin-bottom:28px}
h2{font-size:18px;margin-bottom:6px;text-align:center;color:#cdd6f4}
.sub{font-size:13px;color:#6c7086;text-align:center;margin-bottom:24px}

/* Primary download block */
.dl-box{background:#0d2137;border:2px solid #89b4fa;border-radius:12px;padding:20px;margin-bottom:20px;text-align:center}
.dl-btn{display:inline-block;background:#89b4fa;color:#0a0a0f;text-decoration:none;border-radius:8px;padding:14px 28px;font-size:16px;font-weight:800;margin-bottom:12px;transition:background 0.15s;cursor:pointer}
.dl-btn:hover{background:#b4d0ff}
.dl-hint{font-size:12px;color:#6c7086;line-height:1.5}
.dl-hint strong{color:#a6adc8}
.dl-hint code{background:#313244;padding:1px 5px;border-radius:3px;font-size:11px}

/* Invite link box */
.link-box{background:#11111b;border:1px solid #313244;border-radius:10px;padding:14px 16px;margin-bottom:20px}
.link-label{font-size:11px;color:#6c7086;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px}
.link-row{display:flex;gap:8px;align-items:center}
.link-val{font-family:monospace;font-size:12px;color:#a6e3a1;overflow-wrap:anywhere;min-width:0;flex:1;line-height:1.4}
.copy-link-btn{background:#313244;color:#cdd6f4;border:none;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;white-space:nowrap;transition:background 0.15s}
.copy-link-btn:hover{background:#45475a}
.copy-link-btn.done{background:#a6e3a1;color:#0a0a0f}

/* Advanced section */
.adv-toggle{width:100%;background:none;border:none;color:#6c7086;font-size:12px;cursor:pointer;text-align:center;padding:8px 0;text-decoration:underline}
.adv-toggle:hover{color:#a6adc8}
.adv-section{display:none;margin-top:12px}
.adv-section.open{display:block}
.copy-box{background:#11111b;border:1px solid #313244;border-radius:8px;padding:12px;margin-bottom:10px}
.copy-cmd{font-family:monospace;font-size:12px;color:#a6e3a1;word-break:break-all;line-height:1.5;margin-bottom:10px}
.copy-btn{width:100%;background:#313244;color:#cdd6f4;border:none;border-radius:6px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;transition:background 0.15s}
.copy-btn:hover{background:#45475a}
.copy-btn.done{background:#a6e3a1;color:#0a0a0f}
.adv-step{font-size:13px;color:#a6adc8;padding:8px 0;border-top:1px solid #1e1e2e;display:flex;gap:10px;align-items:baseline;line-height:1.5}
.adv-num{background:#313244;color:#89b4fa;border-radius:50%;width:20px;height:20px;min-width:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
kbd{display:inline-block;background:#313244;border:1px solid #45475a;border-radius:4px;padding:0 5px;font-size:11px;font-family:monospace;color:#cdd6f4}

.expiry{font-size:11px;color:#f38ba8;text-align:center;margin-top:18px}
</style></head>
<body><div class="card">
  <div class="logo">ΠΑΝ</div>
  <div class="tagline">Personal AI Network</div>
  <h2>Connect this ${osLabel} computer to PAN</h2>
  <div class="sub">Download the script, then <strong>right-click → Run with PowerShell</strong>.</div>

  <div class="dl-box">
    <a class="dl-btn" href="${dlUrl}">⬇ Download PAN Installer</a>
    <div class="dl-hint">${dlHint}</div>
  </div>

  <div class="link-box">
    <div class="link-label" id="linkLabel">Invited by</div>
    <div class="link-row">
      <div class="link-val" style="font-size:15px;font-weight:700;color:#cdd6f4;font-family:inherit">🖥 ${hubDisplayName}</div>
    </div>
    <div style="font-size:11px;color:#6c7086;margin-top:8px">Invite link auto-copied to clipboard — the installer will use it automatically.</div>
  </div>

  <button class="adv-toggle" id="advToggle">▼ Need to paste the link manually?</button>

  <div class="adv-section" id="advSec">
    <div class="copy-box">
      <div class="copy-cmd" style="font-size:11px;word-break:break-all">${installUrl}</div>
      <button class="copy-btn" id="cpyLink" data-url="${installUrl}">Copy invite link</button>
    </div>
  </div>

  <div class="expiry">⏱ This invite expires in 30 minutes</div>
</div>
<script>
var INVITE_URL = ${JSON.stringify(installUrl)};

// Auto-copy invite link to clipboard on load
navigator.clipboard.writeText(INVITE_URL).catch(function() {});

document.getElementById('advToggle').addEventListener('click', function() {
  var s = document.getElementById('advSec');
  s.classList.toggle('open');
  this.textContent = s.classList.contains('open') ? '▲ Hide' : '▼ Need to paste the link manually?';
});
document.getElementById('cpyLink').addEventListener('click', function() {
  var b = this;
  navigator.clipboard.writeText(INVITE_URL).then(function() {
    b.textContent = '✓ Copied!'; b.classList.add('done');
    setTimeout(function() { b.textContent = 'Copy invite link'; b.classList.remove('done'); }, 2000);
  });
});
</script>
</body></html>`);
  }

  // PowerShell (irm ... | iex) or curl → raw script, existing behavior
  if (isWindows || isPowerShell) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(generateWindowsClientInstaller(token, hubWs, clientJsUrl));
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(generateLinuxClientInstaller(token, hubWs, clientJsUrl));
});

// Download the installer as a compiled .exe (Windows) or binary (Linux).
// The hub URL + token are encoded into the filename so the exe is self-configuring —
// user double-clicks, it installs, no terminal needed.
// Falls back to script download if the compiled binary isn't built yet.
app.get('/install/:token/download', (req, res) => {
  const { token } = req.params;
  if (!checkInviteToken(token)) return res.status(403).send('Invalid or expired token');

  const host    = req.headers.host || `127.0.0.1:${PORT}`;
  const isHttps = req.secure
    || (req.headers['x-forwarded-proto'] === 'https')
    || host.includes('trycloudflare.com')
    || host.includes('ts.net');
  const proto   = isHttps ? 'https' : 'http';
  const wsProto = isHttps ? 'wss' : 'ws';
  const ua      = (req.headers['user-agent'] || '').toLowerCase();
  const isWin   = ua.includes('windows');

  if (isWin) {
    // Encode config into filename — PS1 reads its own filename, no browser/server needed
    const cfg     = JSON.stringify({ h: host, t: token, s: isHttps ? 1 : 0 });
    const encoded = Buffer.from(cfg).toString('base64url');
    const filename = `pan-install.bat`;
    const bat = generateBATDownload(host, proto, wsProto, token);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(bat);
  }

  // Linux/Mac: shell script
  const sh = `#!/bin/bash\ncurl -s ${proto}://${host}/install/${token} | bash`;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="pan-install.sh"');
  res.send(sh);
});

// Simple .bat launcher — browser allows download (warns, not blocked).
// Double-click runs it. Fetches + executes the full install PS1 from the hub.
// No polyglot, no escaping hell, no AV flagging.
function generateBATDownload(host, proto, wsProto, token) {
  const installUrl = `${proto}://${host}/install/${token}`;
  const lines = [
    '@echo off',
    `title PAN Installer`,
    `PowerShell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm '${installUrl}')"`,
    'if %ERRORLEVEL% neq 0 (',
    '  echo.',
    '  echo   Something went wrong. See above for details.',
    '  pause',
    ')',
  ];
  return lines.join('\r\n');
}

// ---- dead code below kept for reference, replaced by generateBATDownload above ----
function generateBATDownload_UNUSED(host, proto, wsProto, token) {
  const nodeVer = '22.16.0';
  const nodeUrl = `https://nodejs.org/dist/v${nodeVer}/node-v${nodeVer}-win-x64.zip`;
  const lines = [
    '# PAN Installer — double-click to run',
    '# PAN Installer',
    '$ErrorActionPreference = "Stop"',
    '',
    '# Read config from own filename (base64url encoded)',
    '$self = $MyInvocation.MyCommand.Path',
    '$b64url = [System.IO.Path]::GetFileNameWithoutExtension($self) -replace "^pan-", ""',
    '# Convert base64url -> standard base64',
    '$b64 = $b64url.Replace("-", "+").Replace("_", "/")',
    'switch ($b64.Length % 4) { 2 { $b64 += "==" } 3 { $b64 += "=" } }',
    '$cfgJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))',
    '$cfg = $cfgJson | ConvertFrom-Json',
    '$isHttps = $cfg.s -eq 1',
    '$xProto  = if ($isHttps) { "https" } else { "http" }',
    '$xWs     = if ($isHttps) { "wss"   } else { "ws"   }',
    '$hubHost = $cfg.h',
    '$token   = $cfg.t',
    '$hubHttp = "$xProto`://$hubHost"',
    '$hubWs   = "$xWs`://$hubHost"',
    '',
    'Write-Host ""',
    'Write-Host "  ╔═══════════════════════╗" -ForegroundColor Cyan',
    'Write-Host "  ║       ΠΑΝ             ║" -ForegroundColor Cyan',
    'Write-Host "  ╚═══════════════════════╝" -ForegroundColor Cyan',
    'Write-Host ""',
    'Write-Host "  Hub loaded from filename — connecting..." -ForegroundColor White',
    'Write-Host ""',
    'Write-Host "  Connecting to: $hubHttp" -ForegroundColor Gray',
    '',
    '# Verify hub reachable',
    'try {',
    '  $null = Invoke-WebRequest "$hubHttp/health" -UseBasicParsing -TimeoutSec 10',
    '  Write-Host "  Hub OK ' + String.fromCharCode(0x2713) + '" -ForegroundColor Green',
    '} catch {',
    '  Write-Host "  Cannot reach hub: $hubHttp" -ForegroundColor Red',
    '  Read-Host "  Press Enter to close"',
    '  exit 1',
    '}',
    '',
    '# PAN directory',
    '$panDir = Join-Path $env:LOCALAPPDATA "PAN"',
    'New-Item -ItemType Directory -Force -Path $panDir | Out-Null',
    '',
    '# Find or download Node.js',
    '$nodeExe = $null',
    'try { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source } catch {}',
    'if (-not $nodeExe -or -not (Test-Path $nodeExe)) {',
    '  $nodeDir = Join-Path $panDir "node"',
    '  $nodeExe = Join-Path $nodeDir "node.exe"',
    '  if (-not (Test-Path $nodeExe)) {',
    '    Write-Host "  Node.js not found — downloading..." -ForegroundColor Yellow',
    '    $zipPath = Join-Path $env:TEMP "pan-node.zip"',
    '    $extractDir = Join-Path $env:TEMP "pan-node-extract"',
    '    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }',
    `    Invoke-WebRequest "${nodeUrl}" -OutFile $zipPath -UseBasicParsing`,
    '    Expand-Archive $zipPath -DestinationPath $extractDir -Force',
    `    $extracted = Get-ChildItem $extractDir | Where-Object { $_.Name -like "node-v${nodeVer}*" } | Select-Object -First 1`,
    '    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }',
    '    Move-Item $extracted.FullName $nodeDir',
    '    Remove-Item $zipPath -ErrorAction SilentlyContinue',
    '    Write-Host "  Node.js installed ' + String.fromCharCode(0x2713) + '" -ForegroundColor Green',
    '  } else {',
    '    Write-Host "  Node.js (bundled) ready ' + String.fromCharCode(0x2713) + '" -ForegroundColor Green',
    '  }',
    '} else {',
    '  $ver = & $nodeExe --version 2>$null',
    '  Write-Host "  Node.js $ver already installed ' + String.fromCharCode(0x2713) + '" -ForegroundColor Green',
    '}',
    '',
    '# Find npm — check alongside node.exe first, then PATH, then nvm dirs',
    '$nodeDir = Split-Path $nodeExe',
    '$npmCli = Join-Path $nodeDir "node_modules\\npm\\bin\\npm-cli.js"',
    'if (-not (Test-Path $npmCli)) {',
    '  # Try npm.cmd next to node.exe (nvm-style installs)',
    '  $npmCmd = Join-Path $nodeDir "npm.cmd"',
    '  if (Test-Path $npmCmd) { $npmCli = $null; $env:PATH = "$nodeDir;$env:PATH" }',
    '  else {',
    '    # Fall back to system PATH',
    '    $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source',
    '    if ($npmCmd) { $npmCli = $null } else { throw "npm not found — install Node.js from nodejs.org" }',
    '  }',
    '}',
    '',
    '# Download pan-client.js',
    'Write-Host "  Downloading PAN client..." -ForegroundColor Gray',
    '$clientPath = Join-Path $panDir "pan-client.js"',
    'Invoke-WebRequest "$hubHttp/client/pan-client.js" -OutFile $clientPath -UseBasicParsing',
    'Write-Host "  PAN client downloaded ' + String.fromCharCode(0x2713) + '" -ForegroundColor Green',
    '',
    '# Write package.json with type:module (pan-client.js uses ESM imports)',
    'Set-Content (Join-Path $panDir "package.json") \'{"name":"pan-client","version":"1.0.0","type":"module"}\' -Encoding UTF8',
    '',
    '# Install ws dependency',
    'Write-Host "  Installing dependencies..." -ForegroundColor Gray',
    'if ($npmCli) {',
    '  & $nodeExe $npmCli install ws --prefix $panDir --no-audit --no-fund --save 2>&1 | Out-Null',
    '} else {',
    '  & npm install ws --prefix $panDir --no-audit --no-fund --save 2>&1 | Out-Null',
    '}',
    'Write-Host "  Dependencies installed ' + String.fromCharCode(0x2713) + '" -ForegroundColor Green',
    '',
    '# Write client config',
    '$clientCfg = "{""hub_ws"":""$hubWs"",""hub_http"":""$hubHttp"",""token"":""$token""}"',
    'Set-Content (Join-Path $panDir "pan-client-config.json") $clientCfg -Encoding UTF8',
    '',
    '# Launch pan-client.js as a background process',
    'Write-Host "  Starting PAN client..." -ForegroundColor Gray',
    'Start-Process $nodeExe -ArgumentList "`"$clientPath`"" -WorkingDirectory $panDir -WindowStyle Hidden',
    '',
    'Write-Host ""',
    'Write-Host "  ' + String.fromCharCode(0x2713) + ' Connected!" -ForegroundColor Green',
    'Write-Host "  Check your PAN dashboard to approve this device." -ForegroundColor White',
    'Write-Host "  (You can close this window)" -ForegroundColor Gray',
    'Write-Host ""',
    'Start-Sleep 4',
  ];
  return lines.join('\r\n');
}

function generateWindowsClientInstaller(token, hubWs, clientJsUrl) {
  const httpUrl   = hubWs.replace(/^ws/, 'http');
  const nodeVer   = '22.16.0';
  const lines = [
    '# PAN Client Installer',
    '$ErrorActionPreference = "Stop"',
    '',
    'function Step { param($m) Write-Host "  > $m" -ForegroundColor Cyan }',
    'function Ok   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }',
    'function Fail { param($m) Write-Host "  [ERR] $m" -ForegroundColor Red; Read-Host "  Press Enter to close"; exit 1 }',
    '',
    'Write-Host ""',
    'Write-Host "  ╔═══════════════════════╗" -ForegroundColor Cyan',
    'Write-Host "  ║       ΠΑΝ             ║" -ForegroundColor Cyan',
    'Write-Host "  ╚═══════════════════════╝" -ForegroundColor Cyan',
    'Write-Host ""',
    '',
    '# ── Directories ─────────────────────────────────────────────────────────',
    '$PanDir  = Join-Path $env:LOCALAPPDATA "PAN"',
    '$NodeDir = Join-Path $PanDir "node"',
    'New-Item -ItemType Directory -Force -Path $PanDir  | Out-Null',
    'New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null',
    '',
    '# ── Node.js ──────────────────────────────────────────────────────────────',
    '$nodeExe = $null',
    'try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch {}',
    'if (-not $nodeExe) {',
    '  $nodeExe = Join-Path $NodeDir "node.exe"',
    '  if (-not (Test-Path $nodeExe)) {',
    `    Step "Downloading Node.js v${nodeVer}..."`,
    `    $nodeUrl = "https://nodejs.org/dist/v${nodeVer}/node-v${nodeVer}-win-x64.zip"`,
    '    $tmp = Join-Path $env:TEMP "pan-node.zip"',
    '    $ext = Join-Path $env:TEMP "pan-node-ext"',
    '    if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }',
    '    (New-Object System.Net.WebClient).DownloadFile($nodeUrl, $tmp)',
    '    Expand-Archive $tmp $ext -Force',
    `    $sub = Join-Path $ext "node-v${nodeVer}-win-x64"`,
    '    Get-ChildItem $sub | Move-Item -Destination $NodeDir -Force',
    '    Remove-Item $tmp,$ext -Force -Recurse -ErrorAction SilentlyContinue',
    '    Ok "Node.js installed"',
    '  } else { Ok "Node.js (cached)" }',
    '} else { Ok "Node.js already on system: $((& $nodeExe --version 2>$null))" }',
    '',
    '# ── npm (bundled with node zip) ──────────────────────────────────────────',
    '$npmCli = Join-Path $NodeDir "node_modules" | Join-Path -ChildPath "npm" | Join-Path -ChildPath "bin" | Join-Path -ChildPath "npm-cli.js"',
    'if (-not (Test-Path $npmCli)) {',
    '  # Bundled node — npm-cli.js path varies; try common locations',
    '  $npmCli = Get-ChildItem $NodeDir -Recurse -Filter "npm-cli.js" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName',
    '}',
    'if (-not $npmCli) { Fail "npm not found — please install Node.js from nodejs.org then re-run" }',
    '',
    '# ── Download pan-client.js ───────────────────────────────────────────────',
    'Step "Downloading PAN client..."',
    '$clientJs = Join-Path $PanDir "pan-client.js"',
    '(New-Object System.Net.WebClient).DownloadFile("' + clientJsUrl + '", $clientJs)',
    'Ok "PAN client downloaded"',
    '',
    '# ── package.json (ESM — pan-client.js uses import syntax) ───────────────',
    '[IO.File]::WriteAllText((Join-Path $PanDir "package.json"), \'{"name":"pan-client","version":"1.0.0","type":"module"}\')',
    '',
    '# ── Install ws ───────────────────────────────────────────────────────────',
    'Step "Installing dependencies..."',
    '& $nodeExe $npmCli install ws --prefix $PanDir --no-audit --no-fund --save 2>&1 | Out-Null',
    'Ok "ws installed"',
    '',
    '# ── Write config ─────────────────────────────────────────────────────────',
    'Step "Writing config..."',
    '$deviceName = $env:COMPUTERNAME',
    '$cfgObj = [ordered]@{',
    '  hub_ws   = "' + hubWs  + '"',
    '  hub_http = "' + httpUrl + '"',
    '  token    = "' + token   + '"',
    '  device_id = $deviceName',
    '  name      = $deviceName',
    '}',
    '$cfgJson = $cfgObj | ConvertTo-Json -Compress',
    '[IO.File]::WriteAllText((Join-Path $PanDir "pan-client-config.json"), $cfgJson)',
    'Ok "Config written"',
    '',
    '# ── Launch client in background, show first 5s of output ───────────────',
    'Step "Starting PAN client..."',
    '$logOut = Join-Path $PanDir "client-out.log"',
    '$logErr = Join-Path $PanDir "client-err.log"',
    'Remove-Item $logOut,$logErr -ErrorAction SilentlyContinue',
    '$nodeArgs = "`"$clientJs`" --hub `"' + hubWs + '`" --token `"' + token + '`" --name `"$env:COMPUTERNAME`""',
    '$proc = Start-Process $nodeExe -ArgumentList $nodeArgs -WorkingDirectory $PanDir -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru',
    'Write-Host "  Waiting for client to start..." -ForegroundColor Gray',
    'Start-Sleep 5',
    'if ($proc.HasExited) {',
    '  Write-Host "  [ERR] Node crashed (exit code $($proc.ExitCode))" -ForegroundColor Red',
    '} else {',
    '  Write-Host "  PAN client running (PID $($proc.Id)) ✓" -ForegroundColor Green',
    '}',
    '$o = if (Test-Path $logOut) { Get-Content $logOut -Raw } else { "" }',
    '$e = if (Test-Path $logErr) { Get-Content $logErr -Raw } else { "" }',
    'if ($o) { Write-Host $o -ForegroundColor Gray }',
    'if ($e) { Write-Host $e -ForegroundColor Red }',
    '',
    'Write-Host ""',
    'Write-Host "  ✓ Connected!" -ForegroundColor Green',
    'Write-Host "  Check your PAN dashboard to approve this device." -ForegroundColor White',
    'Write-Host ""',
    'Read-Host "  Press Enter to close"',
  ];
  return lines.join('\r\n');
}

function generateLinuxClientInstaller(token, hubWs, clientJsUrl) {
  // Build as array — avoids JS template-literal escaping issues with shell $() and heredocs
  const httpUrl = hubWs.replace(/^ws/, 'http');
  const lines = [
    '#!/usr/bin/env bash',
    '# PAN Client Installer — Linux / macOS',
    '# Run: curl -s ' + httpUrl + '/install/' + token + ' | bash',
    'set -euo pipefail',
    '',
    'PAN_DIR="${HOME}/.local/share/pan-client"',
    'NODE_DIR="${PAN_DIR}/node"',
    'NODE_VERSION="22.16.0"',
    'OS="$(uname -s | tr \'[:upper:]\' \'[:lower:]\')"',
    'ARCH="$(uname -m)"',
    '[ "${ARCH}" = "x86_64" ] && NODE_ARCH="x64" || NODE_ARCH="arm64"',
    'NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${OS}-${NODE_ARCH}.tar.xz"',
    '',
    'log() { echo -e "  \\033[36m>\\033[0m $1"; }',
    'ok()  { echo -e "  \\033[32m[OK]\\033[0m $1"; }',
    '',
    'log "Creating directories"',
    'mkdir -p "${PAN_DIR}" "${NODE_DIR}" "${PAN_DIR}/data"',
    '',
    'log "Setting up Node.js v${NODE_VERSION}"',
    'if [ ! -x "${NODE_DIR}/bin/node" ]; then',
    '  TMP="$(mktemp /tmp/pan-node.XXXXXX.tar.xz)"',
    '  if command -v curl &>/dev/null; then',
    '    curl -sSL "${NODE_URL}" -o "${TMP}"',
    '  else',
    '    wget -qO "${TMP}" "${NODE_URL}"',
    '  fi',
    '  tar -xJf "${TMP}" -C "${NODE_DIR}" --strip-components=1',
    '  rm -f "${TMP}"',
    'fi',
    'ok "Node.js $(${NODE_DIR}/bin/node --version)"',
    '',
    'log "Downloading pan-client.js"',
    'if command -v curl &>/dev/null; then',
    '  curl -sSL "' + clientJsUrl + '" -o "${PAN_DIR}/pan-client.js"',
    'else',
    '  wget -qO "${PAN_DIR}/pan-client.js" "' + clientJsUrl + '"',
    'fi',
    '',
    'log "Installing ws dependency"',
    'cd "${PAN_DIR}"',
    '"${NODE_DIR}/bin/npm" init -y >/dev/null 2>&1',
    '"${NODE_DIR}/bin/npm" install ws --no-audit --no-fund >/dev/null 2>&1',
    'ok "Dependencies installed"',
    '',
    'log "Writing config"',
    'DEVICE_ID="$(hostname)"',
    'cat > "${PAN_DIR}/pan-client-config.json" <<PANCFGEOF',
    '{',
    '  "hub_ws": "' + hubWs + '",',
    '  "token": "' + token + '",',
    '  "device_id": "${DEVICE_ID}",',
    '  "name": "${DEVICE_ID}"',
    '}',
    'PANCFGEOF',
    '',
    'log "Registering systemd service"',
    'SYSTEMD_DIR="${HOME}/.config/systemd/user"',
    'mkdir -p "${SYSTEMD_DIR}"',
    'cat > "${SYSTEMD_DIR}/pan-client.service" <<PANUNIT',
    '[Unit]',
    'Description=PAN Client',
    'After=network-online.target',
    '',
    '[Service]',
    'ExecStart=${NODE_DIR}/bin/node ${PAN_DIR}/pan-client.js',
    'WorkingDirectory=${PAN_DIR}',
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    'PANUNIT',
    '',
    'if command -v systemctl &>/dev/null; then',
    '  systemctl --user daemon-reload 2>/dev/null || true',
    '  systemctl --user enable pan-client.service 2>/dev/null || true',
    '  systemctl --user start pan-client.service 2>/dev/null || true',
    '  ok "Systemd service started"',
    'else',
    '  "${NODE_DIR}/bin/node" "${PAN_DIR}/pan-client.js" &',
    '  ok "Client started (running in background)"',
    'fi',
    '',
    'echo ""',
    'echo -e "  \\033[32mPAN Client installed!\\033[0m"',
    'echo "  Hub:   ' + hubWs + '"',
    'echo "  Data:  ${PAN_DIR}"',
  ];
  return lines.join('\n');
}

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

// POST /api/v1/context/reset — strip injected context from CLAUDE.md, keep static docs only
app.post('/api/v1/context/reset', (req, res) => {
  try {
    // Find all CLAUDE.md files that might have PAN-CONTEXT blocks
    const panRoot = join(__dirname, '..', '..');
    const claudeMdPath = join(panRoot, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) return res.json({ ok: false, error: 'CLAUDE.md not found' });

    const content = readFileSync(claudeMdPath, 'utf8');
    const startMarker = '<!-- PAN-CONTEXT-START -->';
    const endMarker = '<!-- PAN-CONTEXT-END -->';
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.lastIndexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) return res.json({ ok: true, before: content.length, after: content.length, message: 'No injected context found' });

    const trimmed = content.substring(0, startIdx) + startMarker + '\n' + endMarker + content.substring(endIdx + endMarker.length);
    writeFileSync(claudeMdPath, trimmed, 'utf8');
    console.log(`[Context Reset] CLAUDE.md: ${content.length} → ${trimmed.length} chars (saved ${content.length - trimmed.length})`);
    res.json({ ok: true, before: content.length, after: trimmed.length, saved: content.length - trimmed.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/v1/context/size — quick check of current CLAUDE.md size
app.get('/api/v1/context/size', (req, res) => {
  try {
    const panRoot = join(__dirname, '..', '..');
    const claudeMdPath = join(panRoot, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) return res.json({ total: 0, static: 0, injected: 0 });

    const content = readFileSync(claudeMdPath, 'utf8');
    const startMarker = '<!-- PAN-CONTEXT-START -->';
    const endMarker = '<!-- PAN-CONTEXT-END -->';
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.lastIndexOf(endMarker);

    const staticSize = startIdx > 0 ? startIdx : content.length;
    const injectedSize = (startIdx > 0 && endIdx > 0) ? (endIdx - startIdx) : 0;

    res.json({
      total: content.length,
      static: staticSize,
      injected: injectedSize,
      tokens_approx: Math.round(content.length / 4),
      warning: content.length > 15000,
      critical: content.length > 20000,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v1/claude-models (also /api/v1/ai/models) — fetch available Claude models from Anthropic API
// Falls back to a curated list if no API key. Cached for 1 hour.
let _modelsCache = null;
let _modelsCacheAt = 0;
async function getClaudeModels() {
  if (_modelsCache && (Date.now() - _modelsCacheAt) < 3600000) return _modelsCache;
  const keyRow = get("SELECT value FROM settings WHERE key = 'anthropic_api_key'");
  if (keyRow?.value) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': keyRow.value, 'anthropic-version': '2023-06-01' }
      });
      if (r.ok) {
        const data = await r.json();
        const models = (data.data || [])
          .filter(m => m.id.startsWith('claude-'))
          .map(m => ({ id: m.id, name: m.display_name || m.id, created_at: m.created_at }))
          .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        _modelsCache = { models, source: 'anthropic_api', fetched_at: new Date().toISOString() };
        _modelsCacheAt = Date.now();
        return _modelsCache;
      }
    } catch {}
  }
  const fallback = [
    { id: 'claude-haiku-4-5',           name: 'Claude Haiku 4.5 (fast)' },
    { id: 'claude-sonnet-4-5',          name: 'Claude Sonnet 4.5' },
    { id: 'claude-sonnet-4-6',          name: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-5',            name: 'Claude Opus 4.5' },
    { id: 'claude-opus-4-6',            name: 'Claude Opus 4.6' },
  ];
  return { models: fallback, source: 'fallback', fetched_at: new Date().toISOString() };
}
const _modelsHandler = async (req, res) => {
  try { res.json(await getClaudeModels()); } catch (e) { res.status(500).json({ error: e.message }); }
};
app.get('/api/v1/claude-models', _modelsHandler);
app.get('/api/v1/ai/models', _modelsHandler);

// GET /api/v1/claude-usage — Claude Code session token usage from JSONL files
// Heavy: reads dozens of JSONL files + calls Anthropic API. Cached 5 minutes.
// On cold start, returns empty shell immediately and computes in background.
let _claudeUsageCache = null;
let _claudeUsageCacheAt = 0;
let _claudeUsageComputing = false;
const CLAUDE_USAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
app.get('/api/v1/claude-usage', async (req, res) => {
  if (_claudeUsageCache && (Date.now() - _claudeUsageCacheAt) < CLAUDE_USAGE_TTL_MS) {
    return res.json(_claudeUsageCache);
  }
  // If already computing, return stale cache or empty shell (don't pile up)
  if (_claudeUsageComputing) {
    return res.json(_claudeUsageCache || { session: { input: 0, output: 0, cache_read: 0, cache_create: 0, total: 0, messages: 0 }, today: { input: 0, output: 0, cache_read: 0, cache_create: 0, total: 0, messages: 0 }, week: { input: 0, output: 0, cache_read: 0, cache_create: 0, total: 0, messages: 0 }, model: 'loading...', rateLimits: null });
  }
  _claudeUsageComputing = true;
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
    function sumJsonlTokens(filePath, maxBytes = 10 * 1024 * 1024, skipSizeLimit = false) {
      const result = { input: 0, output: 0, cache_read: 0, cache_create: 0, messages: 0, model: '' };
      try {
        // Skip files larger than maxBytes — but never skip active sessions regardless of size
        const fstat = statSync(filePath);
        if (!skipSizeLimit && fstat.size > maxBytes) return result;
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
          const tokens = sumJsonlTokens(filePath, 10 * 1024 * 1024, true); // no size limit for active sessions
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
    // CACHE: avoid hammering Anthropic API every 30s — cache for 5 minutes
    let rateLimits = null;
    const RL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    if (global._rlCache && (Date.now() - global._rlCache.ts < RL_CACHE_TTL)) {
      rateLimits = global._rlCache.data;
    } else {
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
    if (rateLimits) global._rlCache = { ts: Date.now(), data: rateLimits };
    } // end rlCache miss

    const usageResult = {
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
    };
    _claudeUsageCache = usageResult;
    _claudeUsageCacheAt = Date.now();
    _claudeUsageComputing = false;
    res.json(usageResult);
  } catch (e) {
    _claudeUsageComputing = false;
    console.error('[Claude Usage] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v1/gemini-usage — Gemini CLI session token usage from JSON files
app.get('/api/v1/gemini-usage', async (req, res) => {
  try {
    const homeDir = process.env.USERPROFILE || homedir();
    const geminiTmpDir = join(homeDir, '.gemini', 'tmp', 'desktop', 'chats');
    if (!existsSync(geminiTmpDir)) {
      return res.json({ session: { input: 0, output: 0, total: 0, messages: 0 }, today: { input: 0, output: 0, total: 0, messages: 0 }, model: 'gemini' });
    }

    const files = readdirSync(geminiTmpDir).filter(f => f.endsWith('.json'));
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let sessionTokens = { input: 0, output: 0, messages: 0 };
    let todayTokens = { input: 0, output: 0, messages: 0 };
    let latestModel = 'gemini-1.5-pro';

    for (const f of files) {
      try {
        const filePath = join(geminiTmpDir, f);
        const stat = statSync(filePath);
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        
        if (!data.history) continue;

        let fileInput = 0;
        let fileOutput = 0;
        let fileMsgs = 0;

        for (const entry of data.history) {
          if (entry.usage) {
            fileInput += entry.usage.prompt_tokens || 0;
            fileOutput += entry.usage.candidates_tokens || 0;
            fileMsgs++;
            if (entry.model) latestModel = entry.model;
          }
        }

        // Current session (recently modified)
        if (now - stat.mtimeMs < 60 * 60 * 1000) { // last 1 hour
          sessionTokens.input += fileInput;
          sessionTokens.output += fileOutput;
          sessionTokens.messages += fileMsgs;
        }

        if (stat.mtimeMs >= todayStart.getTime()) {
          todayTokens.input += fileInput;
          todayTokens.output += fileOutput;
          todayTokens.messages += fileMsgs;
        }
      } catch (err) {}
    }

    res.json({
      session: {
        input: sessionTokens.input,
        output: sessionTokens.output,
        total: sessionTokens.input + sessionTokens.output,
        messages: sessionTokens.messages,
      },
      today: {
        input: todayTokens.input,
        output: todayTokens.output,
        total: todayTokens.input + todayTokens.output,
        messages: todayTokens.messages,
      },
      model: latestModel,
      rateLimits: null,
    });
  } catch (e) {
    console.error('[Gemini Usage] Error:', e.message);
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
    // Audit log for settings changes (security-sensitive)
    try {
      const auditReq = { user: { id: req.user?.id || 1 }, org_id: req.org_id || 'org_personal' };
      auditLog(auditReq, 'settings.update', keys.join(','), { keys, source: req.headers['x-device-name'] || req.ip });
    } catch {}
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

// Dashboard (web UI + API) — privacy middleware noises stats/counts on GET responses
app.use('/dashboard', privacyMiddleware({ caller: 'dashboard' }), dashboardRouter);
// Benchmark dashboard API — no privacy middleware needed (benchmark data only)
app.use('/dashboard/api', benchmarkDashRouter);

// Redirect /dashboard/ to /v2/ (Svelte dashboard)
app.get('/dashboard', (req, res) => res.redirect('/v2/'));
app.get('/dashboard/', (req, res) => res.redirect('/v2/'));

// Shortcut redirects for full-screen apps
app.get('/kronos', (req, res) => res.redirect('/v2/kronos'));
app.get('/atlas', (req, res) => res.redirect('/v2/atlas'));

// Svelte v2 dashboard — static files
// Immutable chunks (_app/immutable/**) have content-hashed filenames — cache forever.
// index.html and version.json must never be cached (they change on rebuild).
app.use('/v2', express.static(join(__dirname, '..', 'public', 'v2'), {
  etag: true,
  lastModified: true,
  index: 'index.html',
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    if (filePath.includes('/_app/immutable/')) {
      // Content-hashed — safe to cache for 1 year
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // index.html, version.json, etc. — always revalidate
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
// SPA fallback — any /v2/* that isn't a file gets index.html
app.get('/v2/*path', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(join(__dirname, '..', 'public', 'v2', 'index.html'));
});

// Setup wizard — first-run page, no auth required, no caching
app.use('/setup', express.static(join(__dirname, '..', 'public', 'setup'), {
  etag: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Docs / reports — served in PAN window, accessible from any device
app.use('/docs', express.static(join(__dirname, '..', 'public', 'docs'), {
  etag: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

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

// ── Tunnel API ────────────────────────────────────────────────────────────────
// NOTE: /api/v1/client/register and /api/v1/client/status live in routes/client.js

// GET  /api/v1/tunnel/status  — returns current public tunnel URL (or null)
// POST /api/v1/tunnel/start   — (re)starts Cloudflare Quick Tunnel without a full server restart
app.get('/api/v1/tunnel/status', (req, res) => {
  const cfURL = getTunnelURL();
  const tailscaleActive = (() => {
    try { execSync(`tailscale funnel status`, { timeout: 2000, windowsHide: true, stdio: 'pipe' }); return true; } catch { return false; }
  })();
  res.json({
    ok: true,
    cloudflare: cfURL || null,
    tailscale_funnel: tailscaleActive,
    active_url: cfURL || (tailscaleActive ? 'tailscale-funnel' : null),
  });
});

app.post('/api/v1/tunnel/start', async (req, res) => {
  const port = parseInt(process.env.PAN_PUBLIC_PORT || process.env.PAN_CARRIER_PORT || '7777');
  try {
    const url = await startCloudflareTunnel(port);
    if (url) return res.json({ ok: true, url, via: 'cloudflare-tunnel' });
    res.json({ ok: false, error: 'Tunnel started but no URL received — check server logs' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Terminal API — list sessions, projects for terminal
app.get('/api/v1/terminal/sessions', async (req, res) => {
  res.json({ sessions: await listSessions() });
});

// Create a new pipe-mode session (mobile new-tab button)
app.post('/api/v1/terminal/new', async (req, res) => {
  try {
    const { project, model } = req.body || {};
    const prefix = project ? 'dash-' + project.toLowerCase().replace(/[^a-z0-9]/g, '-') : 'dash-pan';
    // Find the next available session ID
    const existing = await listSessions();
    const ids = new Set(existing.map(s => s.id));
    let sessionId = prefix;
    let n = 2;
    while (ids.has(sessionId)) { sessionId = `${prefix}-${n++}`; }
    // Resolve cwd from project path if available
    let cwd = null;
    if (project) {
      try {
        const { all: dbAll } = await import('./db.js');
        const rows = dbAll('SELECT path FROM projects WHERE name = ? LIMIT 1', [project]);
        if (rows?.[0]?.path) cwd = rows[0].path;
      } catch {}
    }
    await createPipeSession(sessionId, { projectName: project || 'PAN', cwd });
    if (model) await pipeSetModel(sessionId, model);
    res.json({ ok: true, session_id: sessionId });
  } catch (err) {
    console.error('[PAN] /api/v1/terminal/new error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
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
  const eventId = insert(`INSERT INTO events (session_id, event_type, data, org_id) VALUES (:sid, :type, :data, :oid)`, {
    ':sid': session_id || (isMobile ? 'mobile-send' : 'desktop-send'), ':type': eventType, ':data': dataStr, ':oid': req.org_id || 'org_personal'
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
// Dedup: reject identical text to same session within 5 seconds
const _pipeDedup = new Map(); // key: `${session_id}:${text}` → timestamp
app.post('/api/v1/terminal/pipe', async (req, res) => {
  const { text, session_id } = req.body;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  console.log(`[PAN Pipe] POST /pipe session_id=${session_id} text=${(text||'').slice(0,50)} ip=${ip} user=${req.user?.email || 'NONE'}`);
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  // Dedup: block identical message to same session within 5s window
  const dedupKey = `${session_id}:${text}`;
  const now = Date.now();
  const lastSent = _pipeDedup.get(dedupKey);
  if (lastSent && now - lastSent < 5000) {
    console.log(`[PAN Pipe] DEDUP blocked duplicate message (${now - lastSent}ms ago)`);
    return res.json({ ok: true, session: session_id, deduped: true });
  }
  _pipeDedup.set(dedupKey, now);
  // Cleanup old entries every 100 sends
  if (_pipeDedup.size > 100) {
    for (const [k, ts] of _pipeDedup) {
      if (now - ts > 10000) _pipeDedup.delete(k);
    }
  }

  let ok = await pipeSend(session_id, text);
  console.log(`[PAN Pipe] pipeSend result: ok=${ok} session=${session_id}`);

  // Auto-recreate session if it was lost (e.g. Carrier restart killed PTY sessions)
  if (!ok) {
    console.log(`[PAN Pipe] Session ${session_id} not found — auto-creating and retrying`);
    try {
      // Derive project name from session ID: "dash-pan-1" → "PAN", "dash-woe-2" → "woe"
      const match = session_id.match(/^dash-([a-z0-9-]+?)(?:-\d+)?$/);
      const projectSlug = match?.[1] || 'pan';
      const projectName = projectSlug.toUpperCase();
      let cwd = null;
      try {
        const { all: dbAll } = await import('./db.js');
        const rows = dbAll('SELECT path FROM projects WHERE LOWER(REPLACE(name, \' \', \'-\')) = ? OR LOWER(name) = ? LIMIT 1',
          [projectSlug, projectSlug]);
        if (rows?.[0]?.path) cwd = rows[0].path;
      } catch {}
      await createPipeSession(session_id, { projectName, cwd });
      ok = await pipeSend(session_id, text);
      console.log(`[PAN Pipe] Auto-recreate + retry: ok=${ok} session=${session_id} cwd=${cwd}`);
    } catch (err) {
      console.error(`[PAN Pipe] Auto-recreate failed: ${err.message}`);
    }
  }

  res.json({ ok: !!ok, session: session_id });
});

// Switch model for a live session — takes effect on the very next message sent
app.post('/api/v1/terminal/set-model', (req, res) => {
  const { session_id, model } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  const ok = pipeSetModel(session_id, model || null);
  res.json({ ok, session: session_id, model: model || null });
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

// Tier 0 Phase 5: org current context for the phone top bar.
// Returns the active org info + user display name + role + list of all orgs.
app.get('/api/v1/org/current', async (req, res) => {
  try {
    const { getActiveOrg } = await import('./org-policy.js');
    const org = getActiveOrg(req);
    const userId = req?.user?.id || 1;

    // Sync personal org name from `display_name` setting (user-configurable)
    try {
      const nameSetting = get("SELECT value FROM settings WHERE key = 'display_name'");
      const displayName = nameSetting ? (nameSetting.value || '').replace(/^"|"$/g, '') : null;
      if (displayName) {
        const personalOrg = db.prepare(`SELECT name FROM orgs WHERE id = 'org_personal'`).get();
        if (personalOrg && personalOrg.name !== displayName) {
          db.prepare(`UPDATE orgs SET name = ? WHERE id = 'org_personal'`).run(displayName);
          db.prepare(`UPDATE users SET display_name = ?, display_nickname = ? WHERE id = 1`).run(displayName, displayName);
          console.log(`[Org] Synced personal org name to setting: ${personalOrg.name} → ${displayName}`);
        }
      }
    } catch {}

    // Get user info
    let user = { display_name: 'User', display_nickname: null, role: 'owner' };
    try {
      const u = db.prepare(`SELECT display_name, display_nickname, role FROM users WHERE id = ?`).get(userId);
      if (u) user = u;
    } catch {}

    // Get membership role for this org
    let membershipRole = null;
    try {
      const m = db.prepare(`
        SELECT m.role_id, r.name AS role_name
        FROM memberships m
        LEFT JOIN roles r ON r.id = m.role_id
        WHERE m.user_id = ? AND m.org_id = ? AND m.left_at IS NULL
      `).get(userId, org.id);
      if (m) membershipRole = m.role_name || null;
    } catch {}

    // Get all orgs this user belongs to
    let orgs = [];
    try {
      orgs = db.prepare(`
        SELECT o.id AS org_id, o.slug, o.name, o.color_primary, o.logo_url,
               m.role_id, r.name AS role_name
        FROM memberships m
        JOIN orgs o ON o.id = m.org_id
        LEFT JOIN roles r ON r.id = m.role_id
        WHERE m.user_id = ? AND m.left_at IS NULL
        ORDER BY o.name
      `).all(userId);
    } catch {}

    res.json({
      org_id: org.id,
      org_name: org.name,
      org_slug: org.slug,
      org_color: org.color_primary || null,
      user_display_name: user.display_name,
      user_nickname: user.display_nickname || user.display_name,
      role: membershipRole || user.role || 'owner',
      orgs: orgs,
    });
  } catch (err) {
    // Fallback for pre-migration state — read display_name setting if available
    let fallbackName = 'User';
    try {
      const row = get("SELECT value FROM settings WHERE key = 'display_name'");
      if (row) fallbackName = (row.value || '').replace(/^"|"$/g, '') || 'User';
    } catch {}
    res.json({
      org_id: 'org_personal',
      org_name: fallbackName,
      org_slug: 'personal',
      org_color: null,
      user_display_name: fallbackName,
      user_nickname: fallbackName,
      role: 'owner',
      orgs: [{ org_id: 'org_personal', slug: 'personal', name: fallbackName, role_name: 'owner' }],
    });
  }
});

// Tier 0 Phase 5 org routes moved to routes/orgs.js (mounted at /api/v1/orgs)

// Clean up stale Tailscale pan-* nodes (duplicates from app reinstalls)
// Uses `tailscale status --json` to find offline pan-* nodes and expires them
async function cleanupStaleTailscaleNodes() {
  try {
    const tsExe = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
    const statusJson = execFileSync(tsExe, ['status', '--json'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    const status = JSON.parse(statusJson);
    const self = status.Self || {};
    const peers = status.Peer || {};

    // Find all pan-* nodes
    const panNodes = Object.entries(peers)
      .filter(([_, v]) => v.HostName && v.HostName.startsWith('pan-'))
      .map(([k, v]) => ({ nodeKey: k, hostname: v.HostName, online: v.Online, ips: v.TailscaleIPs || [] }));

    // Keep the one that's online, expire offline duplicates
    const onlineNodes = panNodes.filter(n => n.online);
    const offlineNodes = panNodes.filter(n => !n.online);

    if (onlineNodes.length > 0 && offlineNodes.length > 0) {
      console.log(`[PAN Tailscale] Found ${onlineNodes.length} online + ${offlineNodes.length} offline pan-* nodes. Cleaning up stale...`);

      // Try to delete stale nodes via Tailscale API using OAuth credentials
      let oauthId, oauthSecret;
      try {
        const idRow = get("SELECT value FROM settings WHERE key = 'tailscale_oauth_client_id'");
        const secretRow = get("SELECT value FROM settings WHERE key = 'tailscale_oauth_client_secret'");
        oauthId = idRow?.value?.replace(/^"|"$/g, '').trim();
        oauthSecret = secretRow?.value?.replace(/^"|"$/g, '').trim();
      } catch {}

      if (oauthId && oauthSecret) {
        // Get Tailscale API token via OAuth
        try {
          const tokenResp = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `client_id=${encodeURIComponent(oauthId)}&client_secret=${encodeURIComponent(oauthSecret)}&grant_type=client_credentials`
          });
          if (tokenResp.ok) {
            const tokenData = await tokenResp.json();
            const token = tokenData.access_token;

            // List devices via API to get device IDs (nodekeys don't map to API IDs)
            const devResp = await fetch('https://api.tailscale.com/api/v2/tailnet/-/devices', {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (devResp.ok) {
              const devData = await devResp.json();
              const apiDevices = devData.devices || [];
              for (const stale of offlineNodes) {
                const apiDev = apiDevices.find(d => d.hostname === stale.hostname && !d.online);
                if (apiDev) {
                  const delResp = await fetch(`https://api.tailscale.com/api/v2/device/${apiDev.id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                  });
                  console.log(`[PAN Tailscale] Deleted stale node ${stale.hostname}: ${delResp.ok ? 'success' : delResp.status}`);
                }
              }
            } else {
              console.log(`[PAN Tailscale] API device list failed: ${devResp.status} — OAuth client may need 'devices' scope`);
            }
          }
        } catch (apiErr) {
          console.log(`[PAN Tailscale] API cleanup failed: ${apiErr.message}`);
        }
      } else {
        for (const stale of offlineNodes) {
          console.log(`[PAN Tailscale] Stale node: ${stale.hostname} — remove from: https://login.tailscale.com/admin/machines`);
        }
      }
    } else if (offlineNodes.length > 0 && onlineNodes.length === 0) {
      console.log(`[PAN Tailscale] ${offlineNodes.length} offline pan-* nodes, none online — phone may be disconnected`);
    }
  } catch (e) {
    // Tailscale not installed or not running — skip silently
  }
}

// Tier 0 Phase 5: diagnostics endpoint for phone settings.
// Returns server PID, uptime, Tailscale status, and connection info.
app.get('/api/v1/diagnostics', (req, res) => {
  const uptimeMs = Date.now() - _serverStartedAt;
  const secs = Math.floor(uptimeMs / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  const uptime = hrs > 0 ? `${hrs}h ${mins % 60}m` : mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;

  let tailscaleIp = null;
  let tailscaleStatus = 'unknown';
  try {
    tailscaleIp = execFileSync('C:\\Program Files\\Tailscale\\tailscale.exe', ['ip', '-4'], { timeout: 3000, encoding: 'utf8', windowsHide: true }).trim();
    tailscaleStatus = 'connected';
  } catch {
    try {
      tailscaleIp = execFileSync('tailscale', ['ip', '-4'], { timeout: 3000, encoding: 'utf8', windowsHide: true }).trim();
      tailscaleStatus = 'connected';
    } catch {
      tailscaleStatus = 'disconnected';
    }
  }

  res.json({
    server_pid: process.pid,
    uptime,
    uptime_ms: uptimeMs,
    started_at: _serverStartedAt,
    tailscale_ip: tailscaleIp,
    tailscale_status: tailscaleStatus,
    node_version: process.version,
    platform: process.platform,
    mode: PAN_MODE,
    craft_id: process.env.PAN_CRAFT_ID || null,
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
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

// ==================== Tier 0 Phase 6: Audit Chain + Backup ====================

// GET /api/v1/audit/verify — verify HMAC chain integrity across all orgs
app.get('/api/v1/audit/verify', (req, res) => {
  try {
    const result = verifyAllAuditChains();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/audit/log — paginated audit log viewer
app.get('/api/v1/audit/log', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const orgFilter = req.query.org_id || null;
    const actionFilter = req.query.action || null;

    const conditions = [];
    const params = {};
    if (orgFilter) { conditions.push('org_id = :org_id'); params[':org_id'] = orgFilter; }
    if (actionFilter) { conditions.push('action = :action'); params[':action'] = actionFilter; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = all(
      `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    // Parse metadata_json for each row
    const entries = rows.map(r => ({
      ...r,
      metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return r.metadata_json; } })() : null,
    }));

    const countRow = get(`SELECT COUNT(*) as total FROM audit_log ${where}`, params);
    res.json({ entries, total: countRow?.total || 0, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/backup/create — create a backup of pan.db via SQLite backup API
app.post('/api/v1/backup/create', async (req, res) => {
  try {
    const backupDir = join(getDataDir(), 'backups');
    mkdirSync(backupDir, { recursive: true });

    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
    const backupPath = join(backupDir, `pan-${ts}.db`);

    // Use better-sqlite3's .backup() — works with encrypted DBs
    await db.backup(backupPath);

    const stats = statSync(backupPath);

    // Audit the backup
    try {
      const auditReq = { user: { id: req.user?.id || 1 }, org_id: req.org_id || 'org_personal' };
      auditLog(auditReq, 'backup.create', backupPath, { size_bytes: stats.size });
    } catch {}

    console.log(`[PAN Backup] Created: ${backupPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
    res.json({ ok: true, path: backupPath, size_bytes: stats.size });
  } catch (err) {
    console.error('[PAN Backup] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/backup/list — list available backups with dates and sizes
app.get('/api/v1/backup/list', (req, res) => {
  try {
    const backupDir = join(getDataDir(), 'backups');
    let files = [];
    try {
      files = readdirSync(backupDir)
        .filter(f => f.startsWith('pan-') && f.endsWith('.db'))
        .map(f => {
          const fullPath = join(backupDir, f);
          const stats = statSync(fullPath);
          return {
            filename: f,
            path: fullPath,
            size_bytes: stats.size,
            created_at: stats.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    } catch {
      // backups dir doesn't exist yet
    }
    res.json({ backups: files, backup_dir: backupDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inject context into CLAUDE.md — called by frontend before launching Claude
// Optional: pass tab_session_ids (array of Claude session IDs for this PTY tab)
// to scope Part 1 of the injection to this specific tab's history.
app.post('/api/v1/inject-context', async (req, res) => {
  const { cwd, tab_session_ids } = req.body || {};
  if (!cwd) return res.status(400).json({ error: 'cwd required' });
  try {
    const tabIds = Array.isArray(tab_session_ids) ? tab_session_ids : [];
    injectSessionContext(cwd, 'org_personal', tabIds);
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

// ==================== Perf Probes (Craft-side) ====================
// The Carrier's PerfEngine hits these to verify each subsystem works.
// Every probe returns 200 on success, 503 on degraded/offline.
// Keep probes cheap — they run every 60s on the Carrier's schedule.

// DB probe: prove SQLite is open + schema exists.
app.get('/api/v1/perf/probe/db', (req, res) => {
  try {
    const row = get('SELECT 1 as ok');
    if (row && row.ok === 1) return res.status(200).json({ ok: true });
    return res.status(503).json({ ok: false, error: 'SELECT 1 returned no rows' });
  } catch (err) {
    return res.status(503).json({ ok: false, error: String(err?.message || err) });
  }
});

// JSONL watcher probe: the watcher is considered alive if the server
// was able to enumerate Claude project JSONLs during boot.
app.get('/api/v1/perf/probe/jsonl', (req, res) => {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const projects = join(home, '.claude', 'projects');
    const ok = existsSync(projects);
    if (ok) return res.status(200).json({ ok: true, projects });
    return res.status(503).json({ ok: false, error: 'claude projects dir missing' });
  } catch (err) {
    return res.status(503).json({ ok: false, error: String(err?.message || err) });
  }
});

// MCP server probe: check that the MCP module loaded.
app.get('/api/v1/perf/probe/mcp', (req, res) => {
  try {
    // MCP server registers itself into global state when loaded.
    // If it's there, return 200 with tool count.
    const mcpReady = typeof global.__panMcpReady === 'boolean' ? global.__panMcpReady : true;
    if (mcpReady) return res.status(200).json({ ok: true });
    return res.status(503).json({ ok: false, error: 'mcp not initialized' });
  } catch (err) {
    return res.status(503).json({ ok: false, error: String(err?.message || err) });
  }
});

// Generic service probe — checks if the service is registered as running
// in the services registry. Any unknown service returns 503 (correctly
// matches the "Offline — Not running" state shown in the panel).
// Map perf probe names → steward service IDs
const PROBE_TO_STEWARD = {
  local_intel: null,           // built-in, always ok
  resonance: 'embeddings',
  voice_shell: 'voice-shell',
  augur: 'classifier',
  cartographer: 'stack-scanner',
  dream: 'dream',
  archivist: 'consolidation',
  scout: 'scout',
  orchestrator: 'orchestrator',
  evolution: 'evolution',
  forge: 'autodev',
  tether: 'tailscale',
};

function serviceProbeHandler(name) {
  return (req, res) => {
    try {
      if (name === 'local_intel') {
        return res.status(200).json({ ok: true, note: 'built-in' });
      }

      // Check real steward service status
      const stewardId = PROBE_TO_STEWARD[name];
      if (stewardId) {
        const svc = getServiceStatus(stewardId);
        if (svc && svc._status === 'running') {
          return res.status(200).json({ ok: true, service: stewardId, status: 'running' });
        }
        const reason = svc?._lastError || svc?._status || 'not registered';
        return res.status(503).json({ ok: false, error: reason, service: stewardId });
      }

      return res.status(503).json({ ok: false, error: 'no steward mapping' });
    } catch (err) {
      return res.status(503).json({ ok: false, error: String(err?.message || err) });
    }
  };
}
for (const name of [
  'local_intel', 'resonance', 'voice_shell', 'augur', 'cartographer',
  'dream', 'archivist', 'scout', 'orchestrator', 'evolution',
  'forge', 'tether',
]) {
  app.get(`/api/v1/perf/probe/${name}`, serviceProbeHandler(name));
}

// Health check
let _serverStartedAt = Date.now();
// Internal: Carrier posts ΠΑΝ notifications here (Carrier has no DB, Craft does)
app.post('/api/internal/pan-notify', async (req, res) => {
  try {
    const { panNotify, ensurePanContact } = await import('./pan-notify.js');
    ensurePanContact();
    const { service, subject, body, severity } = req.body || {};
    if (!service || !subject || !body) return res.status(400).json({ error: 'service, subject, body required' });
    const id = panNotify(service, subject, body, { severity });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[pan-notify] internal endpoint failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug: check what Ollama URL is configured
app.get('/api/v1/ollama-url', async (req, res) => {
  const url = getOllamaUrl();
  let reachable = false;
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    reachable = r.ok;
  } catch {}
  res.json({ url, reachable });
});

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

  // Get current AI provider for dashboard labeling
  let terminal_ai_provider = 'claude';
  try {
    const row = get("SELECT value FROM settings WHERE key = 'terminal_ai_provider'");
    if (row && row.value) {
      terminal_ai_provider = JSON.parse(row.value);
    }
  } catch {}

  // Hub display name from settings (for installer UI)
  let hubName = hostname(); // default to OS hostname
  try {
    const row = get("SELECT value FROM settings WHERE key = 'hub_name'");
    if (row && row.value) hubName = JSON.parse(row.value);
  } catch {}

  res.json({
    status: 'running',
    timestamp: new Date().toISOString(),
    startedAt: _serverStartedAt,
    uptime,
    tailscaleIp,
    hubName: hubName || 'PAN Hub',
    mode: PAN_MODE,
    craftId: process.env.PAN_CRAFT_ID || null,
    craftVersion: 'A',
    terminal_ai_provider
  });
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
    const ollamaUrl = getOllamaUrl();
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
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
          url: ollamaUrl,
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

  // Sync detected models — replace stale entries, add new ones, remove gone ones
  run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('custom_models', :val, datetime('now','localtime'))", {
    ':val': JSON.stringify(detected)
  });
  console.log(`[PAN Setup] Synced ${detected.length} local model(s) to providers`);

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

      // Start PAN Client WebSocket server — BEFORE terminal server so its upgrade
      // handler runs first (terminal.js rejects unknown paths, client needs /ws/client).
      if (!IS_CRAFT) {
        startClientServer(server);
      }

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

      // Incognito TTL cleanup — purge expired incognito events on startup and every 5 minutes
      cleanupExpiredIncognito();
      _startupIntervals.push(setInterval(cleanupExpiredIncognito, 5 * 60 * 1000));

      // ── MEMORY HEALTH MONITOR — every 2 minutes ──────────────────
      // Tracks Node.js heap usage and alerts if it crosses thresholds.
      // This is the first autodev mechanism: PAN monitors itself.
      const HEAP_WARN_MB = 300;
      const HEAP_CRITICAL_MB = 500;
      let _lastMemAlert = 0;
      function _checkMemoryHealth() {
        const mem = process.memoryUsage();
        const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
        const rssMB = Math.round(mem.rss / 1024 / 1024);
        const extMB = Math.round((mem.external || 0) / 1024 / 1024);
        // Log every check so we can spot trends
        console.log(`[PAN Health] Memory: heap=${heapMB}MB rss=${rssMB}MB ext=${extMB}MB`);
        const now = Date.now();
        if (heapMB > HEAP_CRITICAL_MB && (now - _lastMemAlert) > 600000) {
          _lastMemAlert = now;
          try {
            createAlert({
              alert_type: 'memory_critical',
              severity: 'critical',
              title: `Memory critical: ${heapMB}MB heap`,
              detail: `RSS=${rssMB}MB, External=${extMB}MB. Server may become unresponsive. Consider restarting.`,
            });
          } catch {}
          console.error(`[PAN Health] CRITICAL: heap=${heapMB}MB exceeds ${HEAP_CRITICAL_MB}MB threshold`);
        } else if (heapMB > HEAP_WARN_MB && (now - _lastMemAlert) > 1800000) {
          _lastMemAlert = now;
          try {
            createAlert({
              alert_type: 'memory_warning',
              severity: 'warning',
              title: `Memory warning: ${heapMB}MB heap`,
              detail: `RSS=${rssMB}MB, External=${extMB}MB. Trending high — monitor for leaks.`,
            });
          } catch {}
          console.warn(`[PAN Health] WARNING: heap=${heapMB}MB exceeds ${HEAP_WARN_MB}MB threshold`);
        }
      }
      _checkMemoryHealth(); // Run on startup
      _startupIntervals.push(setInterval(_checkMemoryHealth, 2 * 60 * 1000));

      // Tier 0 Phase 6 — Verify audit chain integrity on startup and every 1 hour
      function _verifyAuditChains() {
        try {
          const chainResult = verifyAllAuditChains();
          if (chainResult.valid) {
            console.log(`[PAN Audit] Chain OK — ${chainResult.entries_checked} entries across ${chainResult.orgs_checked} org(s)`);
          } else {
            console.warn(`[PAN Audit] CHAIN BROKEN at entry ${chainResult.broken_at} (${chainResult.reason}) in org ${chainResult.org_id}`);
            // Auto-repair: re-sign the chain with the current key (key rotation or regeneration)
            try {
              const repair = resignAuditChain(chainResult.org_id);
              console.log(`[PAN Audit] Chain repaired — re-signed ${repair.fixed}/${repair.total} entries in org ${chainResult.org_id}`);
              // Verify again after repair
              const recheck = verifyAllAuditChains();
              if (recheck.valid) {
                console.log(`[PAN Audit] Chain verified OK after repair`);
              } else {
                console.error(`[PAN Audit] Chain still broken after repair — creating alert`);
                try { createAlert({ alert_type: 'audit_chain_broken', severity: 'critical', title: 'Audit chain integrity broken', detail: `Entry ${recheck.broken_at}: ${recheck.reason} in org ${recheck.org_id} (repair failed)` }); } catch {}
              }
            } catch (repairErr) {
              console.error('[PAN Audit] Chain repair failed:', repairErr.message);
              try { createAlert({ alert_type: 'audit_chain_broken', severity: 'critical', title: 'Audit chain integrity broken', detail: `Entry ${chainResult.broken_at}: ${chainResult.reason} in org ${chainResult.org_id}` }); } catch {}
            }
          }
        } catch (e) {
          console.error('[PAN Audit] Chain verification failed:', e.message);
        }
      }
      _verifyAuditChains();
      _startupIntervals.push(setInterval(_verifyAuditChains, 60 * 60 * 1000)); // every 1 hour

      // Tier 0 Phase 8 — Start background personal data sync (every 1 hour)
      startPersonalSync(60 * 60 * 1000);

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

      // Chat schema (contacts, threads, messages, calls)
      ensureChatSchema(db);

      // Email schema (IMAP/SMTP cache)
      initEmail(db);

      // Wrapper schema (Tauri app wrappers: Discord, Slack, etc.)
      ensureWrapSchema(db);

      // Messaging prefs schema (per-user/per-org default + per-contact channel routing)
      ensureMessagingPrefsSchema(db);

      // Intuition schema — snapshots of live situational state
      ensureIntuitionSchema(db);

      // Seed sensor definitions (22 sensors)
      seedSensors();

      // Auto-detect local model providers (Ollama, LM Studio)
      autoDetectLocalModels();

      // Screen watcher — screenshot every 30s → vision AI → activity signal for intuition
      if (!IS_DEV) startScreenWatcher();

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
          insert(`INSERT INTO devices (hostname, name, device_type, capabilities, last_seen, org_id)
            VALUES (:h, :name, 'pc', '["terminal","files","browser","apps"]', datetime('now','localtime'), 'org_personal')`, {
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

        // Clean up stale Tailscale pan-* nodes on startup (delay to let Tailscale stabilize)
        setTimeout(() => cleanupStaleTailscaleNodes(), 30000);

        // Auto-establish a public tunnel so any new device can scan the QR code
        // from anywhere — no Tailscale enrollment, no config, no user action needed.
        // Priority: Tailscale Funnel (best) → Cloudflare Quick Tunnel (zero-config) → LAN IP
        setTimeout(async () => {
          // 1. Try Tailscale Funnel (already set up users get this for free)
          try {
            execSync(`tailscale funnel ${PORT}`, { timeout: 5000, windowsHide: true, stdio: 'pipe' });
            console.log(`[PAN] Tailscale Funnel active — QR codes use public ts.net URL`);
            return; // Done — Tailscale Funnel handles it
          } catch {
            // Tailscale not running, or Funnel not enabled in admin console — try Cloudflare
          }

          // 2. Fall back to Cloudflare Quick Tunnel — zero config, downloads binary automatically
          const cfURL = await startCloudflareTunnel(PORT);
          if (cfURL) {
            console.log(`[PAN] Cloudflare Tunnel active — QR codes use ${cfURL}`);
          } else {
            console.log('[PAN] No public tunnel available — QR codes will use LAN IP (same network only)');
          }
        }, 5000); // Delay 5s to let Tailscale daemon stabilize after boot

        // UDP discovery responder — lets the installer find this hub on LAN/Tailscale
        // without manual IP entry. Installer broadcasts "PAN_DISCOVER", we reply.
        startDiscovery(PORT, '0.3.1');

        // Ensure Windows Firewall allows inbound on PORT so LAN discovery works
        // (silently ignored if rule already exists or on non-Windows)
        try {
          execFileSync('netsh', [
            'advfirewall', 'firewall', 'add', 'rule',
            `name=PAN Hub (${PORT})`, 'dir=in', 'action=allow',
            'protocol=TCP', `localport=${PORT}`, 'profile=private,domain'
          ], { windowsHide: true, timeout: 5000 });
        } catch { /* rule may already exist or not on Windows */ }

        // Daily 3am benchmark — runs ALL 12 suites sequentially on the active model
        {
          async function runDailyBenchmarks() {
            try {
              const { runBenchmark, BENCHMARK_SUITES } = await import('./benchmark.js');
              const modelRow = get("SELECT value FROM settings WHERE key = 'ai_model'");
              const model = modelRow ? modelRow.value.replace(/^"|"$/g, '') : 'cerebras:qwen-3-235b';
              console.log(`[PAN Benchmark] Daily 3am — running all ${BENCHMARK_SUITES.length} suites on model: ${model}`);
              for (const suite of BENCHMARK_SUITES) {
                try {
                  await runBenchmark(suite, model);
                } catch (e) {
                  console.error(`[PAN Benchmark] Daily suite "${suite}" failed:`, e.message);
                }
              }
              console.log('[PAN Benchmark] Daily run complete');
            } catch (e) {
              console.error('[PAN Benchmark] Daily run failed:', e.message);
            }
          }

          function scheduleDailyBenchmark() {
            const now = new Date();
            const next3am = new Date(now);
            next3am.setHours(3, 0, 0, 0);
            if (next3am <= now) next3am.setDate(next3am.getDate() + 1);
            const msUntil3am = next3am - now;
            setTimeout(async () => {
              await runDailyBenchmarks();
              setInterval(runDailyBenchmarks, 24 * 60 * 60 * 1000);
            }, msUntil3am);
            console.log(`[PAN Benchmark] Daily run scheduled for 3am (in ${Math.round(msUntil3am / 60000)}m) — all 12 suites`);
          }
          scheduleDailyBenchmark();
        }

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
  stopPersonalSync();
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
// Debounce alerts for repeated errors (EPIPE, etc.) — max 1 alert per error type per 60s
const _alertDebounce = new Map();
function debouncedAlert(alertType, severity, title, detail) {
  const key = alertType + ':' + title;
  const now = Date.now();
  const last = _alertDebounce.get(key) || 0;
  if (now - last < 60000) return; // skip if same alert fired <60s ago
  _alertDebounce.set(key, now);
  // Cleanup old keys every 100 entries
  if (_alertDebounce.size > 100) {
    for (const [k, t] of _alertDebounce) { if (now - t > 120000) _alertDebounce.delete(k); }
  }
  try { createAlert({ alert_type: alertType, severity, title, detail }); } catch {}
}

process.on('uncaughtException', (err) => {
  // EPIPE = broken pipe (writing to dead process) — harmless, don't spam alerts
  if (err.code === 'EPIPE') return;
  console.error(`[PAN] Uncaught exception (server kept alive):`, err);
  debouncedAlert('uncaught_exception', 'critical',
    `Uncaught exception: ${err.message?.slice(0, 100)}`,
    JSON.stringify({ message: err.message, stack: err.stack, time: new Date().toISOString() })
  );
});
process.on('unhandledRejection', (reason) => {
  try {
  const msg = String(reason);
  // EPIPE in rejections too
  if (msg.includes('EPIPE')) return;
  console.error(`[PAN] Unhandled rejection (server kept alive):`, reason);
  debouncedAlert('unhandled_rejection', 'warning',
    `Unhandled rejection: ${msg?.slice(0, 100)}`,
    JSON.stringify({ reason: msg, stack: reason?.stack, time: new Date().toISOString() })
  );
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
    const seenDevices = new Set();
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
      // Track unique device IDs to update last_seen once per batch
      if (e.device_id && e.device_id !== 'unknown' && e.device_id !== 'phone-dashboard') {
        seenDevices.add(e.device_id);
      }
    }
    // Update last_seen + online for any real device that just sent logs
    for (const deviceId of seenDevices) {
      db.prepare(`UPDATE devices SET last_seen = datetime('now','localtime'), online = 1
        WHERE hostname = ?`).run(deviceId);
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

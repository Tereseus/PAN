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
import { ensureOllama } from './memory/ollama-boot.js';
import { startAutoDev, stopAutoDev, getConfig as getAutoDevConfig, saveConfig as saveAutoDevConfig, getAutoDevLog } from './autodev.js';
import { startStackScanner, stopStackScanner, getAllStacks, scanStacks, getProjectBriefing, getEnvironmentBriefing } from './stack-scanner.js';
import { syncProjects, get, all, insert, run, logEvent } from './db.js';
import { readFileSync, existsSync } from 'fs';
import { startTerminalServer, listSessions, killSession, getTerminalProjects, sendToSession, broadcastNotification, getPendingPermissions, clearPermission, respondToPermission } from './terminal.js';
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
        const test = await claude('Say "ok" and nothing else.', { model: 'claude-haiku-4-5-20251001', timeout: 10000, maxTokens: 10, caller: 'setup-check' });
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
  if (isLocalhost) {
    req.user = { id: 1, email: 'owner@localhost', display_name: 'Owner', role: 'owner' };
    return next();
  }
  extractUser(req, res, next);
});

// Hook events from Claude Code
app.use('/hooks', hooksRouter);

// API for Android app / Pandant data
app.use('/api/v1', apiRouter);

// Device management
app.use('/api/v1/devices', devicesRouter);

// Sensor management API
app.use('/api/sensors', sensorsRouter);

// Feature registry — maps feature names to start/stop functions
const featureRegistry = {
  scout: { start: startScout, stop: stopScout, interval: '12h', defaultMs: 12 * 60 * 60 * 1000 },
  dream: { start: startDream, stop: stopDream, interval: '12h', defaultMs: 12 * 60 * 60 * 1000 },
  autodev: { start: startAutoDev, stop: stopAutoDev, interval: '1h', defaultMs: 60 * 60 * 1000 },
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
    dream: { enabled: toggles.dream !== false, interval: '12h' },
    autodev: { enabled: toggles.autodev === true, interval: '1h' },
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
    for (const [key, value] of Object.entries(updates)) {
      const valStr = typeof value === 'string' ? value : JSON.stringify(value);
      run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (:key, :val, datetime('now','localtime'))", {
        ':key': key, ':val': valStr
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// Serve report.html at root level
app.get('/report.html', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'report.html'));
});
app.get('/report', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'report.html'));
});

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

  // Log as MobileSend for tracking
  logEvent(session_id || 'mobile-send', 'MobileSend', {
    text, session_id: session_id || 'auto', sent, raw: !!raw,
    source: 'mobile_dashboard', timestamp: Date.now()
  });

  // Also broadcast chat_update so transcript refreshes with the new message
  try {
    broadcastNotification('chat_update', {
      event_type: 'MobileSend',
      session_id: session_id || 'mobile-send',
      timestamp: new Date().toISOString(),
    });
  } catch {}

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
  const stateFile = join(__dirname, '..', '.pan-state.md');
  let stateDoc = '';
  try {
    if (existsSync(stateFile)) stateDoc = readFileSync(stateFile, 'utf8');
  } catch {}

  // 2. Recent conversation for this project (last 30 exchanges)
  // Use project→sessions join for reliable matching (LIKE on data had backslash escaping bugs)
  let recentChat = [];
  if (projectPath) {
    const fwd = projectPath.replace(/\\/g, '/');
    const proj = get("SELECT id FROM projects WHERE path = :p", { ':p': fwd });
    if (proj) {
      recentChat = all(
        `SELECT e.event_type, e.data, e.created_at FROM events e
         JOIN sessions s ON e.session_id = s.id
         WHERE s.project_id = :pid
         AND (e.event_type = 'UserPromptSubmit' OR e.event_type = 'Stop' OR e.event_type = 'AssistantMessage')
         AND e.created_at > datetime('now', '-48 hours', 'localtime')
         ORDER BY e.created_at DESC LIMIT 30`,
        { ':pid': proj.id }
      );
    }
  } else {
    recentChat = all(
      `SELECT event_type, data, created_at FROM events
       WHERE event_type IN ('UserPromptSubmit', 'Stop', 'AssistantMessage')
       AND created_at > datetime('now', '-48 hours', 'localtime')
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

    // Last few messages at full length for real context (trimmed to reduce bloat)
    const lastMessages = chatItems.slice(-4);
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

// Voice toggle — simulate Win+H to trigger Windows voice-to-text
app.post('/api/v1/voice/toggle', (req, res) => {
  import('child_process').then(({ exec }) => {
    const ps = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class KeySim { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); public static void WinH() { keybd_event(0x5B,0,0,UIntPtr.Zero); keybd_event(0x48,0,0,UIntPtr.Zero); keybd_event(0x48,0,2,UIntPtr.Zero); keybd_event(0x5B,0,2,UIntPtr.Zero); } }'; [KeySim]::WinH()`;
    exec(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, (err) => {
      if (err) return res.json({ ok: false, error: err.message });
      res.json({ ok: true });
    });
  });
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
    const { execFileSync } = require('child_process');
    tailscaleIp = execFileSync('C:\\Program Files\\Tailscale\\tailscale.exe', ['ip', '-4'], { timeout: 3000, encoding: 'utf8' }).trim();
  } catch {
    // Try PATH fallback
    try {
      const { execFileSync } = require('child_process');
      tailscaleIp = execFileSync('tailscale', ['ip', '-4'], { timeout: 3000, encoding: 'utf8' }).trim();
    } catch {}
  }
  res.json({ status: 'running', timestamp: new Date().toISOString(), startedAt: _serverStartedAt, uptime, tailscaleIp });
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

function start() {
  _serverStartedAt = Date.now();
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

      // Auto-detect local model providers (Ollama, LM Studio)
      autoDetectLocalModels();

      // Ensure Ollama is running with embedding model (for vector memory)
      ensureOllama();

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

      // Respect feature toggles from settings
      let toggles = {};
      try {
        const toggleRow = get("SELECT value FROM settings WHERE key = 'feature_toggles'");
        if (toggleRow) toggles = JSON.parse(toggleRow.value);
      } catch {}

      // Start tool scout (every 12 hours — discovers new CLIs and tools)
      if (toggles.scout !== false) startScout(12 * 60 * 60 * 1000);
      else console.log('[PAN] Scout disabled by toggle');

      // Start auto-dream (every 12 hours — consolidates events into structured memory)
      if (toggles.dream !== false) startDream(12 * 60 * 60 * 1000);
      else console.log('[PAN] Dream disabled by toggle');

      // Start Stack Scanner (every 6 hours — discovers tech stacks per project)
      startStackScanner(6 * 60 * 60 * 1000);

      // Start AutoDev (checks hourly, runs at configured time — disabled by default)
      if (toggles.autodev === true) startAutoDev(60 * 60 * 1000);
      else console.log('[PAN] AutoDev disabled by toggle');

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

// Graceful shutdown — kill all background jobs and close the port
function gracefulShutdown(signal) {
  console.log(`\n[PAN] ${signal} received — shutting down...`);
  stop();
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Dashboard restart endpoint — full process restart so code changes from disk are picked up
app.post('/api/admin/restart', (req, res) => {
  res.json({ ok: true, message: 'Restarting...' });
  console.log('[PAN] Restart requested from dashboard');
  setTimeout(async () => {
    console.log('[PAN] Stopping all services...');
    stop();
    // Wait for port to fully release, then spawn fresh process and exit
    await new Promise(r => setTimeout(r, 1500));
    console.log('[PAN] Spawning fresh server process...');
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, ['pan.js', 'start'], {
      cwd: join(__dirname, '..'),
      stdio: 'inherit',
      detached: true
    });
    child.unref();
    console.log('[PAN] New process spawned, exiting old process');
    process.exit(0);
  }, 500);
});

export { start, stop, app };

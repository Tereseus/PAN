#!/usr/bin/env node
// PAN Smart Installer — compiled to a self-contained binary by @yao-pkg/pkg
// Zero dependencies (uses only built-in Node.js APIs).
//
// Three modes (tried in order):
//   1. Filename config  — binary was downloaded from the hub's invite link;
//      config is base64url-encoded in the filename: pan-[code].exe
//      → connects directly, no discovery needed.
//
//   2. Local network discovery — broadcasts UDP on port 7778, hub replies.
//      Also scans Tailscale peers via `tailscale status --json`.
//      → user picks a hub card in the GUI, connects with token "local"
//        (still goes through hub owner's approve/deny flow).
//
//   3. Manual link — user pastes the invite URL from a QR code / message.
//      → parses the URL, extracts config, connects.
//
// GUI: opens http://localhost:17999 in the default browser, streams progress
// via SSE (/events). Install runs in the background, results shown live.
'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const cp     = require('child_process');
const dgram  = require('dgram');
const url    = require('url');

const IS_WIN   = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const IS_MAC   = process.platform === 'darwin';

const GUI_PORT = 17999;
const DISCOVER_PORT = 7778;
const DISCOVER_MSG  = Buffer.from('PAN_DISCOVER', 'utf8');
const NODE_VER      = '22.16.0';

// ── Paths ─────────────────────────────────────────────────────────────────────
const panDir  = IS_WIN
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'PAN-Client')
  : path.join(os.homedir(), '.local', 'share', 'pan-client');
const nodeDir = path.join(panDir, 'node');
const dataDir = path.join(panDir, 'data');
const nodeExe = IS_WIN ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node');
const npmCmd  = IS_WIN ? path.join(nodeDir, 'npm.cmd')  : path.join(nodeDir, 'bin', 'npm');

// ── SSE broadcast ─────────────────────────────────────────────────────────────
const sseClients = new Set();
function send(type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}
function log(msg)   { send('log',     { msg }); }
function status(s)  { send('status',  { status: s }); }
function done(ok, msg) { send('done', { ok, msg }); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function download(urlStr, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    function get(u) {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'PAN-Installer/1.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${u}`));
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          send('progress', { bytes, mb: (bytes / 1_048_576).toFixed(1) });
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    }
    get(urlStr);
  });
}

function run(cmd, cwd, opts = {}) {
  return cp.execSync(cmd, { cwd, stdio: 'pipe', windowsHide: true, ...opts });
}

function httpGet(u, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const mod = u.startsWith('https') ? https : http;
    const req = mod.get(u, { headers: { 'User-Agent': 'PAN-Installer/1.0' }, timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Bad JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Config from filename ──────────────────────────────────────────────────────
function tryReadConfigFromFilename() {
  const exe = path.basename(process.argv[0] || process.execPath);
  const match = exe.match(/^pan-([A-Za-z0-9_-]+?)(?:\.exe)?$/);
  if (!match) return null;
  try {
    const json = Buffer.from(match[1], 'base64url').toString('utf8');
    const cfg = JSON.parse(json);
    if (cfg.h && cfg.t) return cfg;
  } catch {}
  return null;
}

// ── UDP broadcast discovery ───────────────────────────────────────────────────
function udpDiscover(timeoutMs = 4000) {
  return new Promise(resolve => {
    const found = new Map(); // host:port → hub info
    let timer;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('error', () => { try { sock.close(); } catch {} resolve([...found.values()]); });

    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!text.startsWith('PAN_HERE:')) return;
      try {
        const info = JSON.parse(text.slice(9));
        const key = `${rinfo.address}:${info.port}`;
        found.set(key, { ...info, host: rinfo.address, via: 'lan' });
      } catch {}
    });

    sock.bind(0, () => {
      sock.setBroadcast(true);
      // Send on all interfaces
      const ifaces = os.networkInterfaces();
      const broadcasts = ['255.255.255.255'];
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal && iface.broadcast) {
            broadcasts.push(iface.broadcast);
          }
        }
      }
      for (const bcast of broadcasts) {
        try { sock.send(DISCOVER_MSG, 0, DISCOVER_MSG.length, DISCOVER_PORT, bcast); } catch {}
      }

      timer = setTimeout(() => {
        try { sock.close(); } catch {}
        resolve([...found.values()]);
      }, timeoutMs);
    });
  });
}

// ── HTTP LAN scan ─────────────────────────────────────────────────────────────
// Scans the local subnet for PAN hubs by hitting /health on port 7777.
// More reliable than UDP — works through Windows Firewall and router AP isolation.
async function lanHttpScan(timeoutMs = 6000) {
  const found = [];
  // Get all local IPv4 addresses to determine subnets to scan
  const subnets = new Set();
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // e.g. 192.168.1.42 → scan 192.168.1.1–254
        const parts = iface.address.split('.');
        if (parts.length === 4) subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }
  }

  const perIpTimeout = Math.min(400, timeoutMs / 10); // fast parallel checks
  const checks = [];
  for (const subnet of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`;
      checks.push((async () => {
        for (const port of [7777, 7781]) {
          try {
            const info = await httpGet(`http://${ip}:${port}/health`, perIpTimeout);
            if (info && info.status === 'running') {
              found.push({
                name: info.hubName || ip,
                hostname: ip,
                host: ip,
                port,
                version: info.craftVersion || '?',
                via: 'lan',
              });
              break;
            }
          } catch {}
        }
      })());
    }
  }
  // Run in batches of 40 to avoid exhausting file descriptors
  const BATCH = 40;
  for (let i = 0; i < checks.length; i += BATCH) {
    await Promise.all(checks.slice(i, i + BATCH));
  }
  return found;
}

// ── Tailscale peer discovery ──────────────────────────────────────────────────
async function tailscaleDiscover(timeoutMs = 6000) {
  const found = [];
  let status;
  try {
    const out = cp.execFileSync(
      IS_WIN ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale',
      ['status', '--json'],
      { timeout: 5000, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
    );
    status = JSON.parse(out);
  } catch {
    try {
      const out = cp.execFileSync('tailscale', ['status', '--json'],
        { timeout: 5000, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      status = JSON.parse(out);
    } catch { return []; }
  }

  const peers = Object.values(status.Peer || {});
  const checks = peers
    .filter(p => p.TailscaleIPs && p.TailscaleIPs.length > 0)
    .map(async peer => {
      const ip = peer.TailscaleIPs[0];
      for (const port of [7777, 7781]) {
        try {
          const info = await httpGet(`http://${ip}:${port}/health`, timeoutMs / peers.length);
          if (info && info.status === 'running') {
            found.push({
              name: info.hubName || peer.HostName || ip,
              hostname: peer.HostName || ip,
              host: ip,
              port,
              version: info.craftVersion || '?',
              via: 'tailscale',
            });
            break;
          }
        } catch {}
      }
    });
  await Promise.all(checks);
  return found;
}

// ── Parse install link ────────────────────────────────────────────────────────
function parseInstallLink(link) {
  // Accepts:
  //   http://host/install/TOKEN
  //   http://host:PORT/install/TOKEN
  //   pan://host/token/TOKEN
  try {
    const u = new url.URL(link.trim());
    if (u.protocol === 'pan:') {
      const parts = u.pathname.split('/').filter(Boolean);
      return { h: u.host, t: parts[1] || parts[0], s: false };
    }
    const parts = u.pathname.split('/').filter(Boolean);
    const token = parts[1]; // /install/TOKEN
    if (!token) return null;
    const host = u.host; // includes port if non-default
    const s = u.protocol === 'https:';
    return { h: host, t: token, s };
  } catch { return null; }
}

// ── Open browser ──────────────────────────────────────────────────────────────
function openBrowser(u) {
  try {
    if (IS_WIN)        cp.exec(`start "" "${u}"`, { windowsHide: true });
    else if (IS_MAC)   cp.exec(`open "${u}"`);
    else               cp.exec(`xdg-open "${u}"`);
  } catch {}
}

// ── Core install logic ────────────────────────────────────────────────────────
async function runInstall(cfg) {
  const hubHost = cfg.h;
  const token   = cfg.t;
  const proto   = cfg.s ? 'https' : 'http';
  const wsProto = cfg.s ? 'wss'   : 'ws';
  const hubHTTP = `${proto}://${hubHost}`;
  const hubWS   = `${wsProto}://${hubHost}`;
  const deviceId = os.hostname();

  status('installing');
  log(`Connecting to: ${hubHTTP}`);

  // Verify hub is reachable
  try {
    const health = await httpGet(`${hubHTTP}/health`, 5000);
    if (!health || health.status !== 'running') throw new Error('Hub returned bad status');
    log(`Hub OK: ${health.hubName || hubHost} (v${health.craftVersion || '?'})`);
  } catch (e) {
    throw new Error(`Cannot reach hub at ${hubHTTP}: ${e.message}`);
  }

  // Create dirs
  for (const d of [panDir, nodeDir, dataDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  // ── Node.js ─────────────────────────────────────────────────────────────────
  if (!fs.existsSync(nodeExe)) {
    log('Downloading Node.js...');
    const arch    = process.arch === 'arm64' ? 'arm64' : 'x64';
    const nodeURL = IS_WIN
      ? `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-win-${arch}.zip`
      : IS_MAC
        ? `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-darwin-${arch}.tar.xz`
        : `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-${arch}.tar.xz`;

    const tmpArchive = path.join(os.tmpdir(), IS_WIN ? 'pan-node.zip' : 'pan-node.tar.xz');
    await download(nodeURL, tmpArchive);

    log('Extracting Node.js...');
    if (IS_WIN) {
      run(
        `powershell -NoProfile -Command "Expand-Archive -Force '${tmpArchive}' '${os.tmpdir()}\\pan-node-extract'"`,
        panDir, { shell: true }
      );
      const extracted = fs.readdirSync(path.join(os.tmpdir(), 'pan-node-extract'))[0];
      const srcDir = path.join(os.tmpdir(), 'pan-node-extract', extracted);
      for (const f of fs.readdirSync(srcDir)) {
        const src = path.join(srcDir, f), dst = path.join(nodeDir, f);
        if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
        fs.renameSync(src, dst);
      }
    } else {
      run(`tar -xJf "${tmpArchive}" -C "${nodeDir}" --strip-components=1`, panDir, { shell: true });
    }
    try { fs.unlinkSync(tmpArchive); } catch {}
    log('Node.js ready ✓');
  } else {
    log('Node.js already installed ✓');
  }

  // ── pan-client.js ────────────────────────────────────────────────────────────
  log('Downloading PAN client...');
  const clientPath = path.join(panDir, 'pan-client.js');
  await download(`${hubHTTP}/client/pan-client.js`, clientPath);
  log('PAN client downloaded ✓');

  // ── npm install ws ───────────────────────────────────────────────────────────
  log('Installing dependencies...');
  const pkgJson = path.join(panDir, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: 'pan-client', version: '1.0.0', type: 'commonjs' }));
  }
  try {
    run(`"${npmCmd}" install ws --no-audit --no-fund --save`, panDir, { shell: IS_WIN });
    log('Dependencies installed ✓');
  } catch (e) {
    throw new Error(`npm install failed: ${e.message}`);
  }

  // ── Config ───────────────────────────────────────────────────────────────────
  const cfgPath = path.join(panDir, 'pan-client-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    hub_ws:    hubWS,
    hub_http:  hubHTTP,
    token,
    device_id: deviceId,
    name:      deviceId,
  }, null, 2));
  log('Config saved ✓');

  // ── Startup task ─────────────────────────────────────────────────────────────
  log('Registering startup task...');
  if (IS_WIN) {
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${nodeExe}"</Command>
      <Arguments>"${clientPath}"</Arguments>
      <WorkingDirectory>${panDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
    const xmlPath = path.join(os.tmpdir(), 'pan-task.xml');
    fs.writeFileSync(xmlPath, taskXml, 'utf16le');
    try {
      run(`schtasks /Create /TN "PAN-Client" /XML "${xmlPath}" /F`, panDir, { shell: true });
      log('Startup task created ✓ (runs at login)');
    } catch {
      log('⚠ Could not create startup task — may need Administrator');
    }
    try { fs.unlinkSync(xmlPath); } catch {}
  } else {
    const svcDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    if (!fs.existsSync(svcDir)) fs.mkdirSync(svcDir, { recursive: true });
    fs.writeFileSync(path.join(svcDir, 'pan-client.service'), `[Unit]
Description=PAN Client
After=network.target

[Service]
ExecStart=${nodeExe} ${clientPath}
WorkingDirectory=${panDir}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`);
    try {
      run('systemctl --user daemon-reload && systemctl --user enable pan-client.service && systemctl --user start pan-client.service', panDir, { shell: true });
      log('Systemd service enabled and started ✓');
    } catch {
      cp.spawn(nodeExe, [clientPath], { cwd: panDir, detached: true, stdio: 'ignore' }).unref();
      log('Client started in background ✓ (no systemd)');
    }
  }

  // ── Launch ───────────────────────────────────────────────────────────────────
  log('Starting PAN client...');
  if (IS_WIN) {
    cp.spawn(nodeExe, [clientPath], {
      cwd: panDir, detached: true, stdio: 'ignore', windowsHide: false,
    }).unref();
  }

  log('');
  log('Waiting for hub owner to approve this device...');
  log('You can close this window once approved.');

  done(true, `Connected to ${hubHTTP} — waiting for approval`);
}

// ── Embedded HTML GUI ─────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PAN Installer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0d1117; color: #e6edf3; min-height: 100vh;
    display: flex; flex-direction: column; align-items: center;
    padding: 40px 20px;
  }
  .logo { font-size: 48px; font-weight: 800; letter-spacing: -2px;
    background: linear-gradient(135deg, #58a6ff, #bc8cff);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin-bottom: 8px; }
  .subtitle { color: #8b949e; font-size: 14px; margin-bottom: 40px; }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 12px;
    padding: 24px; width: 100%; max-width: 520px; margin-bottom: 16px;
  }
  .card h2 { font-size: 16px; color: #c9d1d9; margin-bottom: 16px;
    display: flex; align-items: center; gap: 8px; }
  .hub-list { display: flex; flex-direction: column; gap: 10px; }
  .hub-card {
    background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
    padding: 14px 16px; cursor: pointer; transition: border-color 0.15s;
    display: flex; align-items: center; justify-content: space-between;
  }
  .hub-card:hover { border-color: #58a6ff; }
  .hub-card.selected { border-color: #58a6ff; background: #0c1929; }
  .hub-name { font-weight: 600; color: #e6edf3; font-size: 15px; }
  .hub-meta { font-size: 12px; color: #8b949e; margin-top: 3px; }
  .hub-badge {
    font-size: 11px; padding: 2px 8px; border-radius: 20px;
    background: #1a2740; color: #58a6ff; border: 1px solid #1f4070;
    white-space: nowrap;
  }
  .hub-badge.tailscale { background: #1a1f2e; color: #bc8cff; border-color: #3d2c60; }
  .empty { color: #8b949e; font-size: 14px; text-align: center; padding: 20px 0; }
  .divider { display: flex; align-items: center; gap: 12px; color: #8b949e;
    font-size: 12px; margin: 4px 0; }
  .divider::before, .divider::after { content: ''; flex: 1;
    height: 1px; background: #30363d; }
  input[type=text] {
    width: 100%; background: #0d1117; border: 1px solid #30363d;
    border-radius: 8px; padding: 10px 14px; color: #e6edf3; font-size: 14px;
    outline: none; transition: border-color 0.15s;
  }
  input[type=text]:focus { border-color: #58a6ff; }
  input[type=text]::placeholder { color: #484f58; }
  .btn {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    font-size: 15px; font-weight: 600; cursor: pointer; transition: opacity 0.15s;
    margin-top: 12px;
  }
  .btn-primary { background: #238636; color: #fff; }
  .btn-primary:hover { background: #2ea043; }
  .btn-primary:disabled { opacity: 0.4; cursor: default; }
  .btn-refresh { background: #21262d; color: #e6edf3; border: 1px solid #30363d;
    font-size: 13px; padding: 8px 14px; border-radius: 8px; cursor: pointer; }
  .btn-refresh:hover { background: #30363d; }
  .log-box {
    background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
    padding: 14px; font-family: 'Cascadia Code', 'Consolas', monospace;
    font-size: 13px; color: #7ee787; max-height: 220px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
  }
  .spinner {
    width: 20px; height: 20px; border: 2px solid #30363d;
    border-top-color: #58a6ff; border-radius: 50%; animation: spin 0.8s linear infinite;
    display: inline-block; vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-icon { font-size: 20px; }
  .success { color: #7ee787; }
  .error { color: #f85149; }
  #installBtn { display: none; }
  #doneCard { display: none; }
  .progress-bar {
    height: 4px; background: #21262d; border-radius: 2px; margin-top: 8px; overflow: hidden;
  }
  .progress-fill {
    height: 100%; background: linear-gradient(90deg, #58a6ff, #bc8cff);
    width: 0%; transition: width 0.3s; border-radius: 2px;
  }
</style>
</head>
<body>
<div class="logo">ΠΑΝ</div>
<div class="subtitle">Personal AI Network — Device Installer</div>

<div class="card" id="discoveryCard">
  <h2>
    <span id="scanIcon"><span class="spinner"></span></span>
    <span id="scanLabel"> Scanning for PAN hubs...</span>
    <button class="btn-refresh" id="rescanBtn" style="margin-left:auto;display:none" onclick="rescan()">↻ Rescan</button>
  </h2>
  <div class="hub-list" id="hubList">
    <div class="empty" id="scanMsg">Searching local network and Tailscale...</div>
  </div>
</div>

<div class="card">
  <div class="divider">or paste an invite link</div>
  <input type="text" id="linkInput" placeholder="http://hub-address/install/token  or  https://xyz.trycloudflare.com/install/token" />
</div>

<button class="btn btn-primary" id="installBtn" onclick="startInstall()">⬇ Install PAN Client</button>

<div class="card" id="installCard" style="display:none">
  <h2>Installing...</h2>
  <div class="log-box" id="logBox"></div>
  <div class="progress-bar"><div class="progress-fill" id="progFill"></div></div>
</div>

<div class="card" id="doneCard">
  <h2 id="doneTitle"></h2>
  <p id="doneMsg" style="font-size:14px;color:#8b949e;margin-top:8px"></p>
</div>

<script>
let selectedHub = null;
let hubs = [];
let installing = false;

async function rescan() {
  document.getElementById('rescanBtn').style.display = 'none';
  document.getElementById('scanIcon').innerHTML = '<span class="spinner"></span>';
  document.getElementById('scanLabel').textContent = ' Scanning...';
  document.getElementById('hubList').innerHTML = '<div class="empty">Searching...</div>';
  selectedHub = null;
  updateInstallBtn();
  await loadHubs();
}

async function loadHubs() {
  try {
    const res = await fetch('/api/hubs');
    hubs = await res.json();
  } catch { hubs = []; }
  renderHubs();
}

function renderHubs() {
  const list = document.getElementById('hubList');
  document.getElementById('scanIcon').innerHTML = '🔍';
  document.getElementById('scanLabel').textContent = hubs.length
    ? \` Found \${hubs.length} hub\${hubs.length > 1 ? 's' : ''}\`
    : ' No hubs found nearby';
  document.getElementById('rescanBtn').style.display = 'inline-block';

  if (!hubs.length) {
    list.innerHTML = '<div class="empty">No PAN hubs found on your network.<br>Paste an invite link below, or make sure the hub is running.</div>';
    return;
  }
  list.innerHTML = '';
  hubs.forEach((hub, i) => {
    const card = document.createElement('div');
    card.className = 'hub-card';
    card.innerHTML = \`
      <div>
        <div class="hub-name">\${esc(hub.name || hub.hostname)}</div>
        <div class="hub-meta">\${esc(hub.host)}:\${hub.port} · v\${esc(hub.version || '?')}</div>
      </div>
      <span class="hub-badge \${hub.via === 'tailscale' ? 'tailscale' : ''}">\${hub.via === 'tailscale' ? '🔒 Tailscale' : '📡 Local'}</span>
    \`;
    card.onclick = () => {
      document.querySelectorAll('.hub-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedHub = hub;
      document.getElementById('linkInput').value = '';
      updateInstallBtn();
    };
    list.appendChild(card);
    if (i === 0) card.click(); // auto-select first
  });
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function updateInstallBtn() {
  const btn = document.getElementById('installBtn');
  const hasHub = selectedHub || document.getElementById('linkInput').value.trim();
  btn.style.display = 'block';
  btn.disabled = !hasHub || installing;
  btn.textContent = installing ? 'Installing...' : '⬇ Install PAN Client';
}

document.getElementById('linkInput').addEventListener('input', () => {
  if (document.getElementById('linkInput').value) {
    document.querySelectorAll('.hub-card').forEach(c => c.classList.remove('selected'));
    selectedHub = null;
  }
  updateInstallBtn();
});

async function startInstall() {
  if (installing) return;
  const link = document.getElementById('linkInput').value.trim();

  let body;
  if (selectedHub) {
    body = { hub: selectedHub };
  } else if (link) {
    body = { link };
  } else { return; }

  installing = true;
  updateInstallBtn();
  document.getElementById('installCard').style.display = 'block';
  document.getElementById('logBox').textContent = '';
  window.scrollTo(0, document.body.scrollHeight);

  // SSE for live logs
  const es = new EventSource('/events');
  es.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'log') {
      const box = document.getElementById('logBox');
      box.textContent += d.msg + '\\n';
      box.scrollTop = box.scrollHeight;
    } else if (d.type === 'progress') {
      document.getElementById('progFill').style.width = Math.min(d.mb * 5, 90) + '%';
    } else if (d.type === 'done') {
      es.close();
      document.getElementById('progFill').style.width = '100%';
      const card = document.getElementById('doneCard');
      card.style.display = 'block';
      document.getElementById('doneTitle').innerHTML = d.ok
        ? '<span class="success">✓ Installation complete!</span>'
        : '<span class="error">✗ Installation failed</span>';
      document.getElementById('doneMsg').textContent = d.msg || '';
      window.scrollTo(0, document.body.scrollHeight);
    }
  };

  await fetch('/api/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Direct mode: hub URL came from filename — skip scan, auto-connect
const isDirect = new URLSearchParams(location.search).get('direct') === '1';
if (isDirect) {
  // Hide scan and link-paste UI entirely
  document.querySelectorAll('.card').forEach(c => c.style.display = 'none');
  document.getElementById('installBtn').style.display = 'none';

  // Show connecting banner
  const banner = document.createElement('div');
  banner.style.cssText = 'background:#0d2137;border:2px solid #89b4fa;border-radius:12px;padding:24px;text-align:center;margin:20px 0';
  banner.innerHTML = '<div style="font-size:22px;margin-bottom:8px">🔗</div><div style="color:#89b4fa;font-size:16px;font-weight:700">Connecting to your PAN hub...</div><div style="color:#6c7086;font-size:13px;margin-top:6px">Hub address was read from installer — no scan needed</div>';
  document.body.appendChild(banner);

  // Show log box for progress
  const logCard = document.getElementById('installCard');
  logCard.style.display = 'block';

  // Auto-subscribe to SSE events from Node.js runInstall
  const es = new EventSource('/events');
  es.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'log') {
        const box = document.getElementById('logBox');
        box.textContent += d.msg + '\n';
        box.scrollTop = box.scrollHeight;
      } else if (d.type === 'progress') {
        document.getElementById('progFill').style.width = Math.min(d.mb * 5, 90) + '%';
      } else if (d.type === 'done') {
        es.close();
        banner.remove();
        document.getElementById('progFill').style.width = '100%';
        const card = document.getElementById('doneCard');
        card.style.display = 'block';
        document.getElementById('doneTitle').innerHTML = d.ok
          ? '<span class="success">✓ Connected! Waiting for hub owner to approve...</span>'
          : '<span class="error">✗ Connection failed: ' + (d.msg || '') + '</span>';
        document.getElementById('doneMsg').textContent = d.ok ? 'Check your PAN dashboard to approve this device.' : '';
      }
    } catch {}
  };
} else {
  // Normal mode: scan takes up to ~7s (HTTP LAN scan is the slow one)
  loadHubs();
  setTimeout(updateInstallBtn, 500);

  // Auto-read clipboard: if it contains a PAN invite link, pre-fill and auto-install
  (async function tryClipboard() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (/\/install\/pan-[a-f0-9]+/.test(text)) {
        const input = document.getElementById('linkInput');
        input.value = text;
        selectedHub = null;
        updateInstallBtn();
        const banner = document.createElement('div');
        banner.style.cssText = 'background:#1a2a1a;border:1px solid #3fb950;border-radius:8px;padding:12px 16px;margin:12px 0;font-size:13px;color:#3fb950;text-align:center';
        banner.textContent = '✓ Invite link found — connecting in 3 seconds...';
        document.getElementById('installBtn').before(banner);
        setTimeout(() => { banner.remove(); startInstall(); }, 3000);
      }
    } catch {}
  })();
}

</script>
</body>
</html>`;

// ── HTTP GUI server ────────────────────────────────────────────────────────────
function startGUI(launchUrl = `http://localhost:${GUI_PORT}`) {
  const server = http.createServer(async (req, res) => {
    const u = req.url.split('?')[0];

    if (req.method === 'GET' && u === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && u === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':\n\n'); // ping
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'GET' && u === '/api/hubs') {
      // Run all discovery methods in parallel:
      // 1. UDP broadcast — fast, may be blocked by firewall/AP isolation
      // 2. HTTP LAN scan — reliable, works through firewall (just needs port 7777 open)
      // 3. Tailscale peers — for remote hubs on the same Tailscale network
      const [udpHubs, httpHubs, tsHubs] = await Promise.all([
        udpDiscover(3000),
        lanHttpScan(6000),
        tailscaleDiscover(5000),
      ]);
      // De-dupe by host:port (UDP → HTTP → Tailscale priority)
      const all = new Map();
      for (const h of tsHubs)  all.set(`${h.host}:${h.port}`, h);
      for (const h of httpHubs) all.set(`${h.host}:${h.port}`, h);
      for (const h of udpHubs) all.set(`${h.host}:${h.port}`, h);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([...all.values()]));
      return;
    }

    if (req.method === 'POST' && u === '/api/install') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        let cfg;
        try {
          const payload = JSON.parse(body);
          if (payload.hub) {
            // Hub discovered locally — use 'local' token
            const h = payload.hub;
            cfg = { h: `${h.host}:${h.port}`, t: 'local', s: false };
          } else if (payload.link) {
            cfg = parseInstallLink(payload.link);
            if (!cfg) { done(false, 'Invalid install link'); return; }
          } else { done(false, 'No hub or link provided'); return; }
        } catch (e) { done(false, `Bad request: ${e.message}`); return; }

        runInstall(cfg).catch(e => done(false, e.message));
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(GUI_PORT, '127.0.0.1', () => {
    console.log(`\n  PAN Installer running at http://localhost:${GUI_PORT}\n`);
    openBrowser(launchUrl);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${GUI_PORT} already in use. Opening existing installer...\n`);
      openBrowser(launchUrl);
    } else {
      console.error('[PAN Installer] Server error:', err.message);
    }
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║                                      ║');
  console.log('  ║          ΠΑΝ  ·  Personal AI Network ║');
  console.log('  ║                                      ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log('  Device Installer');
  console.log('  ─────────────────────────────────────');
  console.log('  Opening installer in your browser...');
  console.log('  (Keep this window open while installing)');
  console.log('');

  // Fast path: filename has encoded config — connect directly, no scan needed
  const filenameCfg = tryReadConfigFromFilename();
  if (filenameCfg) {
    console.log('  Config detected from filename — connecting directly...');
    // Pass ?direct=1 so the browser skips the scan UI entirely
    startGUI(`http://localhost:${GUI_PORT}/?direct=1`);
    // Give browser a moment to open and subscribe to SSE, then start install
    setTimeout(() => {
      runInstall(filenameCfg).catch(e => done(false, e.message));
    }, 2500);
    return;
  }

  // Normal path: scan network, show GUI, let user pick or paste link
  startGUI();
}

main().catch(e => {
  console.error('\n  Fatal error:', e.message);
  process.exit(1);
});

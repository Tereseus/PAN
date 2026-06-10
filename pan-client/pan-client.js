#!/usr/bin/env node
// PAN Client — connects any computer to the PAN hub.
//
// Usage:
//   node pan-client.js --hub ws://100.x.x.x:7777 --token <invite-token>
//   node pan-client.js --hub ws://100.x.x.x:7777 --token <invite-token> --name bedroom-pc
//
// Persists config to pan-client-config.json after first registration.
// Reconnects automatically on disconnect (exponential backoff, max 30s).
//
// Command types handled:
//   shell_exec, notification, open_app, open_url, tts_speak, screenshot,
//   media_control, display_control, file_transfer, eval_window (stub),
//   ble_scan (stub), smart_home (stub)

import { WebSocket } from 'ws';
import { execFile, exec, execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hostname, platform, arch, totalmem, freemem, cpus, tmpdir } from 'os';
import * as os from 'os';
import { createInterface } from 'readline';
import https from 'https';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, 'pan-client-config.json');
const VERSION = '1.0.0';
const PLATFORM = platform(); // win32 | linux | darwin
const IS_WINDOWS = PLATFORM === 'win32';

// ── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

// ── Config ──────────────────────────────────────────────────────────────────
let config = {};
if (existsSync(CONFIG_FILE)) {
  try { config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch {}
}
function saveConfig() {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

const HUB_WS  = arg('hub')   || config.hub_ws  || process.env.PAN_HUB_WS;
const TOKEN   = arg('token') || config.token   || process.env.PAN_TOKEN;
const NAME    = arg('name')  || config.name    || hostname();
const DEVICE_ID = config.device_id || hostname();

if (!HUB_WS) {
  console.error('PAN Client: --hub <ws://hub:7777> is required');
  process.exit(1);
}
if (!TOKEN) {
  console.error('PAN Client: --token <invite-token> is required');
  process.exit(1);
}

// Persist config for future runs
config.hub_ws = HUB_WS;
config.token  = TOKEN;
config.name   = NAME;
config.device_id = DEVICE_ID;
saveConfig();

// ── Capabilities ─────────────────────────────────────────────────────────────
// Static base — known at startup, never changes.
const staticCapabilities = [];
if (IS_WINDOWS) staticCapabilities.push('windows', 'powershell', 'cmd');
if (PLATFORM === 'linux') staticCapabilities.push('linux', 'bash');
if (PLATFORM === 'darwin') staticCapabilities.push('macos', 'bash');
staticCapabilities.push('shell_exec', 'open_app', 'open_url', 'notification', 'tts_speak', 'screenshot', 'audio_capture');

// Live capabilities — refreshed by probeCapabilities() every CAP_REFRESH_MS.
// Format examples: 'audio', 'audio:bluetooth', 'bt:wh-1000xm5', 'display:2',
// 'display:projector', 'speakers'. smart-router.js scoreDevice() does substring
// matching (caps.some(c => c.includes('projector'))), so naming is forgiving.
let liveCapabilities = [];
const CAP_REFRESH_MS = 5 * 60_000;

// The combined set that gets POSTed to /api/v1/client/register.
function getAllCapabilities() {
  // De-dupe while preserving order
  return Array.from(new Set([...staticCapabilities, ...liveCapabilities]));
}

// Back-compat: some code paths still reference `capabilities` directly.
const capabilities = new Proxy([], {
  get(_, prop) {
    const arr = getAllCapabilities();
    if (prop === 'length') return arr.length;
    if (prop === Symbol.iterator) return arr[Symbol.iterator].bind(arr);
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return arr[Number(prop)];
    return arr[prop];
  },
});

// ── Capability probes (per-OS) ────────────────────────────────────────────────
function _ps(script, timeoutMs = 4000) {
  try {
    const out = execSync(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`,
      { timeout: timeoutMs, windowsHide: true, stdio: 'pipe' }
    ).toString();
    return out;
  } catch {
    return '';
  }
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function probeCapabilitiesWindows() {
  const caps = new Set();

  // Bluetooth radio + paired/active devices (radios show too; paired audio
  // devices typically appear as AudioEndpoint, not Bluetooth class)
  const bt = _ps(`Get-PnpDevice -Class Bluetooth -Status OK -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FriendlyName`);
  for (const line of bt.split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    const slug = slugify(name);
    if (slug) caps.add(`bt:${slug}`);
  }

  // Audio endpoints — speakers, headphones, microphones. We DON'T pre-filter
  // in PowerShell (escape rules are brittle); categorize in JS by name.
  const audio = _ps(`Get-PnpDevice -Class AudioEndpoint -Status OK -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FriendlyName`);
  let speakerCount = 0, micCount = 0;
  for (const line of audio.split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    const slug = slugify(name);
    const isOut = /speaker|headphone|headset|output|hdmi/i.test(name);
    const isIn  = /microphone|\bmic\b|input/i.test(name);
    if (isOut && slug) { speakerCount++; caps.add(`speakers:${slug}`); }
    if (isIn && slug)  { micCount++;     caps.add(`mic:${slug}`); }
    if (/bluetooth|airpods|wh-1000|jbl|bose|sony|sonos|beats/i.test(name)) caps.add('audio:bluetooth');
  }
  if (speakerCount > 0) { caps.add('audio'); caps.add('speakers'); }
  if (micCount > 0) caps.add('mic');

  // Displays — active monitors only (Availability=3 means "running on full power")
  const displays = _ps(`Get-CimInstance -ClassName Win32_DesktopMonitor -ErrorAction SilentlyContinue | Where-Object { $_.Availability -eq 3 } | Select-Object -ExpandProperty Name`);
  const displayLines = displays.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (displayLines.length > 0) {
    caps.add('display');
    caps.add(`display:${displayLines.length}`);
    for (const d of displayLines) {
      if (/projector/i.test(d)) caps.add('display:projector');
      if (/\btv\b|television/i.test(d)) { caps.add('tv'); caps.add('hdmi'); }
    }
  }

  // GPU / external-display adapters
  const gpu = _ps(`Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name`);
  if (gpu.trim()) {
    caps.add('video');
    if (/displaylink|usb mobile monitor/i.test(gpu)) caps.add('display:external');
    if (/nvidia|geforce|rtx|gtx/i.test(gpu)) caps.add('gpu:nvidia');
  }

  return Array.from(caps);
}

async function probeCapabilities() {
  try {
    let probed = [];
    if (IS_WINDOWS) probed = probeCapabilitiesWindows();
    // macOS + Linux stubbed for v1 — they remain on the static base set.
    liveCapabilities = probed;
    return probed;
  } catch (e) {
    console.warn('[PAN Client] probeCapabilities failed:', e.message);
    return [];
  }
}

async function refreshCapabilitiesAndReregister() {
  await probeCapabilities();
  try {
    await httpRegister();
    console.log(`[PAN Client] caps refreshed (${liveCapabilities.length} live): ${liveCapabilities.slice(0, 6).join(', ')}${liveCapabilities.length > 6 ? '…' : ''}`);
  } catch (e) {
    // non-fatal — next heartbeat will retry
  }
}

// ── HTTP registration (works through Cloudflare tunnel) ──────────────────────
const HUB_HTTP = config.hub_http || HUB_WS.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

// ── Service-state self-detection (#497) ──────────────────────────────────────
// Probe how the OS launched us. Cached for 60s so we don't shell out on every
// heartbeat. Returns { service_state, service_manager } where:
//   service_state:   'system' (boot-time) | 'user' (login-time) | 'manual' | 'none'
//   service_manager: 'nssm' | 'schtasks' | 'launchd-daemon' | 'launchd-agent'
//                  | 'systemd-system' | 'systemd-user' | null
let _svcCache = null;
let _svcCacheAt = 0;
const SVC_CACHE_MS = 60_000;

function detectServiceState() {
  if (_svcCache && Date.now() - _svcCacheAt < SVC_CACHE_MS) return _svcCache;
  let state = 'manual', manager = null;
  try {
    if (IS_WINDOWS) {
      // 1. Real Windows service via nssm or sc — boot-time
      try {
        const out = execSync('sc query PAN-Client', { timeout: 2000, windowsHide: true, stdio: 'pipe' }).toString();
        if (/STATE\s*:\s*\d+\s*RUNNING/i.test(out)) {
          state = 'system';
          // Distinguish nssm from native sc by the binary path
          try {
            const cfg = execSync('sc qc PAN-Client', { timeout: 2000, windowsHide: true, stdio: 'pipe' }).toString();
            manager = /nssm/i.test(cfg) ? 'nssm' : 'sc';
          } catch { manager = 'sc'; }
        }
      } catch {}
      // 2. Scheduled Task at logon — user-session
      if (state === 'manual') {
        try {
          const out = execSync('schtasks /Query /TN "PAN-Client" /FO LIST', { timeout: 2000, windowsHide: true, stdio: 'pipe' }).toString();
          if (/Status:\s*(Running|Ready)/i.test(out)) { state = 'user'; manager = 'schtasks'; }
        } catch {}
      }
    } else if (PLATFORM === 'darwin') {
      try {
        const out = execSync('launchctl list | grep -i pan-client || true', { timeout: 2000, stdio: 'pipe' }).toString();
        if (out.trim()) {
          // System LaunchDaemon lives in /Library/LaunchDaemons/, user agent in ~/Library/LaunchAgents/
          const daemon = existsSync('/Library/LaunchDaemons/dev.pan.client.plist');
          state = daemon ? 'system' : 'user';
          manager = daemon ? 'launchd-daemon' : 'launchd-agent';
        }
      } catch {}
    } else if (PLATFORM === 'linux') {
      // System-level unit (root) — boot-time
      try {
        const out = execSync('systemctl is-active pan-client.service 2>/dev/null || true', { timeout: 2000, stdio: 'pipe' }).toString().trim();
        if (out === 'active') { state = 'system'; manager = 'systemd-system'; }
      } catch {}
      // User-level unit — login-time (or boot-time if linger is enabled, but we report 'user' either way)
      if (state === 'manual') {
        try {
          const out = execSync('systemctl --user is-active pan-client.service 2>/dev/null || true', { timeout: 2000, stdio: 'pipe' }).toString().trim();
          if (out === 'active') { state = 'user'; manager = 'systemd-user'; }
        } catch {}
      }
    }
  } catch {}
  _svcCache = { service_state: state, service_manager: manager };
  _svcCacheAt = Date.now();
  return _svcCache;
}

async function httpRegister() {
  const svc = detectServiceState();
  return httpRequest('POST', '/api/v1/client/register',
    { token: TOKEN, device_id: DEVICE_ID, name: NAME,
      platform: PLATFORM, arch: arch(), version: VERSION, capabilities, hostname: hostname(),
      service_state: svc.service_state, service_manager: svc.service_manager });
}

function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const mod = HUB_HTTP.startsWith('https') ? https : http;
    const u = new URL(HUB_HTTP + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { 'User-Agent': 'PAN-Client/1.0' };
    if (bodyStr) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(bodyStr); }
    const req = mod.request({ hostname: u.hostname, port: u.port || (HUB_HTTP.startsWith('https') ? 443 : 80),
      path: u.pathname + u.search, method, headers, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function httpPollStatus() {
  const r = await httpRequest('GET', `/api/v1/client/status?device_id=${encodeURIComponent(DEVICE_ID)}&token=${encodeURIComponent(TOKEN)}`);
  return r.body;
}

// ── WebSocket connection ─────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 2000;
let pingTimer = null;
let heartbeatTimer = null;
let connected = false;

// ── Local status file (#) ────────────────────────────────────────────────────
// PAN-tray.ps1 + PAN-status.ps1 (system tray UI installed alongside the client)
// poll this file every 5s to render the icon, tooltip, and status window.
// Disk-based on purpose: no extra port to open, no auth, and survives the
// client crashing — the tray will see a stale mtime and flip to red.
const STATUS_FILE = join(__dirname, 'pan-status.json');
let _lastHeartbeatOkMs = 0;
let _approved = null; // null=unknown, true/false from server
const BOOT_MS = Date.now();
function writeLocalStatus() {
  try {
    const now = Date.now();
    const heartbeatAgeMs = _lastHeartbeatOkMs ? (now - _lastHeartbeatOkMs) : null;
    // Stale if no heartbeat for 2 cycles (60s WS / 40s HTTP). Use 75s as upper bound.
    const heartbeatStale = heartbeatAgeMs !== null && heartbeatAgeMs > 75_000;
    const status = {
      schema: 1,
      pid: process.pid,
      device_id: DEVICE_ID,
      device_name: NAME,
      hub_ws: HUB_WS,
      hub_http: HUB_HTTP,
      version: VERSION,
      platform: PLATFORM,
      connected: !!connected,
      approved: _approved,
      mode: ws ? 'ws' : (connected ? 'http' : 'connecting'),
      last_heartbeat_ok_ms: _lastHeartbeatOkMs || null,
      heartbeat_age_ms: heartbeatAgeMs,
      heartbeat_stale: heartbeatStale,
      uptime_s: Math.round((now - BOOT_MS) / 1000),
      reconnect_delay_ms: reconnectDelay,
      written_at_ms: now,
    };
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch {}
}
// Write once immediately, then every 5s. Fast enough for the tray to feel
// responsive; cheap enough to be invisible on disk.
writeLocalStatus();
setInterval(writeLocalStatus, 5000);

function getWsUrl() {
  const url = new URL(HUB_WS.replace(/^http/, 'ws'));
  url.pathname = '/ws/client';
  url.searchParams.set('token', TOKEN);
  url.searchParams.set('device_id', DEVICE_ID);
  return url.toString();
}

function connect() {
  const url = getWsUrl();
  console.log(`[PAN Client] Connecting to ${HUB_WS}...`);

  ws = new WebSocket(url, {
    handshakeTimeout: 10000,
    // Allow self-signed certs on local Tailscale
    rejectUnauthorized: false,
  });

  ws.on('open', () => {
    connected = true;
    reconnectDelay = 2000;
    console.log(`[PAN Client] Connected ✓ (${NAME} / ${DEVICE_ID})`);

    // Send registration immediately
    {
      const svc = detectServiceState();
      send({ type: 'register', device_id: DEVICE_ID, name: NAME, version: VERSION,
             platform: PLATFORM, arch: arch(), capabilities,
             hostname: hostname(), token: TOKEN,
             service_state: svc.service_state, service_manager: svc.service_manager });
    }

    // Heartbeat every 30s
    heartbeatTimer = setInterval(sendHeartbeat, 30_000);

    // Ping every 15s to keep the connection alive through NAT
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.ping();
    }, 15_000);
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    await handleCommand(msg);
  });

  ws.on('close', (code, reason) => {
    connected = false;
    clearInterval(heartbeatTimer);
    clearInterval(pingTimer);
    console.log(`[PAN Client] Disconnected (${code}) — reconnecting in ${reconnectDelay / 1000}s`);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error(`[PAN Client] WS error: ${err.message}`);
    // 'close' fires after 'error' — reconnect handled there
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect();
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000);
  }, reconnectDelay);
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function probeServices() {
  return new Promise((resolve) => {
    let body = '';
    const req = http.get('http://localhost:11434/api/tags', { timeout: 3000 }, (res) => {
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const models = data.models || [];
          resolve([{ name: 'ollama', port: 11434, status: 'up', url: 'http://localhost:11434', modelCount: models.length, models: models.map(m => m.name) }]);
        } catch {
          resolve([{ name: 'ollama', port: 11434, status: 'up', url: 'http://localhost:11434', modelCount: 0, models: [] }]);
        }
      });
    });
    req.on('error', () => resolve([{ name: 'ollama', port: 11434, status: 'down', url: 'http://localhost:11434', modelCount: 0, models: [] }]));
    req.on('timeout', () => { req.destroy(); resolve([{ name: 'ollama', port: 11434, status: 'down', url: 'http://localhost:11434', modelCount: 0, models: [] }]); });
  });
}

// ── Local Claude Control ──────────────────────────────────────────────────────
// User design 2026-06-09: every pan-client machine should host its OWN Claude
// Code session so it can build a per-machine profile (favorites, file paths,
// app-launch habits) over time. The Hub already runs claude-control via the
// node-pty PTY in service/src/claude-control.js. Here we mirror the API
// without the native-build hassle by using `claude --print --continue` —
// Claude Code's documented persistent-session mode. Each pan-client machine's
// session lives in its own Claude Code memory store.
//
// API surface (mirrors server-side claude-control.js):
//   _initLocalClaude()          probe binary, start fresh session
//   sendToLocalClaude(text)     run one turn, capture output (returns Promise<string|null>)
//   getLocalClaudeStatus()      { available, version, last_send_at, sends, last_error }
//
// Failure handling: if `claude` isn't on PATH, sets _claude.available=false
// and the heartbeat just reports it. The hub-side router checks the flag
// before dispatching a `send_to_local_claude` command to this client.

const _claude = {
  available:      false,
  binPath:        null,
  version:        null,
  hasSession:     false,   // false until first --print succeeds; then --continue
  lastSendAt:     0,
  sends:          0,
  lastError:      null,
  recentOutput:   '',      // last successful Claude reply (≤4 KB)
  // Concurrency guard — Claude Code can crash if two --continue calls overlap
  // because they fight for the same session lock. Queue serial.
  busy:           false,
};

async function _probeBinary(file, args) {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false;
    try {
      // shell:true on Windows so .cmd / .bat shims execute through cmd.exe
      // — direct spawn of a .cmd file produces ENOENT / EINVAL on some Node
      // versions. Cost is negligible for one-shot probes.
      const p = spawn(file, args, { windowsHide: true, shell: IS_WINDOWS });
      p.stdout?.on('data', d => out += d.toString());
      p.stderr?.on('data', d => err += d.toString());
      p.on('close', (code) => { if (!settled) { settled = true; resolve({ ok: code === 0, stdout: out.trim(), stderr: err.trim() }); } });
      p.on('error', () => { if (!settled) { settled = true; resolve({ ok: false, stdout: out, stderr: err || 'spawn error' }); } });
      setTimeout(() => { if (!settled) { try { p.kill(); } catch {} settled = true; resolve({ ok: false, stdout: out, stderr: 'timeout' }); } }, 5000);
    } catch (e) { resolve({ ok: false, stdout: '', stderr: e.message }); }
  });
}

async function _initLocalClaude() {
  // Resolve binary once at startup. On Windows it's typically claude.cmd via
  // npm/nvm; on POSIX it's `claude` on PATH. The probe doubles as a version
  // check so the heartbeat can show what version each client is running.
  const probe = await _probeBinary(IS_WINDOWS ? 'where' : 'which', ['claude']);
  if (!probe.ok || !probe.stdout) {
    _claude.available = false;
    _claude.lastError = 'claude not on PATH';
    console.log('[ClaudeControl] not available — claude binary not on PATH');
    return;
  }
  // `where claude` on Windows returns multiple paths — typically the Unix
  // shell shim ('C:\nvm4w\nodejs\claude' with no extension) FIRST, then
  // the executable wrapper ('claude.cmd' / '.bat' / '.ps1' / '.exe').
  // Native node spawn() can't run the shim, so pick the executable suffix
  // explicitly. Order of preference matches what cmd.exe's PATHEXT defaults to.
  const candidates = probe.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (IS_WINDOWS) {
    const exts = ['.cmd', '.bat', '.exe', '.ps1'];
    const exec = candidates.find(p => exts.some(e => p.toLowerCase().endsWith(e)))
              || candidates[0]; // fall back if nothing matched (e.g. portable install)
    _claude.binPath = exec;
  } else {
    _claude.binPath = candidates[0];
  }
  // Version check via `claude --version`. If this errors, we still report
  // available=false rather than silently letting send calls explode.
  const ver = await _probeBinary(_claude.binPath, ['--version']);
  if (ver.ok) {
    _claude.version = ver.stdout || ver.stderr || 'unknown';
    _claude.available = true;
    console.log(`[ClaudeControl] available — ${_claude.binPath} (${_claude.version})`);
  } else {
    _claude.available = false;
    _claude.lastError = `version probe failed at ${_claude.binPath}: ${ver.stderr}`;
    console.warn(`[ClaudeControl] version probe failed at ${_claude.binPath}:`, ver.stderr);
  }
}

function sendToLocalClaude(text, timeoutMs = 180_000) {
  // 180s default — first call has no --continue and cold-starts a fresh
  // Claude Code session which can take 30-90s. Subsequent calls reuse
  // the session via --continue and typically return in 5-15s, but the
  // ceiling has to accommodate the cold start.
  return new Promise((resolve) => {
    if (!_claude.available) return resolve({ ok: false, error: 'claude not available on this host' });
    if (_claude.busy) return resolve({ ok: false, error: 'busy — previous send still in flight' });
    if (typeof text !== 'string' || !text.trim().length) return resolve({ ok: false, error: 'empty text' });

    _claude.busy = true;
    // `claude --print` runs a single non-interactive turn. `--continue` reuses
    // the most recent session so context (CLAUDE.md, prior decisions, learned
    // file paths, etc.) carries forward turn-to-turn — that's the "profile"
    // building up on this specific machine over time.
    //
    // Pass the prompt via stdin (NOT as a positional arg) — multi-word
    // prompts with shell:true on Windows get tokenized by cmd.exe and the
    // call hangs forever waiting on the wrong shape. stdin is universally
    // safe and matches how voice-call utterances flow naturally.
    const args = ['--print'];
    if (_claude.hasSession) args.push('--continue');

    // Windows spawn quirks (CVE-2024-27980 fallout):
    //   - shell:false + direct .cmd path → EINVAL on Node 20+
    //   - shell:true → cmd.exe owns stdin, proc.stdin.write() goes to cmd
    //     which discards it
    // Workaround: dump the prompt to a tmp file, then shell:true with
    // input redirection (`< tmpfile`). cmd.exe handles the redirect into
    // claude.cmd's stdin and everything threads through cleanly.
    // Use a fixed-location tmp dir under Public so it works equally well
    // whether pan-client runs as SYSTEM (Windows Service) or a normal user.
    // SYSTEM's os.tmpdir() resolves to a Windows service-specific path that
    // cmd.exe under shell:true couldn't always read back via `type`.
    const baseTmp = IS_WINDOWS ? 'C:\\Users\\Public\\pan-claude-tmp' : os.tmpdir();
    try { mkdirSync(baseTmp, { recursive: true }); } catch {}
    const promptFile = join(baseTmp, `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    let stdout = '', stderr = '', settled = false;
    let proc;
    try {
      writeFileSync(promptFile, text, 'utf8');
      // type tmpfile | claude.cmd --print [--continue]
      // Path NOT quoted on Windows — cmd.exe under shell:true mishandles
      // double-quotes around a single token even when there are no spaces,
      // resulting in "command not recognised". The nvm4w install path
      // (default) has no spaces so this is safe. If a future install path
      // contains spaces, we'd need 8.3 short-name resolution.
      const cmdLine = IS_WINDOWS
        ? `type "${promptFile}" | ${_claude.binPath} ${args.join(' ')}`
        : `cat "${promptFile}" | "${_claude.binPath}" ${args.join(' ')}`;
      console.log('[ClaudeControl] spawn cmdLine:', cmdLine);
      proc = spawn(cmdLine, { windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      _claude.busy = false;
      _claude.lastError = `spawn failed: ${e.message}`;
      return resolve({ ok: false, error: _claude.lastError });
    }
    proc.stdout?.on('data', d => stdout += d.toString());
    proc.stderr?.on('data', d => stderr += d.toString());
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      try { unlinkSync(promptFile); } catch {}
      _claude.busy = false;
      _claude.lastSendAt = Date.now();
      _claude.sends += 1;
      if (code !== 0) {
        _claude.lastError = `exit ${code}: ${stderr.slice(0, 300)}`;
        console.warn('[ClaudeControl] exit ' + code + ' stderr=' + JSON.stringify(stderr.slice(0,500)) + ' stdout=' + JSON.stringify(stdout.slice(0,500)));
        return resolve({ ok: false, error: _claude.lastError, stdout, stderr });
      }
      _claude.hasSession = true; // future calls can use --continue
      _claude.recentOutput = stdout.slice(-4096);
      _claude.lastError = null;
      resolve({ ok: true, output: stdout, stderr });
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      _claude.busy = false;
      _claude.lastError = err.message;
      resolve({ ok: false, error: err.message });
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}
      _claude.busy = false;
      _claude.lastError = `timeout > ${timeoutMs}ms`;
      resolve({ ok: false, error: _claude.lastError, stdout, stderr });
    }, timeoutMs);
  });
}

function getLocalClaudeStatus() {
  return {
    available:    _claude.available,
    version:      _claude.version,
    has_session:  _claude.hasSession,
    last_send_at: _claude.lastSendAt,
    sends:        _claude.sends,
    last_error:   _claude.lastError,
    bin_path:     _claude.binPath,
  };
}

// ── Ollama watchdog ───────────────────────────────────────────────────────────
// Throttle: don't attempt restart more than once every 5 minutes.
let _ollamaLastRestartAttempt = 0;
const OLLAMA_RESTART_THROTTLE_MS = 5 * 60 * 1000;

// Required models — if Ollama is up but these are missing, pull them automatically.
const REQUIRED_MODELS = ['minicpm-v'];
let _ollamaLastPullAttempt = 0;
const OLLAMA_PULL_THROTTLE_MS = 30 * 60 * 1000; // don't re-pull more than once per 30min

function pullMissingModels(missingModels) {
  const now = Date.now();
  if (now - _ollamaLastPullAttempt < OLLAMA_PULL_THROTTLE_MS) return;
  _ollamaLastPullAttempt = now;
  for (const model of missingModels) {
    console.log(`[Watchdog] Ollama model '${model}' missing — pulling now...`);
    const ollamaExe = IS_WINDOWS
      ? `"${process.env.LOCALAPPDATA || 'C:\\Users\\' + require('os').userInfo().username + '\\AppData\\Local'}\\Programs\\Ollama\\ollama.exe"`
      : 'ollama';
    try {
      spawn(IS_WINDOWS ? 'cmd' : 'sh',
        IS_WINDOWS ? ['/c', `${ollamaExe} pull ${model}`] : ['-c', `ollama pull ${model}`],
        { windowsHide: true, detached: true, stdio: 'ignore' }
      ).unref();
      console.log(`[Watchdog] Pull started for ${model}`);
    } catch (err) {
      console.error(`[Watchdog] Failed to pull ${model}:`, err.message);
    }
  }
}

// Restart history — every attempt is recorded and shipped in the next
// heartbeat so the hub user can SEE in the dashboard what's been tried,
// what worked, what failed, and what error each attempt produced.
// Cleared after a successful Ollama probe so the list shows the current
// down episode only.
const _restartHistory = [];
function _logRestart(entry) {
  _restartHistory.push({ ts: Date.now(), ...entry });
  // Keep last 20 — enough for diagnosis, bounded to keep heartbeat small
  if (_restartHistory.length > 20) _restartHistory.shift();
  console.log('[Watchdog] restart attempt:', JSON.stringify(entry));
}
function getRestartHistory() { return _restartHistory.slice(); }
function clearRestartHistory() { _restartHistory.length = 0; }

// Run a command synchronously enough to CAPTURE its output so we know what
// actually happened. Previously every restart path used spawn+detach+stdio:
// 'ignore' — even when ollama serve immediately errored ('port in use',
// 'model store corrupt', 'access denied'), the error vanished into the void
// and the watchdog kept retrying forever with no signal back to the user.
// Now: a short-lived probe captures stdout/stderr/exitCode and ships them
// back in the heartbeat. The actual long-lived process (when we DO want to
// detach) is started separately AFTER we know the binary at least exists.
function probeCommand(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    try {
      const p = spawn(cmd, args, { windowsHide: true });
      p.stdout?.on('data', d => stdout += d.toString());
      p.stderr?.on('data', d => stderr += d.toString());
      p.on('close', (code) => {
        if (!settled) { settled = true; resolve({ ok: code === 0, exitCode: code, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) }); }
      });
      p.on('error', (err) => {
        if (!settled) { settled = true; resolve({ ok: false, exitCode: null, stdout, stderr: err.message }); }
      });
      setTimeout(() => {
        if (!settled) { try { p.kill(); } catch {} settled = true; resolve({ ok: false, exitCode: null, stdout, stderr: stderr || 'timeout' }); }
      }, timeoutMs);
    } catch (err) {
      if (!settled) { settled = true; resolve({ ok: false, exitCode: null, stdout: '', stderr: err.message }); }
    }
  });
}

async function restartOllama() {
  // Step 1: Is the binary even on PATH? Before this, a missing Ollama install
  // produced silent spawn-failed retries every 5 minutes for days.
  const probe = await probeCommand(IS_WINDOWS ? 'where' : 'which', ['ollama'], 3000);
  if (!probe.ok) {
    _logRestart({ step: 'probe_binary', ok: false, error: 'ollama not on PATH', stdout: probe.stdout, stderr: probe.stderr });
    return;
  }
  _logRestart({ step: 'probe_binary', ok: true, path: probe.stdout.trim().slice(0, 200) });

  // Step 2: Is port 11434 already bound by a zombie? If yes, spawning a new
  // 'ollama serve' will error 'bind: address already in use' silently.
  // Diagnose this so the user can decide to kill the zombie manually.
  if (IS_WINDOWS) {
    const portProbe = await probeCommand('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort 11434 -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; "$($_.OwningProcess) $($p.ProcessName)" }`
    ], 3000);
    if (portProbe.stdout.trim()) {
      _logRestart({ step: 'port_check', ok: false, error: 'port 11434 already bound', pid_process: portProbe.stdout.trim().slice(0, 150) });
      // Don't try to restart — there's something there. User must kill the zombie.
      return;
    }
  }

  // Step 3: Launch ollama serve. Use detached + unref so it outlives this
  // pan-client, but route stderr to a log file so we capture failures.
  // Previously stdio:'ignore' threw away the most important diagnostic
  // signal in the entire system. Now we always have an Ollama log.
  if (IS_WINDOWS) {
    // Try the desktop shortcut first (launches the tray app + server)
    try {
      spawn('cmd', ['/c', 'start', '', 'C:\\Users\\Public\\Desktop\\Ollama.lnk'], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      }).unref();
      _logRestart({ step: 'launch_shortcut', ok: true, path: 'C:\\Users\\Public\\Desktop\\Ollama.lnk' });
      return;
    } catch (err) {
      _logRestart({ step: 'launch_shortcut', ok: false, error: err.message });
    }
  }
  // Fallback (Windows + Linux/macOS): ollama serve directly, with stderr captured.
  try {
    const logPath = IS_WINDOWS ? 'C:\\Users\\Public\\ollama-watchdog.log' : '/tmp/ollama-watchdog.log';
    const out = createWriteStream(logPath, { flags: 'a' });
    out.write(`\n=== ${new Date().toISOString()} pan-client restart attempt ===\n`);
    const p = spawn('ollama', ['serve'], { windowsHide: true, detached: true, stdio: ['ignore', out, out] });
    p.unref();
    _logRestart({ step: 'launch_serve', ok: true, pid: p.pid, log_path: logPath });
  } catch (err) {
    _logRestart({ step: 'launch_serve', ok: false, error: err.message });
  }
}

async function sendHeartbeat() {
  let services = await probeServices();

  // Watchdog: if Ollama is down, attempt to start it (throttled to once per 5 min).
  // restartOllama() now records every step (binary probe, port check, launch
  // attempt) into _restartHistory which the heartbeat ships so the hub user
  // can see WHY restarts are failing.
  const ollamaSvc = services.find(s => s.name === 'ollama');
  const ollamaDown = ollamaSvc?.status === 'down';
  if (ollamaDown) {
    const now = Date.now();
    if (now - _ollamaLastRestartAttempt >= OLLAMA_RESTART_THROTTLE_MS) {
      _ollamaLastRestartAttempt = now;
      console.log('[Watchdog] Ollama down — attempting restart');
      await restartOllama();
      // Wait 8s then re-probe so the heartbeat carries fresh status
      await new Promise(r => setTimeout(r, 8000));
      services = await probeServices();
    }
  } else if (_restartHistory.length > 0) {
    // Ollama recovered — clear history so the next down-episode shows clean.
    clearRestartHistory();
  }

  // Watchdog: if Ollama is up but required models are missing (e.g. wiped by upgrade), pull them
  if (!ollamaDown && ollamaSvc) {
    const installedModels = ollamaSvc.models || [];
    const missing = REQUIRED_MODELS.filter(m => !installedModels.some(i => i.startsWith(m)));
    if (missing.length > 0) {
      console.warn(`[Watchdog] ⚠️ Ollama up but missing required models: ${missing.join(', ')} — pulling`);
      pullMissingModels(missing);
    }
  }

  const svc = detectServiceState();
  send({
    type: 'heartbeat',
    device_id: DEVICE_ID,
    mem_free_mb: Math.round(freemem() / 1024 / 1024),
    mem_total_mb: Math.round(totalmem() / 1024 / 1024),
    uptime_s: Math.round(process.uptime()),
    timestamp: Date.now(),
    services,
    service_state: svc.service_state,
    service_manager: svc.service_manager,
    // Restart history for active down episodes. Empty when everything's
    // healthy. When Ollama is wedged, this is the user's window into what
    // pan-client has actually tried.
    restart_history: getRestartHistory(),
    // Local Claude Code availability — the hub-side router uses this to
    // decide whether to dispatch send_to_local_claude commands here.
    claude_control: getLocalClaudeStatus(),
  });
  // Stamp local heartbeat clock so the tray can render age accurately. We
  // stamp on SEND (not server-ack) because WS doesn't ack at the message
  // layer — if the socket is open and send() didn't throw, the bytes are
  // in flight. ws.on('close') will flip `connected` back to false anyway.
  if (ws?.readyState === WebSocket.OPEN) _lastHeartbeatOkMs = Date.now();
}

// Returns the title of the currently focused window, or null.
async function getActiveWindow() {
  try {
    if (IS_WINDOWS) {
      const script = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          public class Win32 {
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll", CharSet = CharSet.Unicode)]
            public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
          }
"@
        $h = [Win32]::GetForegroundWindow()
        $s = New-Object System.Text.StringBuilder 256
        [Win32]::GetWindowText($h, $s, 256) | Out-Null
        $s.ToString()
      `.trim();
      const out = execSync(`powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        { timeout: 3000, windowsHide: true }).toString().trim();
      return out || null;
    } else if (PLATFORM === 'linux') {
      const out = execSync('xdotool getactivewindow getwindowname 2>/dev/null || wmctrl -a :ACTIVE: -v 2>&1 | head -1',
        { timeout: 2000 }).toString().trim();
      return out || null;
    } else if (PLATFORM === 'darwin') {
      const out = execSync(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`,
        { timeout: 2000 }).toString().trim();
      return out || null;
    }
  } catch {}
  return null;
}

// Infer a short activity label from window title
function inferActivity(title) {
  if (!title) return 'idle';
  const t = title.toLowerCase();
  if (t.includes('visual studio') || t.includes('vs code') || t.includes('cursor') || t.includes('.js') || t.includes('.py') || t.includes('.ts')) return 'coding';
  if (t.includes('chrome') || t.includes('firefox') || t.includes('edge') || t.includes('brave')) return 'browsing';
  if (t.includes('slack') || t.includes('discord') || t.includes('teams') || t.includes('zoom')) return 'communicating';
  if (t.includes('terminal') || t.includes('cmd') || t.includes('powershell') || t.includes('bash')) return 'terminal';
  if (t.includes('youtube') || t.includes('netflix') || t.includes('vlc') || t.includes('mpv')) return 'watching';
  if (t.includes('figma') || t.includes('photoshop') || t.includes('illustrator')) return 'designing';
  if (t.includes('word') || t.includes('docs') || t.includes('notion') || t.includes('obsidian')) return 'writing';
  if (t.includes('excel') || t.includes('sheets') || t.includes('numbers')) return 'spreadsheets';
  return 'active';
}

async function sendPresence() {
  try {
    const screenTitle = await getActiveWindow();
    const activity = inferActivity(screenTitle);
    const userId = config.owner || NAME;
    await httpRequest('POST', '/api/v1/client/presence', {
      device_id: DEVICE_ID,
      user_id: userId,
      activity,
      screen_title: screenTitle,
      confidence: screenTitle ? 70 : 20,  // lower confidence if we only have heartbeat-level data
      platform: PLATFORM,
    });
  } catch {}  // non-critical — don't crash heartbeat loop
}

// ── Command handlers ──────────────────────────────────────────────────────────
async function handleCommand(msg) {
  const { id, type, ...params } = msg;

  function reply(result, error = null) {
    if (ws?.readyState === WebSocket.OPEN) {
      // WebSocket mode — send result back via WS
      send({ type: 'command_result', id, command_type: type, ok: !error, result, error });
    } else if (id) {
      // HTTP mode — POST result back to hub
      httpRequest('POST', '/api/v1/client/result',
        { device_id: DEVICE_ID, token: TOKEN, id, ok: !error, result, error }).catch(() => {});
    }
  }

  console.log(`[PAN Client] CMD ${type}${id ? ` (${id})` : ''}`);

  try {
    switch (type) {
      case 'ping':
        reply({ pong: true, ts: Date.now() });
        break;

      case 'shell_exec':
        await cmdShellExec(params, reply, id);
        break;

      case 'notification':
        await cmdNotification(params);
        reply({ shown: true });
        break;

      case 'open_app':
        await cmdOpenApp(params);
        reply({ opened: true });
        break;

      case 'open_url':
        await cmdOpenUrl(params);
        reply({ opened: true });
        break;

      case 'tts_speak':
        await cmdTtsSpeak(params);
        reply({ spoken: true });
        break;

      case 'screenshot':
        await cmdScreenshot(params, reply);
        break;

      case 'audio_capture':
        await cmdAudioCapture(params, reply);
        break;

      case 'media_control':
        await cmdMediaControl(params);
        reply({ ok: true });
        break;

      case 'display_control':
        await cmdDisplayControl(params);
        reply({ ok: true });
        break;

      case 'file_transfer':
        await cmdFileTransfer(params, reply);
        break;

      case 'restart_service': {
        const service = params.service || params.action?.replace('restart_', '');
        if (service === 'ollama') {
          try {
            console.log('[Watchdog] restart_service command received — restarting Ollama immediately');
            restartOllama();
            // Wait 8s then re-probe for accurate status
            await new Promise(r => setTimeout(r, 8000));
            const services = await probeServices();
            const ollamaSvc = services.find(s => s.name === 'ollama');
            reply({ ok: true, service: 'ollama', action: 'restart_attempted', status: ollamaSvc?.status || 'unknown' });
          } catch (err) {
            reply(null, `Failed to restart ollama: ${err.message}`);
          }
        } else {
          reply(null, `Unknown service: ${service}`);
        }
        break;
      }

      case 'eval_window':
      case 'wrap_app':
      case 'stream_receive':
      case 'ble_scan':
      case 'smart_home':
        // Phase 6 / stub
        reply(null, `Command type '${type}' requires Tauri shell — not yet implemented`);
        break;

      case 'send_to_local_claude': {
        // Hub-dispatched computer-control command for THIS machine. Runs the
        // user's text against the local Claude Code session (persistent via
        // --continue), captures stdout, returns it so the hub can speak it
        // back as TTS or surface it in the dashboard.
        try {
          const text = params.text || params.command || '';
          // Honor hub-supplied claude_timeout_ms when present; otherwise
          // let sendToLocalClaude use its 180s default — first call after
          // a fresh session cold-starts and routinely runs 30-90s.
          const timeout_ms = params.claude_timeout_ms || 180_000;
          if (!_claude.available) {
            reply(null, 'claude-control not available on this host');
            break;
          }
          const r = await sendToLocalClaude(text, timeout_ms);
          if (!r.ok) {
            reply(null, r.error || 'send_to_local_claude failed');
            break;
          }
          reply({
            ok: true,
            output: (r.output || '').slice(0, 8000),
            sends:  _claude.sends,
            host:   DEVICE_ID,
          });
        } catch (err) {
          reply(null, `send_to_local_claude error: ${err.message}`);
        }
        break;
      }

      case 'self_update': {
        // Auto-update path. Pulls latest pan-client.js from git and respawns
        // ourselves. No manual SSH/RDP needed for the user — the hub sends
        // this command and the remote machine updates itself.
        //
        // Strategy depends on how this pan-client was installed:
        //  - git clone: just `git pull` in the pan-client directory and respawn
        //  - copied file: ask the hub to ship the new pan-client.js (params.bundle
        //    is a base64-encoded string) and write it locally
        //
        // After the new code is on disk we re-exec ourselves so the running
        // process is the updated one. process.argv is preserved so config,
        // tokens, names all carry over.
        const strategy = params.strategy || 'git_pull';
        try {
          if (strategy === 'git_pull') {
            const repoRoot = join(__dirname, '..');
            const probe = await new Promise((resolve) => {
              execFile('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, windowsHide: true }, (err, out) => {
                resolve(err ? null : out.toString().trim());
              });
            });
            if (!probe) {
              reply(null, 'self_update strategy=git_pull but ' + repoRoot + ' is not a git repo');
              break;
            }
            const result = await new Promise((resolve) => {
              execFile('git', ['pull', '--ff-only'], { cwd: repoRoot, windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
                resolve({ ok: !err, stdout: (stdout || '').toString().slice(0, 1000), stderr: (stderr || '').toString().slice(0, 1000) });
              });
            });
            if (!result.ok) {
              reply(null, `git pull failed: ${result.stderr || 'unknown'}`);
              break;
            }
            reply({ ok: true, strategy: 'git_pull', stdout: result.stdout, stderr: result.stderr, respawning_in_ms: 1500 });
            // Respawn with the same args. The OS-level service manager (pm2 /
            // systemd / Task Scheduler / nssm) will re-launch us with the new
            // code. If no service manager is in front of us, exit cleanly so a
            // wrapper loop (or the user) restarts.
            setTimeout(() => {
              console.log('[Self-Update] git pull complete — exiting for respawn');
              process.exit(0);
            }, 1500);
          } else if (strategy === 'bundle' && typeof params.bundle === 'string') {
            // Hub-pushed bundle: write the new pan-client.js to disk, then
            // exit so the supervisor respawns us. Backup the old one first
            // so a bad push is recoverable.
            const targetPath = join(__dirname, 'pan-client.js');
            const backupPath = targetPath + '.prev';
            try { writeFileSync(backupPath, readFileSync(targetPath)); } catch {}
            writeFileSync(targetPath, Buffer.from(params.bundle, 'base64'));
            reply({ ok: true, strategy: 'bundle', written_bytes: params.bundle.length, respawning_in_ms: 1500 });
            setTimeout(() => {
              console.log('[Self-Update] bundle written — exiting for respawn');
              process.exit(0);
            }, 1500);
          } else {
            reply(null, `Unknown self_update strategy: ${strategy}`);
          }
        } catch (err) {
          reply(null, `self_update failed: ${err.message}`);
        }
        break;
      }

      default:
        reply(null, `Unknown command type: ${type}`);
    }
  } catch (err) {
    console.error(`[PAN Client] Error in ${type}:`, err.message);
    send({ type: 'command_result', id, command_type: type, ok: false, error: err.message });
  }
}

// ── shell_exec ───────────────────────────────────────────────────────────────
function cmdShellExec({ command, cwd, timeout_ms = 30_000 }, reply, cmdId) {
  return new Promise((resolve) => {
    const shell = IS_WINDOWS ? 'cmd' : 'bash';
    const shellFlag = IS_WINDOWS ? '/c' : '-c';
    let output = '';
    let errOutput = '';
    const chunks = [];

    const child = exec(command, {
      cwd: cwd || process.cwd(),
      timeout: timeout_ms,
      shell: IS_WINDOWS ? 'cmd.exe' : '/bin/bash',
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => {
      output += chunk;
      // Stream output chunks back to hub
      send({ type: 'shell_output', id: cmdId, chunk: chunk.toString() });
    });
    child.stderr.on('data', (chunk) => {
      errOutput += chunk;
      send({ type: 'shell_output', id: cmdId, chunk: chunk.toString(), stream: 'stderr' });
    });
    child.on('close', (code) => {
      reply({ exit_code: code, stdout: output, stderr: errOutput });
      resolve();
    });
    child.on('error', (err) => {
      reply(null, err.message);
      resolve();
    });
  });
}

// ── notification ─────────────────────────────────────────────────────────────
function cmdNotification({ title = 'PAN', message, urgency = 'normal' }) {
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      // PowerShell toast notification
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $true
$notify.ShowBalloonTip(5000, '${title.replace(/'/g, "''")}', '${message.replace(/'/g, "''")}', [System.Windows.Forms.ToolTipIcon]::None)
Start-Sleep -Milliseconds 5500
$notify.Dispose()
`;
      execFile('powershell', ['-NoProfile', '-Command', ps],
        { windowsHide: true }, () => resolve());
    } else if (PLATFORM === 'linux') {
      execFile('notify-send', [title, message, '-u', urgency],
        { windowsHide: true }, () => resolve());
    } else if (PLATFORM === 'darwin') {
      execFile('osascript', ['-e', `display notification "${message}" with title "${title}"`],
        { windowsHide: true }, () => resolve());
    } else {
      resolve();
    }
  });
}

// ── open_app ─────────────────────────────────────────────────────────────────
function cmdOpenApp({ app }) {
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      execFile('powershell', ['-NoProfile', '-Command', `Start-Process '${app}'`],
        { windowsHide: true }, () => resolve());
    } else if (PLATFORM === 'darwin') {
      execFile('open', ['-a', app], () => resolve());
    } else {
      execFile(app, [], { detached: true }, () => resolve());
    }
  });
}

// ── open_url ─────────────────────────────────────────────────────────────────
function cmdOpenUrl({ url }) {
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      execFile('powershell', ['-NoProfile', '-Command', `Start-Process '${url}'`],
        { windowsHide: true }, () => resolve());
    } else if (PLATFORM === 'darwin') {
      execFile('open', [url], () => resolve());
    } else {
      execFile('xdg-open', [url], () => resolve());
    }
  });
}

// ── tts_speak ────────────────────────────────────────────────────────────────
function cmdTtsSpeak({ text, rate = 1.0, voice }) {
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      const voiceParam = voice ? `$s.Voice = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -match '${voice}' } | Select-Object -First 1 -ExpandProperty VoiceInfo; ` : '';
      const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voiceParam}$s.Rate = ${Math.round((rate - 1) * 10)}
$s.Speak('${text.replace(/'/g, "''")}')
`;
      execFile('powershell', ['-NoProfile', '-Command', ps],
        { windowsHide: true }, () => resolve());
    } else if (PLATFORM === 'darwin') {
      const args = voice ? ['-v', voice, text] : [text];
      execFile('say', args, () => resolve());
    } else {
      execFile('espeak', [text], () => resolve());
    }
  });
}

// ── screenshot ───────────────────────────────────────────────────────────────
function cmdScreenshot({ format = 'jpeg', quality = 80 }, reply) {
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
[Convert]::ToBase64String($ms.ToArray())
`;
      execFile('powershell', ['-NoProfile', '-Command', ps],
        { windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
        (err, stdout) => {
          if (err) { reply(null, err.message); resolve(); return; }
          reply({ data: stdout.trim(), mime: 'image/jpeg', encoding: 'base64' });
          resolve();
        });
    } else if (PLATFORM === 'darwin') {
      const tmpFile = `/tmp/pan-screenshot-${Date.now()}.jpg`;
      execFile('screencapture', ['-x', '-t', 'jpg', tmpFile], (err) => {
        if (err) { reply(null, err.message); resolve(); return; }
        try {
          const data = readFileSync(tmpFile).toString('base64');
          reply({ data, mime: 'image/jpeg', encoding: 'base64' });
        } catch (e) { reply(null, e.message); }
        resolve();
      });
    } else {
      // Linux: try scrot or import (ImageMagick)
      const tmpFile = `/tmp/pan-screenshot-${Date.now()}.png`;
      execFile('scrot', [tmpFile], (err) => {
        if (err) { reply(null, 'scrot not available: ' + err.message); resolve(); return; }
        try {
          const data = readFileSync(tmpFile).toString('base64');
          reply({ data, mime: 'image/png', encoding: 'base64' });
        } catch (e) { reply(null, e.message); }
        resolve();
      });
    }
  });
}

// ── media_control ────────────────────────────────────────────────────────────
function cmdMediaControl({ action }) {
  // action: play, pause, next, prev, volume_up, volume_down, mute
  return new Promise((resolve) => {
    if (IS_WINDOWS) {
      const keyMap = {
        play: '0xB3', pause: '0xB3', next: '0xB0', prev: '0xB1',
        volume_up: '0xAF', volume_down: '0xAE', mute: '0xAD',
      };
      const key = keyMap[action];
      if (!key) { resolve(); return; }
      const ps = `
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public class PAN {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
}
"@
[PAN]::keybd_event(${key}, 0, 1, 0)
[PAN]::keybd_event(${key}, 0, 3, 0)
`;
      execFile('powershell', ['-NoProfile', '-Command', ps],
        { windowsHide: true }, () => resolve());
    } else if (PLATFORM === 'linux') {
      const keyMap = {
        play: 'XF86AudioPlay', pause: 'XF86AudioPause', next: 'XF86AudioNext',
        prev: 'XF86AudioPrev', volume_up: 'XF86AudioRaiseVolume',
        volume_down: 'XF86AudioLowerVolume', mute: 'XF86AudioMute',
      };
      const key = keyMap[action];
      if (key) execFile('xdotool', ['key', key], () => resolve());
      else resolve();
    } else {
      resolve();
    }
  });
}

// ── display_control ──────────────────────────────────────────────────────────
function cmdDisplayControl({ action }) {
  // action: sleep, wake, brightness_up, brightness_down
  return new Promise((resolve) => {
    if (IS_WINDOWS && action === 'sleep') {
      execFile('powershell', ['-NoProfile', '-Command',
        `(Add-Type -MemberDefinition '[DllImport("user32.dll")]public static extern int SendMessage(int hWnd,int hMsg,int wParam,int lParam);' -Name T -PassThru)::SendMessage(-1,0x0112,0xF170,2)`],
        { windowsHide: true }, () => resolve());
    } else if (PLATFORM === 'darwin' && action === 'sleep') {
      execFile('pmset', ['displaysleepnow'], () => resolve());
    } else {
      resolve();
    }
  });
}

// ── audio_capture ─────────────────────────────────────────────────────────────
// Push-to-talk mic capture. Records `duration_ms` of audio via ffmpeg using the
// OS-native default input device, returns base64-encoded 16-bit PCM WAV.
//
// Requires ffmpeg on PATH. PAN clients that ship with the whisper STT pipeline
// already have it; clients that don't will get a clear "ffmpeg not found" error.
function cmdAudioCapture({ duration_ms = 5000, sample_rate = 16000 }, reply) {
  return new Promise((resolve) => {
    const tmpDir = process.env.TEMP || process.env.TMPDIR || '/tmp';
    const tmpFile = join(tmpDir, `pan-capture-${Date.now()}-${process.pid}.wav`);
    const seconds = (Math.max(500, Math.min(30000, Number(duration_ms) || 5000)) / 1000).toFixed(3);

    // Per-platform ffmpeg input selection.
    //   Windows: dshow with "default" (most installs route this to the active mic)
    //   macOS:   avfoundation with ":0" (default audio input)
    //   Linux:   pulse "default"  (falls back to alsa "default" if pulse missing)
    let inputArgs;
    if (IS_WINDOWS) {
      inputArgs = ['-f', 'dshow', '-i', 'audio=default'];
    } else if (PLATFORM === 'darwin') {
      inputArgs = ['-f', 'avfoundation', '-i', ':0'];
    } else {
      inputArgs = ['-f', 'pulse', '-i', 'default'];
    }

    const ffArgs = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      ...inputArgs,
      '-t', seconds,
      '-ac', '1',
      '-ar', String(sample_rate),
      '-acodec', 'pcm_s16le',
      tmpFile,
    ];

    let child;
    try {
      child = spawn('ffmpeg', ffArgs, { windowsHide: true });
    } catch (e) {
      reply(null, `ffmpeg spawn failed: ${e.message}`);
      return resolve();
    }

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('error', (err) => {
      reply(null, `ffmpeg error: ${err.message} (ffmpeg installed?)`);
      resolve();
    });

    // Hard stop: ffmpeg may run slightly long. Kill after duration + 3s safety.
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, Number(duration_ms) + 3000);

    child.on('close', (code) => {
      clearTimeout(killTimer);
      try {
        if (!existsSync(tmpFile)) {
          reply(null, `ffmpeg produced no output (code ${code}) ${stderr.slice(-300)}`);
          return resolve();
        }
        const buf = readFileSync(tmpFile);
        try { unlinkSync(tmpFile); } catch {}
        const audio_b64 = buf.toString('base64');
        reply({
          audio_b64,
          format: 'wav',
          sample_rate,
          seconds: Number(seconds),
          bytes: buf.length,
        });
      } catch (e) {
        reply(null, `audio_capture read failed: ${e.message}`);
      }
      resolve();
    });
  });
}

// ── file_transfer ─────────────────────────────────────────────────────────────
function cmdFileTransfer({ direction, url, local_path }, reply) {
  return new Promise((resolve) => {
    if (direction === 'download') {
      // Download from hub URL to local path
      const proto = url.startsWith('https') ? https : http;
      const file = createWriteStream(local_path);
      proto.get(url, (res) => {
        res.pipe(file);
        file.on('finish', () => { file.close(); reply({ saved: local_path }); resolve(); });
      }).on('error', (err) => { reply(null, err.message); resolve(); });
    } else {
      reply(null, 'Upload not yet implemented');
      resolve();
    }
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
console.log(`[PAN Client] v${VERSION} — ${NAME} (${PLATFORM}/${arch()})`);
console.log(`[PAN Client] Hub: ${HUB_WS}`);
console.log(`[PAN Client] Hub HTTP: ${HUB_HTTP}`);

// Probe Claude Code at startup so the first heartbeat already reports
// availability accurately. Non-blocking — if claude isn't installed, the
// flag stays false and the hub-side router won't dispatch send_to_local_claude
// commands to this device.
_initLocalClaude().catch(e => console.warn('[ClaudeControl] init failed:', e.message));

async function boot() {
  // Step 1: HTTP register — works through Cloudflare (no WebSocket upgrade needed)
  console.log('[PAN Client] Registering with hub via HTTP...');
  let registered = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await httpRegister();
      if (res.status === 200 && res.body?.ok) {
        console.log(`[PAN Client] Registered ✓ status=${res.body.status}`);
        registered = true;
        break;
      } else if (res.status === 403) {
        console.error('[PAN Client] Device was denied by hub owner. Exiting.');
        process.exit(1);
      } else if (res.status === 401) {
        console.error('[PAN Client] Invalid or expired token. Exiting.');
        process.exit(1);
      } else {
        console.error(`[PAN Client] Registration failed (attempt ${attempt}): HTTP ${res.status} ${JSON.stringify(res.body)}`);
      }
    } catch (err) {
      console.error(`[PAN Client] Registration error (attempt ${attempt}): ${err.message}`);
    }
    if (attempt < 5) await new Promise(r => setTimeout(r, 3000));
  }

  if (!registered) {
    console.error('[PAN Client] Could not reach hub after 5 attempts. Check the hub URL and your internet connection.');
    process.exit(1);
  }

  // Step 2: Poll for approval (hub owner sees the request in their dashboard)
  console.log('[PAN Client] Waiting for hub owner to approve this device...');
  let approved = false;
  const POLL_INTERVAL = 5000;
  const MAX_WAIT = 10 * 60 * 1000; // 10 minutes
  const started = Date.now();
  let lastLog = 0;
  while (Date.now() - started < MAX_WAIT) {
    try {
      const status = await httpPollStatus();
      if (status.status === 'approved') {
        console.log('[PAN Client] Approved by hub owner! ✓ Connecting...');
        approved = true;
        _approved = true;
        break;
      } else if (status.status === 'denied') {
        console.error('[PAN Client] Connection denied by hub owner.');
        _approved = false;
        process.exit(1);
      } else {
        _approved = false; // pending = not-yet-approved for tray display
      }
      // Still pending — log every 30s so the window doesn't look frozen
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (Date.now() - lastLog > 30000) {
        console.log(`[PAN Client] Pending approval... (${elapsed}s elapsed)`);
        lastLog = Date.now();
      }
    } catch (err) {
      // Network hiccup — keep polling
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  if (!approved) {
    console.error('[PAN Client] Timed out waiting for approval (10 min). Exiting.');
    process.exit(1);
  }

  // Step 3: Try WebSocket (works on same network / Tailscale)
  // If it fails, fall back to HTTP polling — the only thing that works through Cloudflare.
  let wsWorking = false;
  ws = new WebSocket(getWsUrl(), { handshakeTimeout: 8000, rejectUnauthorized: false });
  await new Promise(resolve => {
    ws.once('open', () => { wsWorking = true; resolve(); });
    ws.once('error', () => resolve()); // error fires before close
    ws.once('close', resolve);
    setTimeout(resolve, 9000); // don't wait forever
  });

  if (wsWorking) {
    console.log('[PAN Client] WebSocket connected ✓ — using real-time mode');
    // Send register immediately for the initial connection (ws.once('open') already fired,
    // so the ws.on('open') handler below won't run until the next reconnect).
    connected = true;
    {
      const svc = detectServiceState();
      send({ type: 'register', device_id: DEVICE_ID, name: NAME, version: VERSION,
             platform: PLATFORM, arch: arch(), capabilities, hostname: hostname(), token: TOKEN,
             service_state: svc.service_state, service_manager: svc.service_manager });
    }
    heartbeatTimer = setInterval(sendHeartbeat, 30_000);
    pingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 15_000);
    setInterval(sendPresence, 30_000);
    sendPresence();
    // T2: live capability poll — refresh devices.capabilities JSON every 5min via /register upsert
    setInterval(refreshCapabilitiesAndReregister, CAP_REFRESH_MS);
    refreshCapabilitiesAndReregister(); // initial probe

    // Normal WS path — reconnect on drop (also re-registers on every reconnect)
    ws.on('open', () => {
      connected = true;
      reconnectDelay = 2000;
      const svc = detectServiceState();
      send({ type: 'register', device_id: DEVICE_ID, name: NAME, version: VERSION,
             platform: PLATFORM, arch: arch(), capabilities, hostname: hostname(), token: TOKEN,
             service_state: svc.service_state, service_manager: svc.service_manager });
      heartbeatTimer = setInterval(sendHeartbeat, 30_000);
      pingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 15_000);
      setInterval(sendPresence, 30_000);
      sendPresence(); // initial presence on connect
      setInterval(refreshCapabilitiesAndReregister, CAP_REFRESH_MS);
      refreshCapabilitiesAndReregister();
    });
    ws.on('message', async (data) => { let msg; try { msg = JSON.parse(data); } catch { return; } await handleCommand(msg); });
    ws.on('close', () => { connected = false; clearInterval(heartbeatTimer); clearInterval(pingTimer); scheduleReconnect(); });
  } else {
    console.log('[PAN Client] WebSocket unavailable (Cloudflare tunnel) — using HTTP polling mode');
    try { ws.terminate(); } catch {}
    ws = null;
    startHttpMode();
  }
}

// ── HTTP polling mode (Cloudflare tunnel) ────────────────────────────────────
function startHttpMode() {
  console.log('[PAN Client] HTTP mode active — polling for commands every 3s, heartbeat every 20s');

  // Heartbeat — keeps device showing as "online" in dashboard
  (async function heartbeatLoop() {
    while (true) {
      try {
        let services = await probeServices();
        // Watchdog: attempt to restart Ollama if down (same throttle as WS mode)
        const ollamaDown = services.some(s => s.name === 'ollama' && s.status === 'down');
        if (ollamaDown) {
          const now = Date.now();
          if (now - _ollamaLastRestartAttempt >= OLLAMA_RESTART_THROTTLE_MS) {
            _ollamaLastRestartAttempt = now;
            console.log('[Watchdog] Ollama down — attempting restart');
            restartOllama();
            await new Promise(r => setTimeout(r, 8000));
            services = await probeServices();
          }
        }
        const svc = detectServiceState();
        const hbResp = await httpRequest('POST', '/api/v1/client/heartbeat', {
          device_id: DEVICE_ID,
          mem_free_mb: Math.round(freemem() / 1024 / 1024),
          mem_total_mb: Math.round(totalmem() / 1024 / 1024),
          uptime_s: Math.round(process.uptime()),
          services,
          service_state: svc.service_state,
          service_manager: svc.service_manager,
          restart_history: getRestartHistory(),
          claude_control: getLocalClaudeStatus(),
        });
        // HTTP path proves server reachability — record success for the tray.
        _lastHeartbeatOkMs = Date.now();
        connected = true;
        // The hub piggybacks pending commands on the heartbeat response so
        // HTTP-poll clients (no WS) still receive instructions. Execute any
        // that arrived. self_update is the most important one here — the
        // hub uses it to push pan-client updates to minipc etc without
        // anyone SSHing to those machines.
        try {
          const cmds = Array.isArray(hbResp?.body?.commands) ? hbResp.body.commands : [];
          for (const c of cmds) {
            if (!c?.type) continue;
            console.log(`[HTTP-Poll] Executing pulled command: ${c.type}`);
            await handleCommand({ id: c.id, type: c.type, params: c.params || {} });
          }
        } catch (e) {
          console.warn('[HTTP-Poll] command execution failed:', e.message);
        }
      } catch {
        connected = false;
      }
      await new Promise(r => setTimeout(r, 20_000));
    }
  })();

  // Presence loop — reports active window + activity every 30s
  (async function presenceLoop() {
    await sendPresence(); // initial
    // T2: live capability poll (HTTP mode)
    setInterval(refreshCapabilitiesAndReregister, CAP_REFRESH_MS);
    refreshCapabilitiesAndReregister();
    while (true) {
      await new Promise(r => setTimeout(r, 30_000));
      await sendPresence();
    }
  })();

  // Command poll loop — long-polls server (25s hold), executes command, posts result back
  (async function pollLoop() {
    while (true) {
      try {
        const r = await httpRequest('GET',
          `/api/v1/client/poll?device_id=${encodeURIComponent(DEVICE_ID)}&token=${encodeURIComponent(TOKEN)}`);
        const cmd = r.body?.command; // singular — server returns one command at a time
        if (cmd) {
          console.log(`[PAN Client] HTTP CMD ${cmd.type} (${cmd.id})`);
          handleCommand(cmd).catch(() => {});
        }
        // null = poll timed out with no command — loop immediately (server already waited 25s)
      } catch { await new Promise(r => setTimeout(r, 3_000)); }
    }
  })();
}


boot().catch(err => {
  console.error('[PAN Client] Fatal boot error:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[PAN Client] Shutting down...');
  send({ type: 'disconnect', device_id: DEVICE_ID, reason: 'shutdown' });
  setTimeout(() => process.exit(0), 500);
});
process.on('SIGTERM', () => {
  send({ type: 'disconnect', device_id: DEVICE_ID, reason: 'shutdown' });
  setTimeout(() => process.exit(0), 500);
});

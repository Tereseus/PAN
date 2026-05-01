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
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hostname, platform, arch, totalmem, freemem, cpus } from 'os';
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
const capabilities = [];
if (IS_WINDOWS) capabilities.push('windows', 'powershell', 'cmd');
if (PLATFORM === 'linux') capabilities.push('linux', 'bash');
if (PLATFORM === 'darwin') capabilities.push('macos', 'bash');
capabilities.push('shell_exec', 'open_app', 'open_url', 'notification', 'tts_speak', 'screenshot');

// ── HTTP registration (works through Cloudflare tunnel) ──────────────────────
const HUB_HTTP = config.hub_http || HUB_WS.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

async function httpRegister() {
  return httpRequest('POST', '/api/v1/client/register',
    { token: TOKEN, device_id: DEVICE_ID, name: NAME,
      platform: PLATFORM, arch: arch(), version: VERSION, capabilities, hostname: hostname() });
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
    send({ type: 'register', device_id: DEVICE_ID, name: NAME, version: VERSION,
           platform: PLATFORM, arch: arch(), capabilities,
           hostname: hostname(), token: TOKEN });

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

function restartOllama() {
  if (IS_WINDOWS) {
    // Try the desktop shortcut first (launches the tray app + server)
    try {
      spawn('cmd', ['/c', 'start', '', 'C:\\Users\\Public\\Desktop\\Ollama.lnk'], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      }).unref();
      console.log('[Watchdog] Ollama restart attempted via desktop shortcut');
      return;
    } catch {}
    // Fallback: ollama serve directly
    try {
      spawn('ollama', ['serve'], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      }).unref();
      console.log('[Watchdog] Ollama restart attempted via `ollama serve`');
    } catch (err) {
      console.error('[Watchdog] Ollama restart failed:', err.message);
    }
  } else {
    // Linux / macOS
    try {
      spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      console.log('[Watchdog] Ollama restart attempted via `ollama serve`');
    } catch (err) {
      console.error('[Watchdog] Ollama restart failed:', err.message);
    }
  }
}

async function sendHeartbeat() {
  let services = await probeServices();

  // Watchdog: if Ollama is down, attempt to start it (throttled to once per 5 min)
  const ollamaSvc = services.find(s => s.name === 'ollama');
  const ollamaDown = ollamaSvc?.status === 'down';
  if (ollamaDown) {
    const now = Date.now();
    if (now - _ollamaLastRestartAttempt >= OLLAMA_RESTART_THROTTLE_MS) {
      _ollamaLastRestartAttempt = now;
      console.log('[Watchdog] Ollama down — attempting restart');
      restartOllama();
      // Wait 8s then re-probe so the heartbeat carries fresh status
      await new Promise(r => setTimeout(r, 8000));
      services = await probeServices();
    }
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

  send({
    type: 'heartbeat',
    device_id: DEVICE_ID,
    mem_free_mb: Math.round(freemem() / 1024 / 1024),
    mem_total_mb: Math.round(totalmem() / 1024 / 1024),
    uptime_s: Math.round(process.uptime()),
    timestamp: Date.now(),
    services,
  });
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
        break;
      } else if (status.status === 'denied') {
        console.error('[PAN Client] Connection denied by hub owner.');
        process.exit(1);
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
    send({ type: 'register', device_id: DEVICE_ID, name: NAME, version: VERSION,
           platform: PLATFORM, arch: arch(), capabilities, hostname: hostname(), token: TOKEN });
    heartbeatTimer = setInterval(sendHeartbeat, 30_000);
    pingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 15_000);
    setInterval(sendPresence, 30_000);
    sendPresence();

    // Normal WS path — reconnect on drop (also re-registers on every reconnect)
    ws.on('open', () => {
      connected = true;
      reconnectDelay = 2000;
      send({ type: 'register', device_id: DEVICE_ID, name: NAME, version: VERSION,
             platform: PLATFORM, arch: arch(), capabilities, hostname: hostname(), token: TOKEN });
      heartbeatTimer = setInterval(sendHeartbeat, 30_000);
      pingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); }, 15_000);
      setInterval(sendPresence, 30_000);
      sendPresence(); // initial presence on connect
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
        await httpRequest('POST', '/api/v1/client/heartbeat', {
          device_id: DEVICE_ID,
          mem_free_mb: Math.round(freemem() / 1024 / 1024),
          mem_total_mb: Math.round(totalmem() / 1024 / 1024),
          uptime_s: Math.round(process.uptime()),
          services,
        });
      } catch {}
      await new Promise(r => setTimeout(r, 20_000));
    }
  })();

  // Presence loop — reports active window + activity every 30s
  (async function presenceLoop() {
    await sendPresence(); // initial
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

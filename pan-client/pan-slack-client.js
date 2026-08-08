#!/usr/bin/env node
// PAN Slack Client — a DELIBERATELY SCOPED pan-client for work-pc (a corporate
// machine). Unlike the full pan-client.js, it advertises ONLY the 'slack' capability
// and refuses every command except `slack_reply`. There is NO shell_exec, open_app,
// open_url, file_transfer, screenshot, or self_update handler in here — so the hub
// physically cannot run arbitrary code on the work box. It does two narrow jobs:
//
//   1. Tails the live Slack inbox (slack-inbox.jsonl) and pushes each NEW inbound
//      message up to the hub as {type:'slack_message'} → hub notifies the phone.
//   2. On a {type:'slack_reply', channelId, text} command, runs ONLY slack-reply.js
//      to send the reply as the user, then returns a command_result.
//
// Usage:  node pan-slack-client.js --hub ws://100.x.x.x:7777 --token <token>
// Deploy: %USERPROFILE%\browser-tools\ (the LIVE runtime — NOT the autobridge git
//         mirror). Kept alive by slack-bridge-watchdog.ps1, same as the monitor.
// Needs the `ws` package present in browser-tools\node_modules (verify on deploy).

// CommonJS — browser-tools has no "type":"module" and its other scripts use require().
const { WebSocket } = require('ws');
const { execFile } = require('child_process');
const { readFileSync, existsSync, watch } = require('fs');
const { join, dirname, basename } = require('path');
const { hostname } = require('os');
const http = require('http');
const https = require('https');
// __dirname is native in CommonJS.
const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf('--' + n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const HUB       = arg('hub')   || process.env.PAN_HUB_WS;
const TOKEN     = arg('token') || process.env.PAN_TOKEN;
// Inbound messages go up over HTTP (a Craft route the hub can reload with a swap),
// NOT over the WS — the Carrier doesn't route custom message types. Derive the
// http(s) base from the ws hub url unless --hub-http overrides it.
const HUB_HTTP  = arg('hub-http') || (HUB ? HUB.replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '') : null);
const DEVICE_ID = arg('device') || (hostname().toLowerCase() + '-slack');
const NAME      = arg('name')  || (hostname() + ' (Slack)');
const INBOX     = arg('inbox') || join(__dirname, 'slack-inbox.jsonl');
const REPLY_JS  = join(__dirname, 'slack-reply.js');
const CAPABILITIES = ['slack'];          // scoped: this is the ONLY capability
// Whitelist for the generic `run_tool` command — the hub may ask this client to run
// ONLY these scripts (matched by basename). This is the real security scope: even if
// the hub sent a different command, the client refuses anything not on this list. It's
// still not arbitrary shell — only these specific work scripts, run via execFile (no shell).
const ALLOWED_TOOLS = ['slack-reply.js', 'resolve-conv.js', 'jira.js'];
const VERSION   = '1.0.0-slack';

if (!HUB || !TOKEN) {
  console.error('[slack-client] need --hub <ws://hub:7777> and --token <token>');
  process.exit(1);
}

let ws = null;
let reconnectDelay = 2000;
let seen = 0;                            // # of inbox lines already forwarded

function send(o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch {} }

// Push a new inbound Slack message up to the hub over HTTP. Requests from this
// machine arrive at the hub as a Tailscale IP, which auto-authenticates.
function postInbound(message) {
  if (!HUB_HTTP) return;
  try {
    const u = new URL(HUB_HTTP + '/api/v1/slack/inbound');
    const lib = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ message });
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false, timeout: 8000,
    }, (r) => { r.resume(); });
    req.on('error', (e) => console.log('[slack-client] inbound POST error:', e.message));
    req.on('timeout', () => req.destroy());
    req.write(body); req.end();
  } catch (e) { console.log('[slack-client] inbound POST failed:', e.message); }
}

function readInbox() {
  if (!existsSync(INBOX)) return [];
  return readFileSync(INBOX, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// First run marks everything already in the inbox as seen, so we never blast backlog.
function baseline() { seen = readInbox().length; console.log(`[slack-client] baseline ${seen} existing msgs (won't re-push)`); }

function pushNew() {
  const all = readInbox();
  if (all.length < seen) seen = all.length;           // inbox rotated/truncated
  if (all.length <= seen) return;
  const fresh = all.slice(seen);
  seen = all.length;
  for (const m of fresh) {
    postInbound({
      channelId: m.channelId, channel: m.channel, sender: m.sender,
      text: m.text, kind: m.type, received: m.received,
    });
    console.log(`[slack-client] up: ${m.sender}: ${(m.text || '').replace(/\n/g, ' ').slice(0, 60)}`);
  }
}

function startTail() {
  baseline();
  try { watch(INBOX, { persistent: true }, () => { try { pushNew(); } catch {} }); } catch {}
  setInterval(() => { try { pushNew(); } catch {} }, 5000);   // poll fallback if watch misses
}

// The ONLY inbound command this client will act on.
function handleCommand(msg) {
  const id = msg.id;
  const type = msg.type;
  if (type === 'ping') { send({ type: 'command_result', id, command_type: 'ping', ok: true, result: 'pong' }); return; }
  if (type === 'slack_reply') {
    const { channelId, text } = msg;
    if (!channelId || !text) { send({ type: 'command_result', id, command_type: 'slack_reply', ok: false, error: 'missing channelId or text' }); return; }
    execFile('node', [REPLY_JS, channelId, text], { timeout: 90_000, windowsHide: true, cwd: __dirname }, (err, stdout, stderr) => {
      const ok = !err;
      send({ type: 'command_result', id, command_type: 'slack_reply', ok, result: (stdout || '').slice(0, 400), error: ok ? null : (stderr || err.message || 'reply failed').slice(0, 400) });
      console.log(`[slack-client] down: reply -> ${channelId}: ${ok ? 'sent' : 'FAILED ' + (err && err.message)}`);
    });
    return;
  }
  // Generic work-tool runner — the hub's work-tool dispatcher sends {script, args:[]}.
  // Only whitelisted scripts run; args are an explicit argv (no shell parsing).
  if (type === 'run_tool') {
    const script = String(msg.script || '');
    const argv = Array.isArray(msg.args) ? msg.args.map(a => String(a)) : [];
    const base = basename(script.replace(/\\/g, '/'));
    if (!ALLOWED_TOOLS.includes(base)) {
      send({ type: 'command_result', id, command_type: 'run_tool', ok: false, error: `tool not whitelisted: ${base}` });
      return;
    }
    const isAbs = /^[a-zA-Z]:[\\/]/.test(script) || script.startsWith('/');
    const cwd = isAbs ? dirname(script.replace(/\//g, '\\')) : __dirname;
    execFile('node', [script, ...argv], { timeout: msg.timeout_ms || 90000, windowsHide: true, cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const ok = !err;
      send({ type: 'command_result', id, command_type: 'run_tool', ok, result: (stdout || '').slice(0, 2000), error: ok ? null : (stderr || err.message || 'tool failed').slice(0, 500) });
      console.log(`[slack-client] run_tool ${base} (${argv.length} args): ${ok ? 'ok' : 'FAILED ' + (err && err.message)}`);
    });
    return;
  }

  // Refuse everything else — the scoped client has no other powers.
  send({ type: 'command_result', id, command_type: type, ok: false, error: `scoped slack client: command '${type}' not permitted` });
}

function connect() {
  // Client WS endpoint is /ws/client?token=&device_id= (see client-manager.js).
  const base = HUB.replace(/\/+$/, '');
  const path = base.includes('/ws/client') ? '' : '/ws/client';
  const url = `${base}${path}?token=${encodeURIComponent(TOKEN)}&device_id=${encodeURIComponent(DEVICE_ID)}`;
  ws = new WebSocket(url, { handshakeTimeout: 8000, rejectUnauthorized: false });
  ws.on('open', () => {
    reconnectDelay = 2000;
    send({ type: 'register', device_id: DEVICE_ID, name: NAME, version: VERSION, token: TOKEN, capabilities: CAPABILITIES, platform: 'win32' });
    console.log(`[slack-client] connected + registered as '${DEVICE_ID}' (cap: slack only)`);
  });
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (['registered', 'approved', 'heartbeat_ack'].includes(msg.type)) return;
    if (msg.type === 'pending_approval') { console.log('[slack-client] awaiting admin approval in the PAN dashboard'); return; }
    if (msg.type === 'denied') { console.log('[slack-client] hub denied this device'); return; }
    if (msg.type) handleCommand(msg);            // commands arrive as {id, type, ...params}
  });
  ws.on('close', (code) => { console.log(`[slack-client] disconnected (${code}) — retry in ${reconnectDelay / 1000}s`); setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000); });
  ws.on('error', (e) => { console.log('[slack-client] ws error:', e.message); });
}

setInterval(() => send({ type: 'heartbeat', device_id: DEVICE_ID, capabilities: CAPABILITIES }), 30_000);
startTail();
connect();

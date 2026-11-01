#!/usr/bin/env node
// PAN thread relay — machine side. Lets PAN voice talk to any Claude Code
// desktop thread on this machine. Hub side: service/src/thread-relay.js.
//
// The Claude desktop app has no external API, so delivery is done by one
// resident desktop thread (the "relay thread") that owns the session-messaging
// tool. Everything that does not need that tool happens here, in plain Node,
// so the relay thread only wakes up when there is something to deliver:
//
//   node relay.js wait     Reports this machine's threads, long-polls the hub,
//                          and posts thread answers back by reading transcripts.
//                          Prints ONE line and exits when a job arrives:
//                            JOB {"job_id","session_id","title","message"}
//                          The relay thread delivers it, acks, and runs wait again.
//   node relay.js ack <job_id> <delivered|queued> [message_id]
//   node relay.js fail <job_id> <reason...>
//   node relay.js status   ALIVE / DEAD from the hub's heartbeat (exit 0 / 1)
//   node relay.js threads  what this machine would report
//   node relay.js scan <job_id>   debug: what reply the transcript gives for a job
//
// Config: ../pan-client-config.json (hub_ws, device_id) or env PAN_HUB_URL,
// PAN_RELAY_HOST. Optional config key relay_hub_url overrides the hub URL.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, platform } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '.state');
const LOCK = join(STATE_DIR, 'wait.lock');
const OFFSETS = join(STATE_DIR, 'offsets.json');
const RELAY_TITLE_RE = /^PAN Voice Relay\b/i;   // the relay thread itself

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(__dirname, '..', 'pan-client-config.json'), 'utf8')); } catch {}
  let hub = process.env.PAN_HUB_URL || cfg.relay_hub_url || '';
  if (!hub && cfg.hub_ws) hub = cfg.hub_ws.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws.*$/, '');
  if (!hub) hub = 'http://127.0.0.1:7777';
  const host = process.env.PAN_RELAY_HOST || cfg.device_id || cfg.name || 'local';
  return { hub: hub.replace(/\/$/, ''), host };
}
const { hub: HUB, host: HOST } = loadConfig();

async function api(method, path, body, timeoutMs = 15_000) {
  const r = await fetch(HUB + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Device-Name': `${HOST}-thread-relay` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j.error || ''}`);
  return j;
}

// ── Desktop app session metadata ─────────────────────────────────────────────

function sessionRoots() {
  const roots = [];
  if (process.env.CLAUDE_SESSIONS_DIR) roots.push(process.env.CLAUDE_SESSIONS_DIR);
  if (platform() === 'win32') roots.push(join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions'));
  else if (platform() === 'darwin') roots.push(join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'));
  else roots.push(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Claude', 'claude-code-sessions'));
  return roots.filter(existsSync);
}

// local_<id>.json files live two levels down: <account>/<org>/local_*.json
function sessionFiles() {
  const out = [];
  for (const root of sessionRoots()) {
    for (const a of safeDir(root)) {
      const ap = join(root, a);
      for (const b of safeDir(ap)) {
        const bp = join(ap, b);
        for (const f of safeDir(bp)) if (/^local_.*\.json$/.test(f)) out.push(join(bp, f));
      }
    }
  }
  return out;
}
function safeDir(p) { try { return statSync(p).isDirectory() ? readdirSync(p) : []; } catch { return []; } }

function readMeta(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

let _metaIndex = null, _metaIndexAt = 0;
function metaIndex() {
  if (_metaIndex && Date.now() - _metaIndexAt < 30_000) return _metaIndex;
  _metaIndex = new Map();
  for (const f of sessionFiles()) {
    const id = f.match(/(local_[^\\/]+)\.json$/)[1];
    _metaIndex.set(id, f);
  }
  _metaIndexAt = Date.now();
  return _metaIndex;
}

function listThreads() {
  const cutoff = Date.now() - 60 * 24 * 3600_000;
  const threads = [];
  for (const f of metaIndex().values()) {
    const m = readMeta(f);
    if (!m || m.isArchived || !m.title || RELAY_TITLE_RE.test(m.title)) continue;
    if ((m.lastActivityAt || 0) < cutoff) continue;
    threads.push({ session_id: m.sessionId, title: m.title, cwd: m.cwd || null, last_activity: m.lastActivityAt || null, pinned: !!m.isStarred });
  }
  return threads.sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
}

// ── Transcripts ──────────────────────────────────────────────────────────────

function projectsDir() { return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'); }

function transcriptFor(sessionId) {
  const f = metaIndex().get(sessionId) || (_metaIndexAt = 0, metaIndex().get(sessionId));
  const m = f && readMeta(f);
  if (!m || !m.cliSessionId) return null;
  const name = `${m.cliSessionId}.jsonl`;
  const guess = join(projectsDir(), String(m.cwd || '').replace(/[^a-zA-Z0-9]/g, '-'), name);
  if (existsSync(guess)) return guess;
  for (const d of safeDir(projectsDir())) {
    const p = join(projectsDir(), d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function readFrom(file, offset) {
  const size = statSync(file).size;
  const start = Math.max(0, Math.min(offset, size));
  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  return { text: buf.toString('utf8'), start, size };
}

function loadOffsets() { try { return JSON.parse(readFileSync(OFFSETS, 'utf8')); } catch { return {}; } }
function saveOffsets(o) { try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(OFFSETS, JSON.stringify(o)); } catch {} }

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  return '';
}
function isToolResult(o) {
  const c = o.message?.content;
  return Array.isArray(c) && c.some(b => b && b.type === 'tool_result');
}

// Find the turn our message started and, once it has ended, the thread's
// final answer. Returns { state: 'not_yet'|'running'|'done', reply }.
function scanForReply(job) {
  const file = transcriptFor(job.session_id);
  if (!file) return { state: 'no_transcript' };
  const offsets = loadOffsets();
  const known = offsets[job.id];
  const marker = `req ${job.id}`;
  const size = statSync(file).size;

  let from = known && known.file === file ? known.offset : Math.max(0, size - 8 * 1024 * 1024);
  let { text, start } = readFrom(file, from);
  let idx = text.indexOf(marker);
  if (idx < 0 && !known && start > 0) {
    ({ text, start } = readFrom(file, Math.max(0, size - 64 * 1024 * 1024)));
    idx = text.indexOf(marker);
  }
  if (idx < 0) return { state: 'not_yet' };

  const lineStart = text.lastIndexOf('\n', idx) + 1;
  if (!known) {
    offsets[job.id] = { file, offset: start + Buffer.byteLength(text.slice(0, lineStart), 'utf8') };
    saveOffsets(offsets);
  }

  const lines = text.slice(lineStart).split('\n');
  let sawMarker = false, ended = false;
  const assistants = [];
  let lastLine = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!sawMarker) {
      if (o.type === 'user' && contentText(o.message?.content).includes(marker)) sawMarker = true;
      continue;
    }
    if (o.type === 'assistant') { assistants.push(o); lastLine = o; continue; }
    if (o.type === 'system' && (o.subtype === 'stop_hook_summary' || o.subtype === 'turn_duration')) { ended = true; break; }
    if (o.type === 'user' && !isToolResult(o) && !o.isMeta) {
      const t = contentText(o.message?.content);
      if (t && !t.startsWith('<')) { ended = true; break; }
      if (/\[Request interrupted/.test(t)) { ended = true; break; }
    }
  }
  if (!sawMarker) return { state: 'not_yet' };
  if (!ended && lastLine && lastLine.message?.stop_reason === 'end_turn') {
    // No stop hook on this machine: treat a quiet file after end_turn as done.
    if (Date.now() - statSync(file).mtimeMs > 20_000) ended = true;
  }
  if (!ended) return { state: 'running' };

  // The answer is what was said after the last tool call.
  let lastTool = -1;
  assistants.forEach((o, i) => { const c = o.message?.content; if (Array.isArray(c) && c.some(b => b.type === 'tool_use')) lastTool = i; });
  let reply = assistants.slice(lastTool + 1).map(o => contentText(o.message?.content)).filter(Boolean).join('\n\n').trim();
  if (!reply) reply = assistants.map(o => contentText(o.message?.content)).filter(Boolean).join('\n\n').trim();
  return { state: 'done', reply: reply || '(The thread finished without a text answer.)' };
}

async function checkReplies() {
  let jobs = [];
  try { jobs = (await api('GET', `/api/v1/threads/jobs?host=${encodeURIComponent(HOST)}&status=delivered`))?.jobs || []; } catch { return; }
  for (const job of jobs) {
    try {
      const r = scanForReply(job);
      if (r.state === 'done') {
        await api('POST', `/api/v1/threads/jobs/${job.id}/reply`, { text: r.reply });
        const o = loadOffsets(); delete o[job.id]; saveOffsets(o);
        log(`reply posted for ${job.id} (${job.title}): ${r.reply.slice(0, 80)}`);
      } else if (r.state === 'no_transcript' && Date.now() - job.delivered_at > 5 * 60_000) {
        await api('POST', `/api/v1/threads/jobs/${job.id}/fail`, { error: 'its transcript could not be found' });
      }
    } catch (e) { log(`reply check ${job.id}: ${e.message}`); }
  }
}

// ── wait loop ────────────────────────────────────────────────────────────────

function log(msg) { process.stderr.write(`[relay ${new Date().toISOString().slice(11, 19)}] ${msg}\n`); }

function takeLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LOCK, String(process.pid));
}
function ownsLock() { try { return readFileSync(LOCK, 'utf8').trim() === String(process.pid); } catch { return false; } }

async function waitLoop() {
  takeLock();
  let lastReport = 0;
  const replyTimer = setInterval(() => { checkReplies().catch(() => {}); }, 3000);
  checkReplies().catch(() => {});
  for (;;) {
    if (!ownsLock()) { clearInterval(replyTimer); console.log('SUPERSEDED another wait loop took over; nothing to do'); process.exit(0); }
    if (Date.now() - lastReport > 60_000) {
      try { await api('POST', '/api/v1/threads/report', { host: HOST, threads: listThreads() }); lastReport = Date.now(); }
      catch (e) { log(`report failed: ${e.message}`); }
    }
    let res = null;
    try { res = await api('GET', `/api/v1/threads/jobs/next?host=${encodeURIComponent(HOST)}&wait=25000`, null, 40_000); }
    catch (e) { log(`poll failed: ${e.message}`); await new Promise(r => setTimeout(r, 5000)); continue; }
    if (res?.job) {
      // Even if a newer loop took the lock mid-poll, this job is claimed by
      // us now and must be delivered, so print it either way.
      clearInterval(replyTimer);
      const j = res.job;
      console.log('JOB ' + JSON.stringify({ job_id: j.id, session_id: j.session_id, title: j.title, message: j.message }));
      process.exit(0);
    }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'wait') await waitLoop();
  else if (cmd === 'ack') {
    const [id, delivery = 'delivered', message_id = null] = args;
    await api('POST', `/api/v1/threads/jobs/${id}/delivered`, { delivery, message_id });
    console.log(`ACKED ${id}`);
  } else if (cmd === 'fail') {
    const [id, ...why] = args;
    await api('POST', `/api/v1/threads/jobs/${id}/fail`, { error: why.join(' ') || 'delivery failed' });
    console.log(`FAILED ${id}`);
  } else if (cmd === 'status') {
    const j = await api('GET', '/api/v1/threads');
    const me = (j?.relays || []).find(r => r.host === HOST);
    console.log(me?.alive ? `ALIVE ${HOST} (heartbeat ${Math.round(me.age_ms / 1000)}s ago)` : `DEAD ${HOST}${me ? ` (last heartbeat ${Math.round(me.age_ms / 1000)}s ago)` : ' (never seen)'}`);
    process.exit(me?.alive ? 0 : 1);
  } else if (cmd === 'threads') {
    for (const t of listThreads()) console.log(`${t.session_id}  ${t.title}`);
  } else if (cmd === 'scan') {
    const j = await api('GET', `/api/v1/threads/jobs/${args[0]}`);
    console.log(JSON.stringify(scanForReply(j.job), null, 2));
  } else {
    console.log('usage: relay.js wait | ack <job> <delivered|queued> [message_id] | fail <job> <reason> | status | threads | scan <job>');
    process.exit(2);
  }
} catch (e) {
  console.log(`ERROR ${e.message}`);
  process.exit(1);
}

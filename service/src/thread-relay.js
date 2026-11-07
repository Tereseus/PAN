// Thread relay — talk to any Claude Code desktop thread by voice.
//
// The user keeps many long-running Claude Code threads in the Claude desktop
// app (one per project area). This lets the phone address any of them:
//
//   "tell the billing thread to run the tests"
//   "ask map editor what it's doing"
//
// Pieces:
//   - A RELAY on each machine that has threads (pan-client/thread-relay/relay.js
//     plus one resident desktop thread that owns the delivery tool). It reports
//     the thread list, long-polls for jobs, delivers each into its thread, and
//     posts the thread's final answer back.
//   - This module: thread registry, job queue, fuzzy title matching, and the
//     deterministic voice parser the router calls BEFORE the LLM classifier.
//   - routes/threads.js: the HTTP surface the relay talks to.
//
// Replies that land while the phone is still holding the voice turn open are
// spoken inline. Later ones go to the phone notification queue as type 'speak'.
//
// State lives in SQLite so a Craft swap never loses a job; only the in-memory
// waiters (long-polls, inline voice waits) die with the old Craft, and both
// sides retry.

import { db, run, get, all, DB_PATH } from './db.js';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

const CLAIM_TIMEOUT_MS = 2 * 60_000;      // claimed but never delivered → failed
const REPLY_TIMEOUT_MS = 45 * 60_000;     // delivered but no answer → expired
const RELAY_ALIVE_MS = 90_000;            // heartbeat age that counts as alive
const FOLLOWUP_WINDOW_MS = 15 * 60_000;   // "tell it ..." reuses the last thread

let _schemaReady = false;
export function ensureThreadRelaySchema() {
  if (_schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_relay_threads (
      host          TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      title         TEXT NOT NULL,
      cwd           TEXT,
      last_activity INTEGER,
      pinned        INTEGER DEFAULT 0,
      updated_at    INTEGER,
      PRIMARY KEY (host, session_id)
    );
    CREATE TABLE IF NOT EXISTS thread_relay_jobs (
      id            TEXT PRIMARY KEY,
      host          TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      title         TEXT,
      text          TEXT NOT NULL,
      utterance     TEXT,
      status        TEXT NOT NULL DEFAULT 'queued',
      source        TEXT,
      device_id     TEXT,
      delivery      TEXT,
      message_id    TEXT,
      reply         TEXT,
      error         TEXT,
      spoken        INTEGER DEFAULT 0,
      created_at    INTEGER,
      claimed_at    INTEGER,
      delivered_at  INTEGER,
      replied_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_thread_relay_jobs_status ON thread_relay_jobs(host, status);
    CREATE TABLE IF NOT EXISTS thread_relay_hosts (
      host       TEXT PRIMARY KEY,
      last_seen  INTEGER,
      info       TEXT
    );
  `);
  // kind: 'send' delivers text to the thread; 'status' is answered by the relay
  // from the thread's transcript without disturbing it.
  try { db.exec(`ALTER TABLE thread_relay_jobs ADD COLUMN kind TEXT DEFAULT 'send'`); } catch {}
  try { db.exec(`ALTER TABLE thread_relay_jobs ADD COLUMN convo TEXT`); } catch {}
  _schemaReady = true;
}

// ── Relay heartbeat + thread registry ────────────────────────────────────────

export function relayHeartbeat(host, info = {}) {
  ensureThreadRelaySchema();
  run(`INSERT INTO thread_relay_hosts (host, last_seen, info) VALUES (:h, :t, :i)
       ON CONFLICT(host) DO UPDATE SET last_seen = :t, info = :i`,
    { ':h': host, ':t': Date.now(), ':i': JSON.stringify(info || {}) });
}

export function relayStatus() {
  ensureThreadRelaySchema();
  const now = Date.now();
  return all(`SELECT host, last_seen, info FROM thread_relay_hosts ORDER BY last_seen DESC`)
    .map(r => {
      let info = {};
      try { info = JSON.parse(r.info || '{}'); } catch {}
      return { host: r.host, last_seen: r.last_seen, age_ms: now - r.last_seen, alive: now - r.last_seen < RELAY_ALIVE_MS, info };
    });
}

export function reportThreads(host, threads) {
  ensureThreadRelaySchema();
  const now = Date.now();
  const tx = db.transaction ? db.transaction.bind(db) : null;
  const apply = () => {
    run(`DELETE FROM thread_relay_threads WHERE host = :h`, { ':h': host });
    for (const t of threads || []) {
      if (!t || !t.session_id || !t.title) continue;
      run(`INSERT OR REPLACE INTO thread_relay_threads (host, session_id, title, cwd, last_activity, pinned, updated_at)
           VALUES (:h, :s, :t, :c, :a, :p, :u)`, {
        ':h': host, ':s': String(t.session_id), ':t': String(t.title).slice(0, 200),
        ':c': t.cwd ? String(t.cwd).slice(0, 300) : null,
        ':a': Number(t.last_activity) || null, ':p': t.pinned ? 1 : 0, ':u': now,
      });
    }
  };
  if (tx) tx(apply)(); else apply();
  relayHeartbeat(host, { threads: (threads || []).length });
}

export function listThreads() {
  ensureThreadRelaySchema();
  return all(`SELECT t.host, t.session_id, t.title, t.cwd, t.last_activity, t.pinned,
                     CASE WHEN h.last_seen > :alive THEN 1 ELSE 0 END AS host_alive
                FROM thread_relay_threads t LEFT JOIN thread_relay_hosts h ON h.host = t.host
               ORDER BY host_alive DESC, t.last_activity DESC`, { ':alive': Date.now() - RELAY_ALIVE_MS });
}

// ── Fuzzy title matching ─────────────────────────────────────────────────────

const GREEK = { 'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th', 'ι': 'i', 'κ': 'k',
  'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'y',
  'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o', 'ά': 'a', 'έ': 'e', 'ή': 'i', 'ί': 'i', 'ό': 'o', 'ύ': 'y', 'ώ': 'o' };

// Per-install settings live next to the database, so personal names stay out of git.
const _installFiles = new Map();
function installJson(name) {
  const cached = _installFiles.get(name);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value = {};
  try { value = JSON.parse(readFileSync(join(dirname(DB_PATH), name), 'utf8')); } catch {}
  _installFiles.set(name, { at: Date.now(), value });
  return value;
}

// Spoken forms STT produces for words that appear in titles. Per-install
// extras (project names STT mangles) are in thread-aliases.json, as { "heard": "title word" }.
const BASE_ALIASES = { pam: 'pan', pann: 'pan' };
function spokenAliases() { return { ...BASE_ALIASES, ...installJson('thread-aliases.json') }; }

// Threads are named for their machine ("Mint PC Stuff", "G16 PC Stuff"). thread-machines.json says
// which relay host each of those words means, as { "mint": "<host>" }.
function spokenMachines() { return installJson('thread-machines.json'); }

const FILLER = new Set(['the', 'a', 'an', 'my', 'our', 'that', 'this', 'thread', 'threads', 'session', 'sessions',
  'chat', 'claude', 'tab', 'one', 'please', 'and']);

function tokens(s) {
  const lower = String(s || '').toLowerCase().replace(/[α-ωάέήίόύώς]/g, c => GREEK[c] || c);
  return lower.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function tokenSim(a, b) {
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.85;
  const d = lev(a, b);
  const len = Math.max(a.length, b.length);
  if (len >= 4 && d === 1) return 0.8;
  if (len >= 7 && d === 2) return 0.65;
  return 0;
}

function spokenTokens(name) {
  const aliases = spokenAliases();
  const raw = tokens(name).filter(w => !FILLER.has(w));
  const t = raw.map(w => aliases[w] || w);
  // "service now" must find "servicenow", and "service" alone is an alias for it, so join both.
  const joined = [];
  for (const list of [t, raw]) for (let i = 0; i + 1 < list.length; i++) joined.push(list[i] + list[i + 1]);
  return { t, joined };
}

// "mint music" or "g 16 pc stuff": the machine word, and the words left once it is taken out.
function machineSaid(words, joined, machines) {
  const whole = words.find(w => machines[w]);
  if (whole) return { machine: whole, rest: words.filter(w => w !== whole) };
  const pair = joined.find(j => machines[j]);
  if (!pair) return { machine: null, rest: words };
  const at = words.findIndex((w, i) => w + words[i + 1] === pair);
  return { machine: pair, rest: at < 0 ? words : words.filter((_, i) => i !== at && i !== at + 1) };
}

// Newest row per title: scheduled-task runs share a title and only the latest matters.
function distinctThreads(threads) {
  const seen = new Map();
  for (const th of threads) {
    const key = th.title.toLowerCase().trim();
    const prev = seen.get(key);
    const better = !prev || (th.host_alive || 0) > (prev.host_alive || 0)
      || ((th.host_alive || 0) === (prev.host_alive || 0) && (th.last_activity || 0) > (prev.last_activity || 0));
    if (better) seen.set(key, th);
  }
  return [...seen.values()];
}

export function matchThread(spokenName, threads = listThreads()) {
  const machines = spokenMachines();
  const { t: said, joined } = spokenTokens(spokenName);
  const { machine, rest: words } = machineSaid(said, joined, machines);
  // A machine said out loud is a hard limit: "mint music" must never reach the G16's Music thread.
  const pool = distinctThreads(threads).filter(th => !machine || th.host === machines[machine]);
  if (!said.length || !pool.length) return { ok: false, reason: said.length ? 'no_threads' : 'no_name', candidates: [] };
  if (!words.length) {
    const candidates = pool.slice(0, 3).map(th => ({ title: th.title, score: 1 }));
    return pool.length === 1 ? { ok: true, thread: pool[0], score: 1, candidates } : { ok: false, reason: 'ambiguous', candidates };
  }

  // Not said, the machine is no part of the name: "music" fits "Music" and "Mint Music" alike, and PAN asks.
  const titleTokens = pool.map(th => {
    const all = tokens(th.title);
    const named = all.filter(w => !machines[w]);
    return named.length ? named : all;
  });
  const df = new Map();
  for (const tt of titleTokens) for (const w of new Set(tt)) df.set(w, (df.get(w) || 0) + 1);
  const idf = (w) => Math.log(1 + pool.length / (df.get(w) || 0.5));

  const scored = pool.map((th, i) => {
    const tt = titleTokens[i];
    let got = 0, want = 0;
    const covered = new Set();
    for (const w of words) {
      let best = 0, bestTok = null;
      for (const x of tt) { const s = tokenSim(w, x); if (s > best) { best = s; bestTok = x; } }
      for (const j of joined) if (j.includes(w) && tt.includes(j)) { best = 1; bestTok = j; }
      const wt = bestTok ? idf(bestTok) : Math.log(1 + pool.length);
      want += wt; got += wt * best;
      if (bestTok && best > 0) covered.add(bestTok);
    }
    const titleWeight = tt.reduce((s, x) => s + idf(x), 0) || 1;
    const titleCovered = [...covered].reduce((s, x) => s + idf(x), 0);
    const score = 0.75 * (want ? got / want : 0) + 0.25 * (titleCovered / titleWeight);
    return { thread: th, score: +score.toFixed(3) };
  }).sort((a, b) => b.score - a.score || (b.thread.last_activity || 0) - (a.thread.last_activity || 0));

  const [best, second] = scored;
  const candidates = scored.slice(0, 3).map(s => ({ title: s.thread.title, score: s.score }));
  if (!best || best.score < 0.55) return { ok: false, reason: 'no_match', candidates };
  if (second && second.score >= best.score - 0.08) return { ok: false, reason: 'ambiguous', candidates };
  return { ok: true, thread: best.thread, score: best.score, candidates };
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

const claimWaiters = new Map();   // host → Set<resolve> (relay long-polls)
const replyWaiters = new Map();   // job id → resolve (inline voice waits)

function newId() { return 'tr_' + randomBytes(5).toString('hex'); }

export function getJob(id) {
  ensureThreadRelaySchema();
  return get(`SELECT * FROM thread_relay_jobs WHERE id = :id`, { ':id': id }) || null;
}

export function listJobs({ host = null, status = null, limit = 50 } = {}) {
  ensureThreadRelaySchema();
  sweep();
  const where = [];
  const p = { ':l': Math.min(200, Number(limit) || 50) };
  if (host) { where.push('host = :h'); p[':h'] = host; }
  if (status) { where.push('status = :s'); p[':s'] = status; }
  return all(`SELECT * FROM thread_relay_jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
              ORDER BY created_at DESC LIMIT :l`, p);
}

// The text the target thread receives. It names the request id so the relay
// can find this exact turn in the thread's transcript.
export function composeMessage(job) {
  const said = job.utterance && job.utterance !== job.text
    ? `They said to PAN: "${job.utterance}"\nThe part meant for you: "${job.text}"`
    : `They say: "${job.text}"`;
  return `[PAN voice relay · req ${job.id}] Your user is talking to you by voice through PAN on their phone, away from the computer.\n`
    + `${said}\n`
    + (job.convo ? `What they had just been talking about with PAN, oldest first:\n${job.convo}\n` : '')
    + `Handle it as if they typed it here. Your final message is read aloud to them, so open it with a short plain spoken answer (one to three sentences, no markdown); details can follow below that.`;
}

export function enqueueJob({ thread, text, utterance = null, source = null, device_id = null, kind = 'send', convo = null }) {
  ensureThreadRelaySchema();
  const job = {
    id: newId(), host: thread.host, session_id: thread.session_id, title: thread.title,
    text: String(text).slice(0, 4000), utterance: utterance ? String(utterance).slice(0, 4000) : null,
    status: 'queued', source, device_id, created_at: Date.now(), kind: kind === 'status' ? 'status' : 'send',
    convo: convo ? String(convo).slice(-3000) : null,
  };
  run(`INSERT INTO thread_relay_jobs (id, host, session_id, title, text, utterance, status, source, device_id, created_at, kind, convo)
       VALUES (:id, :h, :s, :t, :x, :u, 'queued', :src, :d, :c, :k, :cv)`, {
    ':id': job.id, ':h': job.host, ':s': job.session_id, ':t': job.title, ':x': job.text,
    ':u': job.utterance, ':src': source, ':d': device_id, ':c': job.created_at, ':k': job.kind, ':cv': job.convo,
  });
  const ws = claimWaiters.get(job.host);
  if (ws) for (const r of [...ws]) r();
  return job;
}

function claimOne(host) {
  const row = get(`SELECT * FROM thread_relay_jobs WHERE host = :h AND status = 'queued' ORDER BY created_at LIMIT 1`, { ':h': host });
  if (!row) return null;
  const res = run(`UPDATE thread_relay_jobs SET status = 'claimed', claimed_at = :t WHERE id = :id AND status = 'queued'`,
    { ':t': Date.now(), ':id': row.id });
  if (res && res.changes === 0) return null;
  const job = getJob(row.id);
  return { ...job, message: composeMessage(job) };
}

// Long-poll: resolve with the next job for this host, or null after waitMs.
export async function claimNext(host, waitMs = 25_000) {
  ensureThreadRelaySchema();
  sweep();
  relayHeartbeat(host, { polling: true });
  const now = claimOne(host);
  if (now) return now;
  return new Promise((resolve) => {
    let set = claimWaiters.get(host);
    if (!set) { set = new Set(); claimWaiters.set(host, set); }
    const done = (val) => { clearTimeout(timer); set.delete(wake); resolve(val); };
    const wake = () => { const j = claimOne(host); if (j) done(j); };
    const timer = setTimeout(() => done(null), Math.max(1000, Math.min(55_000, waitMs)));
    set.add(wake);
  });
}

export function markDelivered(id, { delivery = null, message_id = null } = {}) {
  run(`UPDATE thread_relay_jobs SET status = 'delivered', delivered_at = :t, delivery = :d, message_id = :m
       WHERE id = :id AND status IN ('claimed','queued')`,
    { ':t': Date.now(), ':d': delivery, ':m': message_id, ':id': id });
  return getJob(id);
}

export async function postReply(id, text) {
  const job = getJob(id);
  if (!job) return { ok: false, error: 'no such job' };
  if (job.status === 'replied') return { ok: true, duplicate: true, job };
  run(`UPDATE thread_relay_jobs SET status = 'replied', reply = :r, replied_at = :t WHERE id = :id`,
    { ':r': String(text || '').slice(0, 20000), ':t': Date.now(), ':id': id });
  return finish(getJob(id));
}

export async function markFailed(id, error) {
  const job = getJob(id);
  if (!job) return { ok: false, error: 'no such job' };
  if (job.status === 'replied' || job.status === 'failed') return { ok: true, duplicate: true, job };
  run(`UPDATE thread_relay_jobs SET status = 'failed', error = :e, replied_at = :t WHERE id = :id`,
    { ':e': String(error || 'failed').slice(0, 1000), ':t': Date.now(), ':id': id });
  return finish(getJob(id));
}

// Hand the outcome to whoever is waiting: the open voice turn if there is one,
// otherwise the phone's notification queue as something to speak.
async function finish(job) {
  const waiter = replyWaiters.get(job.id);
  if (waiter) {
    replyWaiters.delete(job.id);
    run(`UPDATE thread_relay_jobs SET spoken = 1 WHERE id = :id`, { ':id': job.id });
    waiter(job);
    return { ok: true, delivered_to: 'voice_turn', job };
  }
  const speech = spokenOutcome(job);
  try {
    const { enqueuePhoneNote } = await import('./routes/api.js');
    enqueuePhoneNote({ type: 'speak', title: `${shortTitle(job.title)} thread`, body: speech,
      data: { job_id: job.id, session_id: job.session_id } });
    run(`UPDATE thread_relay_jobs SET spoken = 1 WHERE id = :id`, { ':id': job.id });
    return { ok: true, delivered_to: 'phone_queue', job };
  } catch (e) {
    console.warn('[ThreadRelay] phone queue failed:', e.message);
    return { ok: true, delivered_to: 'none', job };
  }
}

// Wait in the open voice turn for the answer. Returns the job when it has an
// outcome, or null on timeout/abort, in which case finish() routes it to the
// phone queue later.
export function waitForOutcome(id, ms, signal = null) {
  const job = getJob(id);
  if (job && (job.status === 'replied' || job.status === 'failed')) return Promise.resolve(job);
  return new Promise((resolve) => {
    const done = (val) => { clearTimeout(timer); if (replyWaiters.get(id) === waiter) replyWaiters.delete(id); resolve(val); };
    const waiter = (j) => done(j);
    const timer = setTimeout(() => done(null), ms);
    replyWaiters.set(id, waiter);
    signal?.addEventListener?.('abort', () => done(null), { once: true });
  });
}

function sweep() {
  const now = Date.now();
  const stale = all(`SELECT id, status FROM thread_relay_jobs
    WHERE (status = 'claimed' AND claimed_at < :c) OR (status = 'delivered' AND delivered_at < :r)
       OR (status = 'queued' AND created_at < :q)`,
    { ':c': now - CLAIM_TIMEOUT_MS, ':r': now - REPLY_TIMEOUT_MS, ':q': now - CLAIM_TIMEOUT_MS * 3 });
  for (const s of stale) {
    const why = s.status === 'delivered' ? 'no answer after 45 minutes' : 'the relay never picked it up';
    markFailed(s.id, why).catch(() => {});
  }
}

// ── Speech shaping ───────────────────────────────────────────────────────────

// Spoken name for a thread: drops a leading all-caps project tag ("ABC Map
// Editor" -> "Map Editor") when something is left after it.
export function shortTitle(title) {
  // Drop a project tag ("WOE Map Creation" → "Map Creation"), but not when it is half the name ("PC Stuff").
  const t = String(title || 'that').replace(/^[A-Z]{2,5}\s+(?=\S+\s+\S)/, '').replace(/\s*[+/&|]\s*/g, ' and ').trim();
  return t.length > 40 ? t.slice(0, 40).replace(/\s+\S*$/, '') : t;
}

// Markdown reply → something worth hearing. Speaks the opening answer only.
export function toSpeech(md, maxChars = 450) {
  let s = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~>#]/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '.') + ' The rest is in the thread.';
}

export function spokenOutcome(job) {
  const name = shortTitle(job.title);
  if (job.status === 'failed') return `Couldn't get an answer from ${name}: ${job.error || 'it failed'}.`;
  if (job.kind === 'status') return `${name}: ${toSpeech(job.reply)}`;
  return `${name} says: ${toSpeech(job.reply)}`;
}

// ── Voice parsing (deterministic, runs before the LLM) ───────────────────────

// "send a new message to the X thread"; the phone often clips the first word, leaving "a new message the X thread".
const VERB = '(?:tell|ask|(?:send\\s+)?(?:a\\s+)?(?:new\\s+)?message(?:\\s+to)?|ping|text|say to|send to|check with)';
// "Pen, I need you to send a message to the Elipsis thread" fell through to the voice model, which said it couldn't (2026-11-05).
const LEAD = '^(?:(?:hey|ok|okay)\\s+)?(?:(?:pan|pam|pann|pen)[,.]?\\s+)?(?:(?:can|could|would) you\\s+|i (?:need|want) you to\\s+)?(?:please\\s+)?';
const ANCHORED = new RegExp(`${LEAD}${VERB}\\s+(?:the\\s+|my\\s+)?(.{1,48}?)\\s+(?:thread|session|chat)\\b[\\s,:.-]*(.*)$`, 'i');
const IN_THREAD = new RegExp(`${LEAD}(?:in|on|to|over in)\\s+(?:the\\s+|my\\s+)?(.{1,48}?)\\s+(?:thread|session|chat)\\b[\\s,:.-]+(.+)$`, 'i');
const LOOSE = new RegExp(`${LEAD}${VERB}\\s+(?:the\\s+)?(.+)$`, 'i');
const FOLLOWUP = new RegExp(`${LEAD}(?:tell it|ask it|reply|answer it|say back|tell them|ask them)\\b[\\s,:.-]*(.+)$`, 'i');
const LIST = /\b(?:list|which|what)\b.*\b(?:threads|sessions)\b/i;
const LAST_REPLY = /\bwhat did (?:the\s+)?(.{1,48}?)\s*(?:thread|session)?\s+(?:say|answer|reply)\b/i;
// Status asks are answered from the transcript, so a busy thread is never interrupted:
// "can you see what my PC stuff thread is doing", "is the tasks thread done", "check on the map thread".
const STATUS = [
  /\b(?:what(?:'s| is)|see what|tell me what|check what|know what)\s+(?:the\s+|my\s+)?(.{1,48}?)\s+(?:thread|session|chat)\s+(?:is\s+|'s\s+)?(?:doing|up to|working on)\b/i,
  /\b(?:check on|status of|how(?:'s| is))\s+(?:the\s+|my\s+)?(.{1,48}?)\s+(?:thread|session|chat)\b(?:\s+(?:doing|going))?\s*(?:right now|now)?\s*[?.!]*$/i,
  /\bis\s+(?:the\s+|my\s+)?(.{1,48}?)\s+(?:thread|session|chat)\s+(?:done|finished|still (?:working|going|running)|busy|stuck|working)\b/i,
];

function cleanBody(s) {
  return String(s || '').replace(/^(?:that|to|saying)\s+/i, '').trim();
}

// One thread per machine does that machine's jobs: "on the mint open firefox", "play this video
// on the g16", "tell the mint to check my messages". It is the thread on that host with "PC" or
// "Computer" in its title. A machine name can be an everyday word ("mint"), so the line has to read
// as a command: an action word or a question must follow, or come first.
const ACTION = '(?:open|close|start|stop|restart|reboot|run|launch|install|uninstall|update|turn|switch|change|set|show|find|check|clean|kill|shut|download|upload|play|pause|resume|skip|mute|unmute|watch|read|write|send|reply|answer|post|search|look|see|go|get|pull|put|add|remove|fix|build|save|print|record|sign|log|connect|join|move|copy|delete|make|take)';
const ASKING = '(?:what|which|why|how|where|is|are|does|do)';
const MACHINE_NOUN = '(?:\\s+(?:computer|pc|desktop|laptop|machine|box))?';

function computerRequest(text, machines) {
  const keys = Object.keys(machines);
  if (!keys.length) return null;
  const name = `(?:the\\s+|my\\s+)?(${keys.map(k => k.replace(/([a-z])(\d)/g, '$1\\s*$2')).join('|')})${MACHINE_NOUN}`;
  const front = new RegExp(`${LEAD}(?:on|over on)\\s+${name}[\\s,:.-]+((?:please\\s+)?(?:${ACTION}|${ASKING})\\b.*)$`, 'i').exec(text);
  if (front) return { machine: front[1], body: front[2] };
  const back = new RegExp(`${LEAD}((?:${ACTION}|${ASKING})\\b.+?)\\s+(?:on|in)\\s+${name}\\s*[.!?]*$`, 'i').exec(text);
  if (back) return { machine: back[2], body: back[1] };
  const told = new RegExp(`${LEAD}(?:tell|ask|have|get)\\s+${name}(?:\\s+to\\s+|\\s*[,:]\\s*|\\s+(?=${ASKING}\\b))(.+)$`, 'i').exec(text);
  if (told) return { machine: told[1], body: told[2] };
  return null;
}

function computerCommand(text, threads) {
  const machines = spokenMachines();
  const req = computerRequest(text, machines);
  if (!req) return null;
  if (!threads.length) return { kind: 'no_relay' };
  const key = req.machine.toLowerCase().replace(/\s+/g, '');
  const thread = distinctThreads(threads).find(t => t.host === machines[key] && /\b(?:computer|pc)\b/i.test(t.title));
  const body = cleanBody(req.body).replace(/[.!?]+$/, '');
  return thread ? { kind: 'send', thread, text: body } : { kind: 'no_computer', machine: req.machine };
}

// "tell the PAN thread about what we just talked about": the words point at the voice
// conversation, so the thread gets those turns too. Sent bare, the PAN thread got only
// "about what you just talked about" and had nothing to go on (2026-11-03).
const REFERS_BACK = /\b(?:what (?:you|we|i|you and i) (?:just |were )?(?:talk(?:ed|ing) about|said|discuss(?:ed|ing)|went over)|(?:our|this|the|that) (?:conversation|chat|discussion|talk)(?![-\w])|everything (?:we|you|i) (?:just )?(?:said|discussed|talked about)|^about (?:that|this|it)\s*[.!?]*$)/i;

// The last voice turns before this one, relabelled for the thread. History lines come in as
// "You:"/"User:" for him and "PAN:" for PAN; the line that asked for the relay is dropped,
// matched on the request words too, since the phone's transcript of it can differ from the hub's.
export function recentConvo(history, utterance, body = '', maxLines = 10) {
  const said = String(utterance || '').trim().toLowerCase();
  const ask = String(body || '').trim().toLowerCase();
  const lines = String(history || '').split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => l.replace(/^(?:You|User|Me):\s*/i, 'User: '))
    .filter(l => !(said && l.toLowerCase() === 'user: ' + said) && !(ask.length > 10 && /^user: /i.test(l) && l.toLowerCase().includes(ask)));
  return lines.slice(-maxLines).join('\n') || null;
}

// "Which thread, Tasks or Jira Playbook?" → "the tasks one" picks from these.
let _pendingChoice = null;   // { threads, text, at }
const CHOICE_WINDOW_MS = 90_000;

function lastJob() {
  return get(`SELECT * FROM thread_relay_jobs ORDER BY created_at DESC LIMIT 1`);
}

// Returns null when the utterance is not about threads, else one of:
//   { kind: 'send', thread, text }  { kind: 'ambiguous', candidates }
//   { kind: 'unknown', name }       { kind: 'list' }  { kind: 'last', job }
//   { kind: 'no_relay' }            { kind: 'no_computer', machine }
export function parseThreadCommand(utterance) {
  ensureThreadRelaySchema();
  const text = String(utterance || '').trim();
  if (!text) return null;
  const threads = listThreads();

  if (LIST.test(text) && /\b(?:claude|threads|sessions|open)\b/i.test(text)) return { kind: 'list', threads };

  for (const re of STATUS) {
    const m = re.exec(text);
    if (!m) continue;
    if (!threads.length) return { kind: 'no_relay' };
    const r = matchThread(m[1], threads);
    if (r.ok) return { kind: 'send', status: true, thread: r.thread, text: 'What is this thread doing right now?' };
    if (r.reason === 'ambiguous') {
      const names = new Set(r.candidates.slice(0, 2).map(c => c.title));
      _pendingChoice = { threads: distinctThreads(threads).filter(t => names.has(t.title)), text: 'What is this thread doing right now?', status: true, utterance: text, at: Date.now() };
      return { kind: 'ambiguous', candidates: r.candidates };
    }
    return { kind: 'unknown', name: m[1] };
  }

  const last = LAST_REPLY.exec(text);
  if (last) {
    // Only a named thread, "thread"/"session" said out loud, or it/that/they while the last
    // relay exchange is fresh. Any other name fell through to the newest relay job, so "what
    // did I say the dog is called" was answered with another thread's reply (voicebench,
    // 2026-11-02). A person ("I", "you", "she") is never a thread.
    const name = last[1].trim();
    const pronoun = /^(?:it|that|they)$/i.test(name);
    const anchored = /\b(?:thread|session)\b/i.test(text);
    const m = pronoun || /^(?:i|you|we|he|she)$/i.test(name) ? null : matchThread(name, threads);
    if (m?.ok) {
      const job = get(`SELECT * FROM thread_relay_jobs WHERE session_id = :s AND status IN ('replied','failed') ORDER BY created_at DESC LIMIT 1`, { ':s': m.thread.session_id });
      return { kind: 'last', job: job || null };
    }
    if (pronoun || anchored) {
      const job = get(`SELECT * FROM thread_relay_jobs WHERE status IN ('replied','failed') ORDER BY created_at DESC LIMIT 1`);
      if (job && (anchored || Date.now() - job.created_at < FOLLOWUP_WINDOW_MS)) return { kind: 'last', job };
      if (anchored) return { kind: 'last', job: null };
    }
  }

  if (_pendingChoice && Date.now() - _pendingChoice.at < CHOICE_WINDOW_MS && text.split(/\s+/).length <= 6) {
    const r = matchThread(text.replace(/\b(?:one|the|thread)\b/gi, ' '), _pendingChoice.threads);
    if (r.ok) {
      const pending = _pendingChoice; _pendingChoice = null;
      return { kind: 'send', status: !!pending.status, thread: r.thread, text: pending.text, utterance: pending.utterance };
    }
  }

  const fu = FOLLOWUP.exec(text);
  if (fu) {
    const prev = lastJob();
    if (prev && Date.now() - prev.created_at < FOLLOWUP_WINDOW_MS) {
      const thread = threads.find(t => t.session_id === prev.session_id) || { host: prev.host, session_id: prev.session_id, title: prev.title };
      return { kind: 'send', thread, text: cleanBody(fu[1]) };
    }
  }

  for (const re of [ANCHORED, IN_THREAD]) {
    const m = re.exec(text);
    if (!m) continue;
    const body = cleanBody(m[2]);
    if (!threads.length) return { kind: 'no_relay' };
    const r = matchThread(m[1], threads);
    if (r.ok) return body ? { kind: 'send', thread: r.thread, text: body } : { kind: 'empty', thread: r.thread };
    if (r.reason === 'ambiguous') {
      if (body) {
        const names = new Set(r.candidates.slice(0, 2).map(c => c.title));
        _pendingChoice = { threads: distinctThreads(threads).filter(t => names.has(t.title)), text: body, utterance: text, at: Date.now() };
      }
      return { kind: 'ambiguous', candidates: r.candidates };
    }
    return { kind: 'unknown', name: m[1] };
  }

  const computer = computerCommand(text, threads);
  if (computer) return computer;

  // No "thread" anchor: "ask map creation what it's doing". Only take it when
  // the words right after the verb are a confident, unambiguous title match,
  // so ordinary "tell me a joke" never lands here.
  const loose = LOOSE.exec(text);
  if (loose && threads.length) {
    const words = loose[1].split(/\s+/);
    if (/^(?:me|us|him|her|them|it|everyone|somebody|someone)$/i.test(words[0])) return null;
    for (let n = Math.min(4, words.length - 1); n >= 1; n--) {
      const name = words.slice(0, n).join(' ');
      const body = cleanBody(words.slice(n).join(' '));
      if (!body) continue;
      const r = matchThread(name, threads);
      if (r.ok && r.score >= 0.8) return { kind: 'send', thread: r.thread, text: body };
    }
  }
  return null;
}

// Run a parsed command end to end for the voice router. Yields
// { type:'chunk', text } and finally { type:'done', result }.
export async function* handleThreadCommand(cmd, utterance, context = {}, inlineWaitMs = 22_000) {
  const done = (response, extra = {}) => ({ type: 'done', result: { intent: 'thread', speech_act: 'command', response, addressed: 1, importance: 0.5, ...extra } });

  if (cmd.kind === 'list') {
    const names = distinctThreads(cmd.threads).slice(0, 8).map(t => shortTitle(t.title));
    const say = names.length ? `Your most recent threads are ${names.join(', ')}.` : `No relay has reported any threads yet.`;
    yield { type: 'chunk', text: say }; yield done(say); return;
  }
  if (cmd.kind === 'last') {
    const say = cmd.job ? spokenOutcome(cmd.job) : `I haven't heard back from that thread yet.`;
    yield { type: 'chunk', text: say }; yield done(say); return;
  }
  if (cmd.kind === 'no_relay') {
    const say = `The thread relay isn't connected, so I can't reach your Claude threads right now.`;
    yield { type: 'chunk', text: say }; yield done(say); return;
  }
  if (cmd.kind === 'ambiguous') {
    const names = cmd.candidates.slice(0, 2).map(c => shortTitle(c.title));
    const say = `Which thread, ${names.join(' or ')}?`;
    yield { type: 'chunk', text: say }; yield done(say, { thread_candidates: cmd.candidates }); return;
  }
  if (cmd.kind === 'unknown') {
    const say = `I couldn't find a thread called ${cmd.name}.`;
    yield { type: 'chunk', text: say }; yield done(say); return;
  }
  if (cmd.kind === 'no_computer') {
    const say = `There's no computer thread on the ${cmd.machine} yet.`;
    yield { type: 'chunk', text: say }; yield done(say); return;
  }
  if (cmd.kind === 'empty') {
    const say = `What should I tell ${shortTitle(cmd.thread.title)}?`;
    yield { type: 'chunk', text: say }; yield done(say); return;
  }

  const name = shortTitle(cmd.thread.title);
  const alive = relayStatus().find(r => r.host === cmd.thread.host)?.alive;
  const said = cmd.utterance || utterance;
  const convo = !cmd.status && REFERS_BACK.test(cmd.text) ? recentConvo(context.conversation_history, said, cmd.text) : null;
  const job = enqueueJob({ thread: cmd.thread, text: cmd.text, utterance: said, source: context.source || null, device_id: context.device_id || null, kind: cmd.status ? 'status' : 'send', convo });
  const ack = !alive ? `Queued for ${name}, but its relay looks offline.` : cmd.status ? `Checking.` : convo ? `Sent to ${name}, with what we were just talking about.` : `Sent to ${name}.`;
  yield { type: 'chunk', text: ack };

  const outcome = alive ? await waitForOutcome(job.id, inlineWaitMs, context.signal) : null;
  if (outcome) {
    const say = spokenOutcome(outcome);
    yield { type: 'chunk', text: ' ' + say };
    yield done(`${ack} ${say}`, { thread_job: job.id, thread: cmd.thread.title });
    return;
  }
  const later = ` I'll read you the answer when it comes.`;
  yield { type: 'chunk', text: later };
  yield done(ack + later, { thread_job: job.id, thread: cmd.thread.title });
}

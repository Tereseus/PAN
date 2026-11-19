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
  // Whose computer a host is (docs/PEOPLE-PLAN.md): owner_user_id is the person it belongs to
  // (null: the owner), link_device_id the PAN Link device that holds the name. asked_by: who
  // asked a job (null: the owner).
  try { db.exec(`ALTER TABLE thread_relay_hosts ADD COLUMN owner_user_id INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE thread_relay_hosts ADD COLUMN link_device_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE thread_relay_jobs ADD COLUMN asked_by INTEGER`); } catch {}
  _schemaReady = true;
}

// ── Relay heartbeat + thread registry ────────────────────────────────────────

export function relayHeartbeat(host, info = {}) {
  ensureThreadRelaySchema();
  run(`INSERT INTO thread_relay_hosts (host, last_seen, info) VALUES (:h, :t, :i)
       ON CONFLICT(host) DO UPDATE SET last_seen = :t, info = :i`,
    { ':h': host, ':t': Date.now(), ':i': JSON.stringify(info || {}) });
}

/**
 * May this caller speak for this relay host, and whose computer is it?
 *
 * A person's computer is that person's client: its relay reports that computer's threads and
 * takes the jobs for them, and nothing else. A host name belongs to the PAN Link device that
 * first used it, so a person's computer can never report threads as one of the owner's
 * computers or another person's, or take their jobs. The owner's own computers are not held to
 * this among themselves (they are all his), but none of them can take a name a person's
 * computer holds. A device the owner hands to a person, or takes back, carries its host with it.
 * who: { person, linkDevice }: person is req.user when it is a person's device, else null.
 */
export function holdHost(host, { person = null, linkDevice = null } = {}) {
  ensureThreadRelaySchema();
  const name = String(host || '').trim();
  if (!name) return false;
  const uid = person ? Number(person.id) || 0 : null;
  if (person && (!uid || !linkDevice)) return false;
  const row = get(`SELECT owner_user_id, link_device_id FROM thread_relay_hosts WHERE host = :h`, { ':h': name });
  if (!row) {
    run(`INSERT INTO thread_relay_hosts (host, last_seen, info, owner_user_id, link_device_id) VALUES (:h, 0, '{}', :u, :l)`,
      { ':h': name, ':u': uid, ':l': linkDevice || null });
    return true;
  }
  const sameDevice = !!linkDevice && row.link_device_id === linkDevice;
  if (person) {
    if (!sameDevice) return false;
    if (row.owner_user_id !== uid) run(`UPDATE thread_relay_hosts SET owner_user_id = :u WHERE host = :h`, { ':u': uid, ':h': name });
    return true;
  }
  if (row.owner_user_id != null) {
    if (!sameDevice) return false;   // a person's computer holds this name
    run(`UPDATE thread_relay_hosts SET owner_user_id = NULL WHERE host = :h`, { ':h': name });   // taken back
    return true;
  }
  if (linkDevice && row.link_device_id !== linkDevice) run(`UPDATE thread_relay_hosts SET link_device_id = :l WHERE host = :h`, { ':l': linkDevice, ':h': name });
  return true;
}

/** Whether a job is on a host this caller holds (a person's relay sees no other job). */
export function holdsJob(job, who) {
  if (!job) return false;
  if (!who?.person) return true;
  const row = get(`SELECT owner_user_id, link_device_id FROM thread_relay_hosts WHERE host = :h`, { ':h': job.host });
  return !!row && !!who.linkDevice && row.link_device_id === who.linkDevice && row.owner_user_id === Number(who.person.id);
}

/** A paired device was removed: the hosts it held, and their threads, go with it. */
export function forgetHostsOf(linkDevice) {
  ensureThreadRelaySchema();
  if (!linkDevice) return 0;
  const hosts = all(`SELECT host FROM thread_relay_hosts WHERE link_device_id = :l AND owner_user_id IS NOT NULL`, { ':l': linkDevice });
  for (const h of hosts) {
    run(`DELETE FROM thread_relay_threads WHERE host = :h`, { ':h': h.host });
    run(`DELETE FROM thread_relay_hosts WHERE host = :h`, { ':h': h.host });
  }
  return hosts.length;
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

/**
 * The threads one viewer can reach. The owner (no person) sees every computer's, with `theirs`
 * set on those of a person's computer and `owner_name` saying whose. A person sees the threads
 * on that person's own computers and nothing else.
 */
export function listThreads({ person = null } = {}) {
  ensureThreadRelaySchema();
  let rows;
  try {
    rows = all(`SELECT t.host, t.session_id, t.title, t.cwd, t.last_activity, t.pinned,
                       CASE WHEN h.last_seen > :alive THEN 1 ELSE 0 END AS host_alive,
                       h.owner_user_id, u.display_name AS owner_name, u.is_active AS owner_active
                  FROM thread_relay_threads t LEFT JOIN thread_relay_hosts h ON h.host = t.host
                  LEFT JOIN users u ON u.id = h.owner_user_id
                 ORDER BY host_alive DESC, t.last_activity DESC`, { ':alive': Date.now() - RELAY_ALIVE_MS });
  } catch {
    // No users table (a bare test database): every thread is the owner's.
    rows = all(`SELECT t.host, t.session_id, t.title, t.cwd, t.last_activity, t.pinned,
                       CASE WHEN h.last_seen > :alive THEN 1 ELSE 0 END AS host_alive, NULL AS owner_user_id
                  FROM thread_relay_threads t LEFT JOIN thread_relay_hosts h ON h.host = t.host
                 ORDER BY host_alive DESC, t.last_activity DESC`, { ':alive': Date.now() - RELAY_ALIVE_MS });
  }
  // A computer whose person is gone is nobody's: its threads are not offered to anyone.
  rows = rows.filter(r => r.owner_user_id == null || r.owner_active === 1)
    .map(({ owner_active, ...r }) => ({ ...r, theirs: r.owner_user_id != null ? 1 : 0 }));
  if (!person) return rows;
  const uid = Number(person.id) || 0;
  return rows.filter(r => uid && r.owner_user_id === uid).map(r => ({ ...r, theirs: 0 }));
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

// For the owner a person's first name means that person's computer: "what is Maria's homework
// thread doing", "list Maria's threads". Only while the person has one computer, and never over
// a machine word of the owner's own.
function machinesFor(threads) {
  const machines = { ...spokenMachines() };
  const hosts = new Map();
  for (const t of threads || []) {
    if (!t.theirs || !t.owner_name) continue;
    const w = tokens(t.owner_name)[0];
    if (!w || FILLER.has(w)) continue;
    if (!hosts.has(w)) hosts.set(w, new Set());
    hosts.get(w).add(t.host);
  }
  const people = [];
  for (const [w, set] of hosts) {
    if (set.size !== 1 || machines[w]) continue;
    machines[w] = [...set][0];
    people.push(w);
    if (!w.endsWith('s') && !machines[w + 's']) machines[w + 's'] = machines[w];   // "marias", as STT often writes it
  }
  return { machines, people };
}
// "maria's homework" is said of Maria's computer: the 's is no part of the thread's name.
function dropPossessive(text, people) {
  let out = String(text || '');
  for (const w of people) out = out.replace(new RegExp(`\\b(${w})(?:['’]s|s['’])(?=\\s|$)`, 'gi'), '$1');
  return out;
}

const FILLER = new Set(['the', 'a', 'an', 'my', 'our', 'that', 'this', 'thread', 'threads', 'session', 'sessions',
  'chat', 'claude', 'tab', 'one', 'please', 'and', 'uh', 'um', 'umm', 'er', 'erm', 'hmm']);

function tokens(s) {
  const lower = String(s || '').toLowerCase().replace(/[α-ωάέήίόύώς]/g, c => GREEK[c] || c)
    .replace(/\+/g, ' plus ').replace(/&/g, ' and ');   // "Bi + Anim" is said "bi plus anim" (Nov 14)
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

// Rough sound of a word: first letter, then its consonants, y as a vowel, doubles collapsed.
// "buy" and "bi" are both "b"; the speech model writes what it hears, not the title (Nov 14).
function soundKey(w) {
  const s = w.replace(/ph/g, 'f').replace(/ck/g, 'k');
  return (s[0] + s.slice(1).replace(/[aeiouy]/g, '')).replace(/(.)\1+/g, '$1');
}

function tokenSim(a, b) {
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.85;
  const d = lev(a, b);
  const len = Math.max(a.length, b.length);
  if (len >= 4 && d === 1) return 0.8;
  if (len >= 7 && d === 2) return 0.65;
  if (/^[a-z]+$/.test(a) && /^[a-z]+$/.test(b) && soundKey(a) === soundKey(b)) return 0.7;
  // A two letter title word is often short for a longer one: "Bi" for bipedal.
  if (b.length === 2 && a.length >= 5 && a.startsWith(b)) return 0.6;
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

// "thread two", "number 2", "the second one": a place in the last list ΠAN read out (Nov 15).
// Titles are long and odd, so he can't be expected to know them; a number from the list he just heard works.
const NUMBER_WORDS = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5,
  six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10 };
const NUMBER_RE = '(?:[1-9][0-9]?|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)';
const NUMBER_REF = new RegExp(`^(?:(?:the|number|no\\.?|thread|session|chat)\\s+)*(${NUMBER_RE})(?:\\s+(?:one|thread|session|chat))?$`, 'i');
function numberRef(name) {
  const m = NUMBER_REF.exec(String(name || '').trim().replace(/[.,!?#]+/g, ' ').replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const w = m[1].toLowerCase();
  return (NUMBER_WORDS[w] || Number(w)) - 1;
}
// What one listener was last told, kept per person (key 0: the owner): `list` is the numbered
// list ΠAN last read out ({ threads, at }), `pending` the choice it offered. One person's list
// must never be what another person's "number two" counts in.
const _heard = new Map();
function heardBy(person) {
  const key = person ? Number(person.id) || -1 : 0;
  let st = _heard.get(key);
  if (!st) { st = { list: null, pending: null }; _heard.set(key, st); }
  return st;
}
let _st = heardBy(null);   // whose is in use for the length of one parse (parseThreadCommand is not async)
const LIST_WINDOW_MS = 15 * 60_000;
// The order a number counts in: the list he heard, else the order a list would be read in now.
function numberedThreads(threads) {
  if (_st.list && Date.now() - _st.list.at < LIST_WINDOW_MS) return _st.list.threads;
  return distinctThreads(threads);
}

export function matchThread(spokenName, threads = listThreads(), { ordered = false } = {}) {
  const at = numberRef(spokenName);
  if (at != null) {
    const list = ordered ? threads : numberedThreads(threads);
    const th = list[at];
    return th ? { ok: true, thread: th, score: 1, by_number: at + 1, candidates: [{ title: th.title, score: 1 }] }
      : { ok: false, reason: 'no_number', number: at + 1, candidates: [] };
  }
  const { machines, people } = machinesFor(threads);
  let { t: said, joined } = spokenTokens(dropPossessive(spokenName, people));
  // "pan, not mint pan": what follows "not" is ruled out, never a target. A machine after "not"
  // excludes that machine. Before this, "not mint pan" made Mint the hard limit (2026-11-11).
  let excludeHost = null;
  const notAt = said.indexOf('not');
  if (notAt >= 0) {
    const after = said.slice(notAt + 1);
    const neg = after.find(w => machines[w]);
    if (neg) excludeHost = machines[neg];
    said = notAt > 0 ? said.slice(0, notAt) : after.filter(w => !machines[w]);
    joined = said.slice(0, -1).map((w, i) => w + said[i + 1]);
  }
  const { machine, rest: words } = machineSaid(said, joined, machines);
  // The owner's own threads come first. A thread on a person's computer is meant when he says
  // whose ("Maria's homework thread"), or when nothing of his own fits the name.
  if (!machine && threads.some(t => t.theirs) && threads.some(t => !t.theirs)) {
    const mine = matchThread(spokenName, threads.filter(t => !t.theirs), { ordered });
    if (mine.ok || mine.reason === 'ambiguous') return mine;
    const other = matchThread(spokenName, threads.filter(t => t.theirs), { ordered });
    return other.ok || other.reason === 'ambiguous' ? other : mine;
  }
  // A machine said out loud is a hard limit: "mint music" must never reach the G16's Music thread.
  // The machine first, then one row per title: two computers can each have a thread called "Notes".
  const pool = distinctThreads(threads.filter(th => (!machine || th.host === machines[machine]) && (!excludeHost || th.host !== excludeHost)));
  if (!said.length || !pool.length) return { ok: false, reason: said.length ? 'no_threads' : 'no_name', candidates: [] };

  // An exact title wins. "PAN" scored the same as "Mint PAN" (the machine word is no part of
  // a name), so the relay asked "Which thread, PAN or Mint PAN?" forever (2026-11-11).
  const exact = pool.filter(th => {
    const tt = tokens(th.title).filter(w => !FILLER.has(w));
    return tt.length === said.length && tt.every((w, i) => w === said[i]);
  });
  if (exact.length === 1) return { ok: true, thread: exact[0], score: 1, candidates: [{ title: exact[0].title, score: 1 }] };
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

  // A copy whose title only adds words he did not say ("X (fork)") is no rival to X.
  const tokOf = (s) => titleTokens[pool.indexOf(s.thread)] || [];
  const bestTok = scored.length ? tokOf(scored[0]) : [];
  const isCopy = (s) => { const t = tokOf(s); return t.length > bestTok.length && bestTok.every(w => t.includes(w)) && t.filter(w => !bestTok.includes(w)).every(w => !words.some(x => tokenSim(x, w) > 0)); };
  const rivals = scored.filter((s, i) => i === 0 || !isCopy(s));
  const [best, second] = rivals;
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
export function composeMessage(job, { fromOwner = false } = {}) {
  // fromOwner: the thread is on a person's computer and the one asking is the owner of this ΠAN.
  const who = fromOwner
    ? `The owner of this ΠAN, who is in charge of this computer, is talking to you by voice through PAN. This is not the person who uses this computer.`
    : `Your user is talking to you by voice through PAN on their phone, away from the computer.`;
  const said = job.utterance && job.utterance !== job.text
    ? `They said to PAN: "${job.utterance}"\nThe part meant for you: "${job.text}"`
    : `They say: "${job.text}"`;
  return `[PAN voice relay · req ${job.id}] ${who}\n`
    + `${said}\n`
    + (job.convo ? `What they had just been talking about with PAN, oldest first:\n${job.convo}\n` : '')
    + `Handle it as if they typed it here. Your final message is read aloud to them, so open it with a short plain spoken answer (one to three sentences, no markdown); details can follow below that.`;
}

export function enqueueJob({ thread, text, utterance = null, source = null, device_id = null, kind = 'send', convo = null, asked_by = null }) {
  ensureThreadRelaySchema();
  const job = {
    id: newId(), host: thread.host, session_id: thread.session_id, title: thread.title,
    text: String(text).slice(0, 4000), utterance: utterance ? String(utterance).slice(0, 4000) : null,
    status: 'queued', source, device_id, created_at: Date.now(), kind: kind === 'status' ? 'status' : 'send',
    convo: convo ? String(convo).slice(-3000) : null, asked_by: asked_by == null ? null : Number(asked_by),
  };
  run(`INSERT INTO thread_relay_jobs (id, host, session_id, title, text, utterance, status, source, device_id, created_at, kind, convo, asked_by)
       VALUES (:id, :h, :s, :t, :x, :u, 'queued', :src, :d, :c, :k, :cv, :ab)`, {
    ':ab': job.asked_by,
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
  const hostOwner = get(`SELECT owner_user_id FROM thread_relay_hosts WHERE host = :h`, { ':h': host })?.owner_user_id ?? null;
  return { ...job, message: composeMessage(job, { fromOwner: hostOwner != null && job.asked_by == null }) };
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
    // To the device that asked, not to whichever device asks for notes first.
    enqueuePhoneNote({ type: 'speak', title: `${shortTitle(job.title)} thread`, body: speech,
      data: { job_id: job.id, session_id: job.session_id } }, null, { device: job.device_id || null });
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
// "Send another message to Pan that says ..." matched nothing in the car (2026-11-19), and the voice model said it had sent it.
const VERB = '(?:tell|ask|(?:send\\s+)?(?:a\\s+|another\\s+)?(?:new\\s+)?message(?:\\s+to)?|ping|text|say to|send to|check with)';
// "Pen, I need you to send a message to the Elipsis thread" fell through to the voice model, which said it couldn't (2026-11-05).
// A second ask in a row starts with "also" or "and": "Also, ask them why ..." fell to the voice model the same night.
const LEAD = '^(?:(?:and\\s+)?also[,.]?\\s+|and\\s+|then\\s+)?(?:(?:hey|ok|okay)\\s+)?(?:(?:pan|pam|pann|pen)[,.]?\\s+)?(?:(?:can|could|would) you\\s+|i (?:need|want) you to\\s+)?(?:please\\s+)?';
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
  return String(s || '').replace(/^(?:that\s+says|that|to|saying|says)\s+/i, '').trim();
}

// Said any other way round. The forms above want the asking at the very start of the line. In
// the car (2026-11-18) the asking came in the middle of a longer line, then with the thread named
// first and the asking after it, then as a complaint that it had not been sent: three asks, none
// matched, and the voice model took a photo and then said it had sent it. So: a word that asks for
// something to be passed on, anywhere in the line, and "<name> thread" where the name is a real
// thread's. The whole line goes to the thread, which can read a line said loosely.
const PASS_ON = /(?<!\b(?:i|we|he|she|they|i'll|we'll|i'd|who|don't|didn't|not|never|already)\s+)\b(?:tell|ask|send|push|ping|forward|notify|(?<!\b(?:a|an|the|new|any|another|that|this|my|your|voice)\s+)(?:message|update|pass|relay)(?=\s+(?:the|my|this|that|it|on|along)\b))\b/i;
const NAMED = /((?:[\p{L}\p{N}'-]+\s+){0,3}[\p{L}\p{N}'-]+)\s+(?:thread|session)\b(?:\s+(?:on|in|at)\s+(?:the\s+|my\s+)?([\p{L}\p{N}]+(?:\s?\d+)?))?/giu;

// Asking whether it was done ("did you send that to the X thread?") is a question for PAN, not a new send.
const WAS_IT_DONE = /\b(?:did|didn't|have|haven't|has|hasn't|was|wasn't)\s+(?:you|it|pan|that|this|anything)\s+(?:\w+\s+){0,2}?(?:tell|told|ask|asked|send|sent|push|pushed|message|messaged|ping|pinged|forward|forwarded|pass|passed|relay|relayed|notify|notified|update|updated|go|gone|get|got|reach|reached)\b/i;

function namedAnywhere(text, threads) {
  if (!PASS_ON.test(text) || WAS_IT_DONE.test(text) || !threads.length) return null;
  const { machines } = machinesFor(threads);
  let ambiguous = null;
  for (const m of text.matchAll(NAMED)) {
    const before = m[1].split(/\s+/);
    const machine = m[2] && machines[m[2].toLowerCase().replace(/\s+/g, '')] ? m[2] + ' ' : '';
    // The name is the last words before "thread"; how many is not known, so the longest that is a thread's.
    for (let n = before.length; n >= 1; n--) {
      const name = before.slice(-n).join(' ');
      if (!tokens(name).some(w => !FILLER.has(w))) continue;
      const r = matchThread(machine + name, threads);
      if (r.ok && r.score >= 0.8) return { ok: true, thread: r.thread };
      if (n <= 2 && r.reason === 'ambiguous' && r.candidates[0]?.score >= 0.8) ambiguous = ambiguous || r.candidates;
    }
  }
  return ambiguous ? { ok: false, candidates: ambiguous } : null;
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
  const name = `(?:the\\s+|my\\s+)?(${keys.map(k => k.replace(/([a-z])(\d)/g, '$1\\s*$2')).join('|')})(?:['’]s)?${MACHINE_NOUN}`;
  const front = new RegExp(`${LEAD}(?:on|over on)\\s+${name}[\\s,:.-]+((?:please\\s+)?(?:${ACTION}|${ASKING})\\b.*)$`, 'i').exec(text);
  if (front) return { machine: front[1], body: front[2] };
  const back = new RegExp(`${LEAD}((?:${ACTION}|${ASKING})\\b.+?)\\s+(?:on|in)\\s+${name}\\s*[.!?]*$`, 'i').exec(text);
  if (back) return { machine: back[2], body: back[1] };
  const told = new RegExp(`${LEAD}(?:tell|ask|have|get)\\s+${name}(?:\\s+to\\s+|\\s*[,:]\\s*|\\s+(?=${ASKING}\\b))(.+)$`, 'i').exec(text);
  if (told) return { machine: told[1], body: told[2] };
  return null;
}

function computerCommand(text, threads) {
  const { machines } = machinesFor(threads);
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
const REFERS_BACK = /\b(?:what (?:you|we|i|you and i) (?:just |were )?(?:talk(?:ed|ing) about|said|discuss(?:ed|ing)|went over)|(?:our|this|the|that) (?:conversation|chat|discussion|talk)s?(?![-\w])|everything (?:that )?(?:we|you|i) (?:just )?(?:said|discussed|talked about)|^about (?:that|this|it)\s*[.!?]*$)/i;

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
// Kept per listener as `pending` ({ threads, text, at }), see heardBy.
const CHOICE_WINDOW_MS = 90_000;

// The two names PAN offered, in the order it said them.
function offered(candidates, threads) {
  const pool = distinctThreads(threads);
  return candidates.slice(0, 2).map(c => pool.find(t => t.title === c.title)).filter(Boolean);
}

// The newest job this listener asked: nobody's "tell it ..." follows someone else's thread.
function lastJob(askedBy) {
  return get(`SELECT * FROM thread_relay_jobs WHERE asked_by IS :w ORDER BY created_at DESC LIMIT 1`, { ':w': askedBy });
}

// Returns null when the utterance is not about threads, else one of:
//   { kind: 'send', thread, text }  { kind: 'ambiguous', candidates }
//   { kind: 'unknown', name }       { kind: 'list' }  { kind: 'last', job }
//   { kind: 'no_relay' }            { kind: 'no_computer', machine }
// person: who is asking (null: the owner). A person's words are read against that person's own
// threads only. peek: read, but remember nothing (a look at what a line would mean to the owner).
export function parseThreadCommand(utterance, { person = null, peek = false } = {}) {
  const st = peek ? { list: heardBy(person).list, pending: heardBy(person).pending } : heardBy(person);
  const before = _st;
  _st = st;
  try {
    const whole = parseFor(utterance, person, st);
    if (whole) return whole;
    // A few words first, then the ask: "I'm stopped. Send another message to ..." (the car,
    // 2026-11-19). The forms above want the asking at the start of the line, so the line is read
    // again from its second sentence. Only after a short first one: a long line that mentions a
    // thread further on is namedAnywhere's to judge, above.
    const first = /^(?:\S+\s+){0,4}\S+[.!?]\s+(?=\S)/.exec(String(utterance || '').trim());
    return first ? parseFor(String(utterance).trim().slice(first[0].length), person, st) : null;
  } finally { _st = before; }
}

function parseFor(utterance, person, st) {
  const askedBy = person ? Number(person.id) || -1 : null;
  ensureThreadRelaySchema();
  const text = String(utterance || '').trim()
    // Only after a word that can't be part of a name: "tell the PAN thread one more thing" stays as said.
    .replace(new RegExp(`(?<=\\b(?:what's|whats|what is|did|on|in|to|tell|ask|is|about|from|with|of|check)\\s+)(thread|session|chat)\\s+(?:number\\s+|no\\.?\\s*|#\\s*)?(${NUMBER_RE})\\b`, 'gi'), 'number $2 $1');
  if (!text) return null;
  const threads = listThreads({ person });

  if (LIST.test(text) && /\b(?:claude|threads|sessions|open)\b/i.test(text)) {
    // His own, unless he names a person: "list Maria's threads".
    const { machines, people } = machinesFor(threads);
    const whose = people.find(w => new RegExp(`\\b${w}(?:['’]s|s['’])?\\b`, 'i').test(text));
    if (whose) {
      const theirs = threads.filter(t => t.host === machines[whose]);
      return { kind: 'list', threads: theirs, whose: theirs[0]?.owner_name || whose };
    }
    return { kind: 'list', threads: threads.filter(t => !t.theirs) };
  }

  for (const re of STATUS) {
    const m = re.exec(text);
    if (!m) continue;
    if (!threads.length) return { kind: 'no_relay' };
    const r = matchThread(m[1], threads);
    if (r.ok) return { kind: 'send', status: true, thread: r.thread, text: 'What is this thread doing right now?' };
    if (r.reason === 'ambiguous') {
      st.pending = { threads: offered(r.candidates, threads), text: 'What is this thread doing right now?', status: true, utterance: text, at: Date.now() };
      return { kind: 'ambiguous', candidates: r.candidates };
    }
    if (r.reason === 'no_number') return { kind: 'no_number', number: r.number };
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
    // "Wait, what did you just say?" in the car was read as a thread called "you just" and got
    // "I couldn't find a thread called you just." (Nov 16): the person may come with an adverb.
    const person = /^(?:i|you|we|he|she)(?:\s+(?:just|even|actually|really|guys|two|all))*$/i.test(name);
    const m = pronoun || person ? null : matchThread(name, threads);
    if (m?.ok) {
      const job = get(`SELECT * FROM thread_relay_jobs WHERE session_id = :s AND asked_by IS :w AND status IN ('replied','failed') ORDER BY created_at DESC LIMIT 1`, { ':s': m.thread.session_id, ':w': askedBy });
      // Never asked through the relay, or it has worked since: read where it is now (Nov 14).
      if (!job || (m.thread.last_activity || 0) > (job.created_at || 0) + 60_000) return { kind: 'send', status: true, thread: m.thread, text: 'What is this thread doing right now?' };
      return { kind: 'last', job };
    }
    // A real name that matched nothing: say so and name the closest, never another thread's reply.
    // "what did the buy plus animation thread say" got the newest ΠAN reply (Nov 14).
    const named = !pronoun && tokens(name).some(w => !FILLER.has(w));
    if (named && m && !m.ok) {
      if (m.reason === 'no_number') return { kind: 'no_number', number: m.number };
      if (m.reason === 'ambiguous') return { kind: 'ambiguous', candidates: m.candidates };
      return { kind: 'unknown', name, closest: m.candidates[0]?.score >= 0.2 ? m.candidates[0].title : null };
    }
    if (pronoun || anchored) {
      const job = get(`SELECT * FROM thread_relay_jobs WHERE asked_by IS :w AND status IN ('replied','failed') ORDER BY created_at DESC LIMIT 1`, { ':w': askedBy });
      if (job && (anchored || Date.now() - job.created_at < FOLLOWUP_WINDOW_MS)) return { kind: 'last', job };
      if (anchored) return { kind: 'last', job: null };
    }
  }

  if (st.pending && Date.now() - st.pending.at < CHOICE_WINDOW_MS && text.split(/\s+/).length <= 6) {
    // "two", "number two", "what's number two doing", "the second one" pick by place.
    const at = numberRef(text) ?? numberRef((/\bnumber\s+\S+|\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i.exec(text) || [])[0]);
    const r = at != null ? matchThread(`number ${at + 1}`, st.pending.threads, { ordered: true })
      : matchThread(text.replace(/\b(?:one|the|thread)\b/gi, ' '), st.pending.threads);
    if (r.ok) {
      const pending = st.pending; st.pending = null;
      return { kind: 'send', status: !!pending.status, thread: r.thread, text: pending.text, utterance: pending.utterance };
    }
  }

  const fu = FOLLOWUP.exec(text);
  if (fu) {
    const prev = lastJob(askedBy);
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
        st.pending = { threads: offered(r.candidates, threads), text: body, utterance: text, at: Date.now() };
      }
      return { kind: 'ambiguous', candidates: r.candidates };
    }
    if (r.reason === 'no_number') return { kind: 'no_number', number: r.number };
    return { kind: 'unknown', name: m[1] };
  }

  const computer = computerCommand(text, threads);
  if (computer) return computer;

  const named = namedAnywhere(text, threads);
  if (named?.ok) return { kind: 'send', thread: named.thread, text: text.replace(new RegExp(LEAD, 'i'), '').trim() };
  if (named) {
    st.pending = { threads: offered(named.candidates, threads), text, utterance: text, at: Date.now() };
    return { kind: 'ambiguous', candidates: named.candidates };
  }

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
  const st = heardBy(context.person || null);

  if (cmd.kind === 'list') {
    const listed = distinctThreads(cmd.threads).slice(0, 5);
    const whose = cmd.whose ? `${String(cmd.whose).split(/\s+/)[0]}'s` : 'Your';
    const say = listed.length
      ? `${whose} newest threads: ${listed.map((t, i) => `${['one', 'two', 'three', 'four', 'five'][i]}, ${shortTitle(t.title)}`).join('. ')}. Say a number to check on one.`
      : cmd.whose ? `${whose} computer has not reported any threads.` : `No relay has reported any threads yet.`;
    if (listed.length) {
      st.list = { threads: listed, at: Date.now() };
      st.pending = { threads: listed, text: 'What is this thread doing right now?', status: true, utterance, at: Date.now() };
    }
    yield { type: 'chunk', text: say }; yield done(say); return;
  }
  if (cmd.kind === 'no_number') {
    const n = st.list && Date.now() - st.list.at < LIST_WINDOW_MS ? st.list.threads.length : 0;
    const say = n ? `I only read out ${n}. Which one?` : `There's no thread number ${cmd.number}. Ask me to list your threads first.`;
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
    const say = `I couldn't find a thread called ${cmd.name}.` + (cmd.closest ? ` The closest is ${shortTitle(cmd.closest)}.` : '');
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
  const job = enqueueJob({ thread: cmd.thread, text: cmd.text, utterance: said, source: context.source || null, device_id: context.device_id || null, kind: cmd.status ? 'status' : 'send', convo,
    asked_by: context.person ? Number(context.person.id) : null });
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

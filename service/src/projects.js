// Projects (task 1097, the owner Nov 27): where his projects stand, for the voice. The smart model
// (the person's own terminal, smart-model-pick.js) reads what his memory holds and writes the
// notes in the background: per project a summary, one fact per line with its date, the questions
// he is likely to ask with their answers, and the words that mean it; across projects the two lists
// of who waits on him and who he waits on. Written for a small model to read: the lists are made
// here, never left to the reader.
//
// A voice turn reads them through projectTurn():
//   "who's waiting on me" / "who am I waiting on"  code says the list, no model (under a second)
//   a name from the notes, or a question close in meaning to one of the notes' own questions
//                                                   the smart model answers from the notes (about 6 s)
//   anything else                                   null: the usual path
// Bench (evals/projects, Nov 27): the live hub got 0 of 20 project questions right and made two up;
// Claude Sonnet from these notes 19 of 20 in 5.8 s, Codex 19 of 20 in 5.1 s. The hub's own model
// was 13 to 14 of 20 and needs a graphics card to be quick (13 s to 58 s on the hub's CPU).
//
// Owner only, nothing shared yet. Notes never hold his address, phone, email or account numbers.

import { all, get, run } from './db.js';
import { askAI } from './llm.js';
import { smartModel } from './smart-model-pick.js';
import { embedQuery, cosineSimilarity } from './memory/embeddings.js';
import { routeProject, focusNotes, NOT_NAMES, renderNotes, answerPrompt } from './project-focus.js';
export { renderNotes };

const EVERY_MS = 30 * 60 * 1000;     // look for new memory this often
const NEW_EVENTS = 15;               // and write again after this many new lines from him or his threads
const LINES = 260;                   // memory lines handed to the writer
const LINE_CHARS = 900;
const NAMES = 50;                    // recent names looked up in memory
const MEANING = 0.78;                // a question this close to one of the notes' questions is a project one
// Everyday questions scored up to 0.736 against the notes' questions ("what's on my calendar today",
// "what's my battery at"); project ones without a name 0.54 to 1.0 (sep_test.mjs, Nov 27).

let _ready = false;
function ensure() {
  if (_ready) return;
  run(`CREATE TABLE IF NOT EXISTS project_notes (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    obj TEXT NOT NULL,
    written_at TEXT NOT NULL,
    model TEXT,
    last_event_id INTEGER NOT NULL DEFAULT 0,
    took_ms INTEGER
  )`);
  _ready = true;
}

// The notes hold the questions' vectors (about a megabyte of JSON), so they are parsed once and kept;
// writing them drops the kept copy.
let _notes;   // undefined: not read yet
/** The notes as written, or null. The same object every turn: do not change it. */
export function projectNotes() {
  if (_notes !== undefined) return _notes;
  ensure();
  const r = get('SELECT obj, written_at, model FROM project_notes WHERE id = 1');
  try { _notes = r ? { ...JSON.parse(r.obj), written_at: r.written_at, model: r.model } : null; } catch { _notes = null; }
  return _notes;
}

// ── Gathering ──────────────────────────────────────────────────────────────────────────────────

function textOf(e) {
  let d = {}; try { d = JSON.parse(e.data); } catch { return ''; }
  if (e.event_type === 'Stop') return d.last_assistant_message || '';
  if (e.event_type === 'AssistantTurnText') return d.text || d.message || '';
  if (e.event_type === 'UserPromptSubmit') {
    const p = String(d.prompt || '');
    if (/<scheduled-task|<task-notification|<system-reminder|<command-name>/i.test(p) || p.length > 1500) return '';
    return p.replace(/<pasted_content\b[\s\S]*?<\/pasted_content>/gi, ' ');
  }
  return '';
}
const TYPES = `('Stop', 'UserPromptSubmit', 'AssistantTurnText')`;
const pause = () => new Promise((r) => setImmediate(r));

/** What his memory says lately: the best few lines under each recent name, then the newest lines. */
export async function gatherProjectLines({ days = 21 } = {}) {
  const since = new Date(Date.now() - days * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
  const names = new Set();
  try {
    for (const t of all(`SELECT name FROM memory_things WHERE last_seen >= :s AND mentions >= 2 ORDER BY mentions DESC LIMIT ${NAMES}`, { ':s': since })) names.add(t.name);
  } catch {}
  const old = projectNotes();
  for (const l of [...(old?.waiting_on_owner || []), ...(old?.owner_waiting_on || [])]) { const w = String(l).split(' (')[0].trim(); if (w) names.add(w); }
  for (const p of old?.projects || []) for (const w of p.words || []) names.add(w);

  const seen = new Map(), first = [];
  const keep = (e, must) => {
    if (seen.has(e.id)) return false;
    const t = textOf(e).replace(/\s+/g, ' ').trim();
    if (t.length < 40) return false;
    const row = { id: e.id, at: String(e.created_at).slice(0, 16), who: e.event_type === 'UserPromptSubmit' ? 'He typed' : 'His thread reported', t: t.slice(0, LINE_CHARS) };
    seen.set(e.id, row);
    if (must) first.push(row);
    return true;
  };
  // This runs in the hub's process, on the thread that answers his voice: small reads, a pause after each.
  for (const n of names) {
    const term = String(n).replace(/["*]/g, '').trim();
    if (term.length < 3) continue;
    let ids = [];
    try { ids = all(`SELECT rowid AS id FROM events_fts WHERE events_fts MATCH :m ORDER BY rowid DESC LIMIT 30`, { ':m': `"${term}"` }).map((r) => Number(r.id)).filter(Number.isFinite); } catch { continue; }
    if (ids.length) {
      // His own words carry his decisions ("don't ask Angell again until the battery is final"),
      // so under each name up to 3 of his lines AND up to 3 of his threads' reports.
      let typed = 0, told = 0;
      for (const e of all(`SELECT id, event_type, data, created_at FROM events WHERE id IN (${ids.join(',')}) AND event_type IN ${TYPES} AND created_at >= :s ORDER BY id DESC`, { ':s': since })) {
        const his = e.event_type === 'UserPromptSubmit';
        if (his ? typed >= 3 : told >= 3) continue;
        if (keep(e, true)) his ? typed++ : told++;
      }
    }
    await pause();
  }
  // His newest typed lines of the last few days, whatever name they carry: where his decisions are.
  const recent = new Date(Date.now() - 4 * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
  for (const e of all(`SELECT id, event_type, data, created_at FROM events WHERE event_type = 'UserPromptSubmit' AND created_at >= :s ORDER BY id DESC LIMIT 80`, { ':s': recent })) keep(e, true);
  for (const e of all(`SELECT id, event_type, data, created_at FROM events WHERE event_type = 'Stop' AND created_at >= :s ORDER BY id DESC LIMIT 120`, { ':s': since })) keep(e, false);
  const must = new Set(first.map((r) => r.id));
  const rest = [...seen.values()].filter((r) => !must.has(r.id)).sort((a, b) => (a.at < b.at ? 1 : -1));
  return [...first, ...rest].slice(0, LINES).sort((a, b) => (a.at < b.at ? 1 : -1));
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────

const WRITE = (lines, today, old = '') => `Today is ${today}. You keep the project notes for one person's voice assistant, ΠAN. A SMALL model may read these notes to answer out loud in about a second, so write them for it: it cannot add things up, compare dates or make lists itself, so do that work here.

Below is what their memory holds: their own typed words and what their assistants reported, newest first.

Reply with ONE JSON object: {"projects": [...], "waiting_on_owner": [...], "owner_waiting_on": [...]}
Each project (group the suppliers, parts and paperwork of one product under that product):
{"name": "...", "summary": "2 to 3 plain sentences: what it is and where it stands now",
 "words": ["names and words that mean this project in this person's life: people, companies, product and part names, and its own terms (e.g. LLC, trademark for a company's paperwork); never everyday words like battery, screen, phone, car, money, today"],
 "topics": ["the everyday nouns the owner uses for this project's own things, singular and plural (e.g. screens, screen, battery, batteries, camera, trademark, wire, quote)"],
 "facts": ["one fact per line, a full short sentence with names and exact numbers, ending with (as of <date>)"],
 "qa": [{"q": "a question the owner is likely to ask about it, in their words", "a": "the answer, one or two spoken sentences"}]}
"waiting_on_owner": one line per person or company waiting on the owner: "<who> (<company>, <part>) waits on you for <what>, since <date>; blocked by <what>".
"owner_waiting_on": one line per person or company the owner waits on: "<who> (<company>, <part>) owes you <what>, since <date>".
Rules: only what the notes show; the newest note wins when they disagree; keep every rule or decision the owner stated (e.g. "do not ask X again until Y") as a fact and follow it in the answers; every person or company in the notes appears somewhere; keep numbers exact (prices, part numbers, dates, amounts to pay and when); 6 to 12 qa per project; leave out games, code chores and things that are not one of the person's own projects. Never include the owner's address, phone number, email, passwords or account numbers. Reply with the JSON only.
${old ? `
The notes as they stand now (keep every detail that is still true, even when the memory lines below no longer mention it; change what the newer lines change; drop what is done or no longer true):
${old}
` : ''}
Memory lines:
${lines.map((e) => `[${e.at}] ${e.who}: ${e.t}`).join('\n')}`;

// The current notes for the writer, without the questions (the writer makes those again).
function oldForWriter(n) {
  if (!n?.projects?.length) return '';
  return renderNotes({ ...n, projects: n.projects.map((p) => ({ ...p, qa: [] })) }).slice(0, 40_000);
}

// Whatever the model writes, no email address and no long digit run (a phone or account number).
const scrub = (s) => String(s ?? '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '…')
  // A run that starts inside a word ("DTP103450 1800 mAh", a part number) or ends in a unit is not one.
  .replace(/(?<![\p{L}\p{N}])\+?\d[\d\s().-]{8,}\d/gu, (m, at, all) =>
    (m.replace(/\D/g, '').length >= 10 && !/^\s*(?:mAh|mA|mm|cm|Wh|V|W|pcs|units|pieces)\b/.test(all.slice(at + m.length)) ? '…' : m));
const strs = (v, n, len) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => scrub(x).slice(0, len)).filter(Boolean);

export function cleanNotes(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { o = JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
  }
  if (!o || !Array.isArray(o.projects)) return null;
  return {
    projects: o.projects.slice(0, 20).map((p) => ({
      name: scrub(p?.name).slice(0, 80),
      summary: scrub(p?.summary).slice(0, 600),
      words: strs(p?.words, 20, 60),
      topics: strs(p?.topics, 20, 40).map((x) => x.toLowerCase()),
      facts: strs(p?.facts, 40, 300),
      qa: (Array.isArray(p?.qa) ? p.qa : []).slice(0, 14).map((x) => ({ q: scrub(x?.q).slice(0, 200), a: scrub(x?.a).slice(0, 400) })).filter((x) => x.q && x.a),
    })).filter((p) => p.name),
    waiting_on_owner: strs(o.waiting_on_owner, 30, 300),
    owner_waiting_on: strs(o.owner_waiting_on, 30, 300),
  };
}

/** Notes given whole (a test, or the person's own edit later): cleaned, questions embedded, kept. */
export async function setProjectNotes(obj) {
  ensure();
  const notes = cleanNotes(obj);
  if (!notes || !notes.projects.length) return null;
  await embedQuestions(notes);
  run(`INSERT OR REPLACE INTO project_notes (id, obj, written_at, model, last_event_id, took_ms) VALUES (1, :o, datetime('now','localtime'), 'given', COALESCE((SELECT last_event_id FROM project_notes WHERE id = 1), 0), 0)`,
    { ':o': JSON.stringify(notes) });
  _vectors = null; _notes = undefined;
  return notes;
}

// A word he says to ΠAN often is not a sign of a project question: the first notes on the hub
// had "hub", "Work", "G16", "voice", "question" as names and topics, and 14 of his 505 real lines
// of Nov 17 to 27 would have gone to the project path. A word in at least 1 of 250 of his voice
// lines (last 30 days) is dropped from words and topics.
function dropEveryday(notes) {
  let lines = [];
  try {
    lines = all(`SELECT data FROM events WHERE event_type = 'RouterCommand' AND created_at >= datetime('now','localtime','-30 days') ORDER BY id DESC LIMIT 4000`)
      .map((r) => { try { return String(JSON.parse(r.data).text || '').toLowerCase(); } catch { return ''; } }).filter(Boolean);
  } catch {}
  if (lines.length < 200) return;
  const cache = new Map();
  const everyday = (w) => {
    const k = String(w).toLowerCase().trim();
    if (!cache.has(k)) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
      cache.set(k, lines.filter((l) => re.test(l)).length / lines.length >= 0.004);
    }
    return cache.get(k);
  };
  let dropped = [];
  for (const p of notes.projects) {
    const keepW = (w) => { const e = everyday(w) || NOT_NAMES.has(String(w).toLowerCase()); if (e) dropped.push(w); return !e; };
    p.words = p.words.filter(keepW);
    p.topics = (p.topics || []).filter(keepW);
    p.everyday = String(p.name).split(/[^\p{L}\p{N}]+/u).filter((w) => w && everyday(w));
  }
  if (dropped.length) console.log(`[projects] everyday words left out of the matching: ${[...new Set(dropped)].join(', ')}`);
}

let _writing = null;
/** Write the notes now (the smart model, one call). Resolves with the notes, or null. */
export function writeProjectNotes({ reason = 'due' } = {}) {
  if (_writing) return _writing;
  _writing = (async () => {
    ensure();
    const t0 = Date.now();
    const lines = await gatherProjectLines();
    if (lines.length < 5) return null;
    const lastId = Math.max(...lines.map((l) => l.id));
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const model = smartModel();
    const raw = await askAI(WRITE(lines, today, oldForWriter(projectNotes())), { model, timeout: 400_000, maxTokens: 16000, caller: 'projects', _skipAnonymize: true });
    const notes = cleanNotes(raw);
    if (!notes || !notes.projects.length) { console.warn(`[projects] ${model} gave no usable notes (${String(raw).slice(0, 120)})`); return null; }
    dropEveryday(notes);
    await embedQuestions(notes);
    run(`INSERT OR REPLACE INTO project_notes (id, obj, written_at, model, last_event_id, took_ms) VALUES (1, :o, datetime('now','localtime'), :m, :l, :t)`,
      { ':o': JSON.stringify(notes), ':m': model, ':l': lastId, ':t': Date.now() - t0 });
    _vectors = null; _notes = undefined;
    console.log(`[projects] notes written by ${model} (${reason}): ${notes.projects.length} projects, ${notes.waiting_on_owner.length} waiting on him, he waits on ${notes.owner_waiting_on.length}, from ${lines.length} lines in ${Math.round((Date.now() - t0) / 1000)} s`);
    return notes;
  })().catch((e) => { console.warn('[projects] writing failed:', e.message); return null; }).finally(() => { _writing = null; });
  return _writing;
}

// The notes' own questions, embedded once per writing, so a turn needs only its own embedding.
let _vectors = null;   // [{ v, project }]
async function embedQuestions(notes) {
  const out = [];
  for (const p of notes.projects) for (const x of p.qa) {
    const v = await embedQuery(x.q, 3000);
    if (v) out.push({ v: Array.from(v), project: p.name });
  }
  notes.qv = out;
}
function vectors() {
  if (_vectors) return _vectors;
  const n = projectNotes();
  _vectors = (n?.qv || []).map((x) => ({ v: x.v, project: x.project }));
  return _vectors;
}

/** Due when enough new lines from him or his threads came in since the notes were written. */
export function projectsDue() {
  ensure();
  const r = get('SELECT last_event_id FROM project_notes WHERE id = 1');
  const since = r ? r.last_event_id : 0;
  const n = get(`SELECT COUNT(*) AS n FROM events WHERE id > :i AND event_type IN ('Stop', 'UserPromptSubmit')`, { ':i': since })?.n || 0;
  return n >= NEW_EVENTS;
}

let _timer = null;
/** The background writer: every 30 minutes, when enough is new and nobody spoke to ΠAN lately. */
// Quiet: no line to ΠAN by voice in the last 3 minutes (the writer's Claude call is light on the hub,
// but the evidence reads share the thread that answers his voice).
function voiceQuiet() {
  try { return !get(`SELECT 1 FROM events WHERE event_type = 'RouterCommand' AND created_at >= datetime('now','localtime','-3 minutes') LIMIT 1`); } catch { return true; }
}
export function startProjectsWatch({ quiet = voiceQuiet } = {}) {
  if (_timer) return;
  const tick = () => { try { if (quiet() && projectsDue()) writeProjectNotes({ reason: 'new memory' }); } catch (e) { console.warn('[projects] watch:', e.message); } };
  setTimeout(tick, 5 * 60 * 1000);
  _timer = setInterval(tick, EVERY_MS);
  _timer.unref?.();
}

// ── Reading, per voice turn ────────────────────────────────────────────────────────────────────

function whoOf(line) { return String(line).split(' (')[0].trim(); }
function sayList(names, end) {
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${end}`;
}

// Best score per project of the line against the notes' own questions (meaning, project-focus.js).
async function meaningScores(text) {
  const vs = vectors();
  if (!vs.length) return null;
  const v = await embedQuery(text, 1200);
  if (!v) return null;
  const q = Array.from(v);
  const best = new Map();
  for (const x of vs) { const s = cosineSimilarity(q, x.v); if (s > (best.get(x.project) ?? -1)) best.set(x.project, s); }
  return [...best].map(([project, score]) => ({ project, score }));
}

/**
 * What a voice turn should do with project notes. null: not a project question (or no notes).
 * { say }: answer with these words, no model. { ask, why, scope }: the smart model answers with this
 * prompt, which holds only the project the line is about when one matches (project-focus.js).
 */
export async function projectTurn(text) {
  const t = String(text || '').trim();
  const notes = projectNotes();
  if (!notes || !notes.projects?.length) return null;
  const r = await routeProject(notes, t, { meaning: meaningScores, MEANING });
  if (!r) return null;
  if (r.list === 'waiting_on_you') {
    const say = sayList(notes.waiting_on_owner.map(whoOf), notes.waiting_on_owner.length === 1 ? 'is waiting on you.' : 'are waiting on you.');
    return say ? { say: `${say} Ask about any of them for what they need.`, why: 'list_waiting_on_you' } : null;
  }
  if (r.list === 'you_wait_on') {
    const say = sayList(notes.owner_waiting_on.map(whoOf), 'owe you something.');
    return say ? { say: `You're waiting on ${say.replace(/ owe you something\.$/, '')}.`, why: 'list_you_wait_on' } : null;
  }
  const f = focusNotes(notes, t, r);
  return { ask: answerPrompt(f.notes, t, notes.written_at), why: r.why, scope: f.scope };
}

/**
 * The model that answers project questions. On a Claude login that is Claude Haiku 5.5: on the made
 * up twin of the bench it got 20 of 20 with the first word in 0.67 s (Sonnet 19 of 20, about 6 s);
 * the same login, so nothing changes about who sees what. Any other smart model answers itself.
 */
export function projectAnswerModel() {
  const m = smartModel();
  return m.startsWith('anthropic:') ? 'anthropic:claude-haiku-5-5' : m;
}

/** The answer as it is spoken, or null when the model says the question is not a project one. */
export function projectReply(raw) {
  if (/NOT_?PROJECT/i.test(String(raw || ''))) return null;
  const t = String(raw || '').replace(/[*_#`>]+/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // A sentence ends at . ! or ? followed by a space: "$1.85" and "0.5.62" stay whole.
  return t.split(/(?<=[.!?]["')\]]?)\s+/).slice(0, 4).join(' ');
}


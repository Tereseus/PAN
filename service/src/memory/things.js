// Things: one short record per thing he keeps coming back to (a project, a person, a place, a
// device), written in the background from his own words and what his threads did, and kept up to
// date as more comes in. The voice reads these through the shelf (intuition/shelf.js): when a
// thing's name goes by in the talk, its record is ready before he asks.
//
// Why not the semantic facts: consolidation filed 9,926 of them by 2026-11-23, 6,352 as "his
// preferences", most of them scraps of scheduled job prompts or of 300 character clips
// (half sentences cut out of his talk). No fact said what his main projects are, and
// by meaning a relevant fact scored 0.67 against 0.60 for an unrelated one, so nothing could be
// picked safely. A record per thing, found by its name, does not have that problem.
//
// What counts as his words: a typed prompt that is not a scheduled job's prompt
// (`<scheduled-task ...>`), with pasted text taken out, and not longer than a person types.
import { all, get, run, insert } from '../db.js';
import { askAIStream } from '../claude.js';
import { embed, toBlob } from './embeddings.js';

const MAX_TYPED = 1500;          // longer than this is a pasted document or a job, not him typing
const MIN_MENTIONS = 1;          // a name is understood the first time it shows up in his words
const MORE = 3;                  // and its note is updated after this many new mentions
const EVIDENCE = 24;             // snippets handed to the model per record
const SNIPPET = 360;             // characters per snippet, centred on the name
const WATCH_MS = 3 * 60 * 1000;  // how often the watch reads new events
const QUIET_MS = 3 * 60 * 1000;  // a note is written only when nobody talked to PAN for this long

let _ready = false;
export function ensureThings() {
  if (_ready) return;
  run(`CREATE TABLE IF NOT EXISTS memory_things (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    norm        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '[]',
    kind        TEXT,
    record      TEXT,
    mentions    INTEGER NOT NULL DEFAULT 0,
    plain       INTEGER NOT NULL DEFAULT 0,
    first_seen  TEXT,
    last_seen   TEXT,
    written_at  TEXT,
    written_mentions INTEGER NOT NULL DEFAULT 0,
    embedding   BLOB
  )`);
  // Added after the table (2026-11-23): asked_at, when he last asked PAN about it by voice; obj,
  // the note as an object (renderThing makes `record` from it); importance and private from it.
  for (const col of ['asked_at TEXT', 'obj TEXT', 'importance REAL', 'private INTEGER NOT NULL DEFAULT 0']) {
    try {
      run(`ALTER TABLE memory_things ADD COLUMN ${col}`);
      // The first notes were prose: the watch writes them again as objects, best known first.
      if (col.startsWith('obj ')) run(`UPDATE memory_things SET written_at = NULL WHERE record IS NOT NULL`);
    } catch {}
  }
  _ready = true;
}

/** Lower case letters only, doubled letters made single: "Ellipsis" and "Elipsis" are the same. */
export function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/(\p{L})\1+/gu, '$1').replace(/\s+/g, ' ').trim();
}

/** His own typed words from a prompt, or '' when the prompt is a job's or a paste. */
export function hisWords(prompt) {
  let p = String(prompt || '');
  if (/<scheduled-task\b|<command-name>|<local-command|<task-notification|<system-reminder/i.test(p)) return '';
  p = p.replace(/<pasted_content\b[\s\S]*?<\/pasted_content>/gi, ' ').replace(/<[^>]{1,80}>/g, ' ').trim();
  return p.length > MAX_TYPED ? '' : p;
}

/** The project folder a thread ran in, as a name: "/home/x/Autokratia" -> "Autokratia". */
export function projectOf(cwd) {
  const base = String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  if (!base || /^(desktop|home|tmp|scratch|users?|c:|documents|downloads)$/i.test(base) || base.length < 3) return '';
  return base;
}

// Words that start sentences or are everywhere in his talk: never a thing on their own.
const NOT_THINGS = new Set(['i', 'ok', 'okay', 'yes', 'no', 'yeah', 'so', 'and', 'but', 'the', 'a', 'it', 'is', 'that', 'this',
  'what', 'why', 'how', 'when', 'where', 'who', 'can', 'do', 'does', 'did', 'well', 'now', 'then', 'also', 'just', 'like',
  'claude', 'pan', 'please', 'thanks', 'hi', 'hey', 'oh', 'wow', 'alright', 'sure', 'go', 'let', 'make', 'check', 'look',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'yesterday']);

/** Capitalised names in a line, not counting the first word of a sentence. */
export function namesIn(text) {
  const out = new Set();
  const sentences = String(text || '').split(/(?<=[.!?])\s+|\n+/);
  for (const s of sentences) {
    const words = s.split(/\s+/).filter(Boolean);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (!/^\p{Lu}[\p{L}\p{N}]{2,}/u.test(w) || NOT_THINGS.has(w.toLowerCase())) continue;
      let run = [w];
      while (i + 1 < words.length) {
        // "War of Eternity": a small joining word between two capitalised ones stays in the name
        if (/^(of|the|de|da|van|von)$/.test(words[i + 1]) && i + 2 < words.length && /^\p{Lu}/u.test(words[i + 2]) && !/[.,;:!?]$/.test(words[i])) {
          run.push(words[++i]); continue;
        }
        const nx = words[i + 1].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (!/^\p{Lu}[\p{L}\p{N}]+/u.test(nx) || NOT_THINGS.has(nx.toLowerCase())) break;
        run.push(nx); i++;
      }
      out.add(run.join(' '));
    }
  }
  return [...out];
}

/**
 * Count names in a batch of events (the consolidation window) and add them to memory_things.
 * His typed words and the project folders count; scheduled jobs and pastes do not. A name in a
 * line he said to PAN counts too, and puts that thing first in line for a note: he asked what it
 * is (a question about one of his own names got "I don't know what that is", 2026-11-23).
 */
export function noteMentions(events) {
  ensureThings();
  const seen = new Map();   // norm -> { name, n, at }
  const typed = [];
  const asked = new Set();
  const add = (name, at, n = 1) => {
    const norm = normName(name);
    if (!norm || norm.length < 3 || NOT_THINGS.has(norm) || /[._\/]|^scratch|\d{4}-\d{2}/i.test(name)) return;
    const e = seen.get(norm) || { name, n: 0, at };
    e.n += n; if (at > e.at) e.at = at;
    seen.set(norm, e);
  };
  for (const e of events) {
    if (e.event_type === 'RouterCommand') {
      let d = {}; try { d = JSON.parse(e.data); } catch { continue; }
      if (/-bench$/.test(String(d.device_id || '')) || (d.addressed != null && Number(d.addressed) < 0.5)) continue;
      for (const n of namesIn(d.text)) { add(n, e.created_at); asked.add(normName(n)); }
      continue;
    }
    if (e.event_type !== 'UserPromptSubmit') continue;
    let d = {}; try { d = JSON.parse(e.data); } catch { continue; }
    const words = hisWords(d.prompt);
    if (!words) continue;
    typed.push(words);
    for (const n of namesIn(words)) add(n, e.created_at);
    const proj = projectOf(d.cwd);
    if (proj) add(proj, e.created_at, 0.25);   // four prompts in a folder count as one mention
  }
  // A common word he capitalised at times ("Camera", "Dev") is written in lower case far more often.
  // Count the lower case uses too; a thing needs more capitalised mentions than plain ones.
  const lower = new Map();   // every all lower case word he typed in this batch -> count
  for (const w of typed.join('\n').split(/[^\p{L}\p{N}]+/u)) if (w && w === w.toLowerCase()) lower.set(w, (lower.get(w) || 0) + 1);
  for (const [norm, s] of seen) {
    const word = String(s.name).split(' ')[0];
    const plain = /^\p{L}+$/u.test(word) ? (lower.get(word.toLowerCase()) || 0) : 0;
    const ex = get(`SELECT id, mentions FROM memory_things WHERE norm = :n`, { ':n': norm });
    if (ex) run(`UPDATE memory_things SET mentions = mentions + :k, plain = plain + :p, last_seen = :t WHERE id = :id`, { ':k': Math.ceil(s.n), ':p': plain, ':t': s.at, ':id': ex.id });
    else insert(`INSERT OR IGNORE INTO memory_things (name, norm, mentions, plain, first_seen, last_seen) VALUES (:name, :n, :k, :p, :t, :t)`,
      { ':name': s.name, ':n': norm, ':k': Math.ceil(s.n), ':p': plain, ':t': s.at });
    if (asked.has(norm)) run(`UPDATE memory_things SET asked_at = datetime('now','localtime'),
      written_at = CASE WHEN record IS NULL THEN NULL ELSE written_at END WHERE norm = :n`, { ':n': norm });
  }
  return seen.size;
}

function clipAround(text, needles, len = SNIPPET) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const low = t.toLowerCase();
  let at = -1;
  for (const n of needles) { at = low.indexOf(n); if (at >= 0) break; }
  if (at < 0) return t.slice(0, len);
  const start = Math.max(0, at - Math.floor(len / 3));
  return (start > 0 ? '...' : '') + t.slice(start, start + len) + (start + len < t.length ? '...' : '');
}

/**
 * What his memory says about a name: his own lines and what his threads reported, newest first.
 * Uses the full text index (events_fts), so any spelling the index holds is found.
 */
export async function gatherEvidence(name, aliases = [], { limit = EVIDENCE } = {}) {
  const terms = [name, ...aliases].map((s) => String(s).replace(/["*]/g, '').trim()).filter(Boolean);
  // "Ellipsis" in speech, "Elipsis" typed: search both spellings of every doubled letter.
  const variants = new Set();
  for (const t of terms) {
    const single = t.replace(/(\p{L})\1+/gu, '$1');
    variants.add(t); variants.add(single);
    // each consonant doubled in turn, for one word names only (a few FTS phrases, not dozens)
    if (!/\s/.test(single)) for (let i = 1; i < single.length; i++) if (/\p{L}/u.test(single[i]) && !/[aeiouy]/i.test(single[i])) variants.add(single.slice(0, i) + single[i] + single.slice(i));
  }
  const match = [...variants].filter((v) => v.length >= 3).map((v) => `"${v}"`).join(' OR ');
  if (!match) return { first: [], later: [] };
  const needles = [...variants].map((v) => v.toLowerCase());
  // The first mentions say what a thing is (that is where he explains it); the newest say where it
  // stands. Both, so a name with thousands of mentions of thread chatter ("WoE") is still read
  // from where he first said what it is.
  // This runs in the PAN process, on the thread that answers his voice. Joined with events and
  // sorted, one query took 7.6 s and blocked the hub for 15 s (2026-11-23, a turn from his phone
  // went unanswered). The index alone gives the matches in id order in about 10 ms; their events
  // are then read 100 at a time, with a pause after each batch so a turn can get in.
  const ids = (order, lim) => all(`SELECT rowid AS id FROM events_fts WHERE events_fts MATCH :m ORDER BY rowid ${order} LIMIT ${lim}`, { ':m': match }).map((r) => r.id);
  const read = async (list, want, asc) => {
    const out = [];
    for (let i = 0; i < list.length && out.length < want; i += 100) {
      const chunk = list.slice(i, i + 100).map(Number).filter(Number.isFinite);
      if (chunk.length) out.push(...all(`SELECT id, event_type, data, created_at FROM events WHERE id IN (${chunk.join(',')})
        AND event_type IN ('UserPromptSubmit', 'Stop', 'RouterCommand')`).sort((a, b) => (asc ? a.id - b.id : b.id - a.id)));
      await new Promise((r) => setImmediate(r));
    }
    return out;
  };
  let firstRows = [], rows = [];
  try { firstRows = await read(ids('ASC', 400), 150, true); rows = await read(ids('DESC', 3000), 1500, false); } catch (err) {
    console.warn('[things] evidence search failed:', err.message);
    return { first: [], later: [] };
  }
  // A line that says what it is ("Elipsis is ...") scores first, then his own words.
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const defines = new RegExp(`(${needles.map(esc).join('|')})[\\s"'*)]{0,3}( is | was | are | means|=|:|, a |, an |, the | \\(| -)`, 'i');
  const seenText = new Set();
  const pick = (list) => {
    const picked = [];
    for (const r of list) {
      let d = {}; try { d = JSON.parse(r.data); } catch { continue; }
      let text = '', who = '';
      if (r.event_type === 'UserPromptSubmit') { text = hisWords(d.prompt); who = 'He typed'; }
      else if (r.event_type === 'Stop') { text = d.last_assistant_message || ''; who = 'His thread reported'; }
      else if (r.event_type === 'RouterCommand') { text = d.text || ''; who = 'He said'; }
      if (!text || !needles.some((n) => text.toLowerCase().includes(n))) continue;
      const clip = clipAround(text, needles);
      const key = clip.slice(0, 80);
      if (seenText.has(key)) continue;
      seenText.add(key);
      const score = (defines.test(clip) ? 3 : 0) + (who === 'He typed' ? 1 : 0) + (clip.length > 150 ? 0.5 : 0);
      picked.push({ id: r.id, at: String(r.created_at), score, line: `[${String(r.created_at).slice(0, 10)}] ${who}: ${clip}` });
    }
    return picked;
  };
  const FIRST = Math.ceil(limit / 3);
  const first = pick(firstRows).slice(0, 40).sort((x, y) => y.score - x.score).slice(0, FIRST).sort((a, b) => a.id - b.id);
  const firstIds = new Set(first.map((p) => p.id));
  const later = pick(rows.filter((r) => !firstIds.has(r.id)));
  // The rest spread over up to six stretches of time, best first in each, so a busy week of talk
  // ABOUT the thing does not crowd out the rest.
  const out = [];
  if (later.length) {
    const B = Math.min(6, later.length);
    const buckets = Array.from({ length: B }, () => []);
    later.forEach((p, i) => buckets[Math.floor(i * B / later.length)].push(p));   // newest first
    for (const b of buckets) b.sort((x, y) => y.score - x.score);
    for (let k = 0; out.length < limit - first.length && buckets.some((b) => k < b.length); k++)
      for (const b of buckets) if (k < b.length && out.length < limit - first.length) out.push(b[k]);
  }
  out.sort((a, b) => b.id - a.id);
  return { first: first.map((p) => p.line), later: out.map((p) => p.line) };
}

// ── The note: one object per thing, the same keys for anyone ────────────────────────────
// Checked against very different lives (2026-11-23): an electrician's panel job, a carer with an
// elderly parent, a parent's schedules, a trucker, a shop, a student, a trip, a person. Code work
// is one case of it, not the shape. Questions read single keys ("who's our contact there" is
// `who`, "how's it going" is `state`), and prompts get short key: value lines, not prose.
export const KINDS = ['person', 'organization', 'group', 'job', 'project', 'place', 'object', 'event', 'conversation', 'app', 'other'];

const RECORD_PROMPT = (name, notes, old, owner) => `You keep PAN's notes on the things in one person's life${owner ? ` (the owner, ${owner})` : ''}. PAN is their voice assistant. The notes below are the owner's own words and what their assistants reported doing for them.

Fill in the note on "${name}" as ONE JSON object, from the notes only. Leave out every key the notes do not show. Never guess, never add general knowledge. Never put the owner in "who". Never write the owner's own address, phone number, email, passwords or account numbers anywhere in the note. Write every value as a few words of your own, never a copied passage.
{
 "name": "${name}",
 "aliases": ["other names or spellings used in the notes"],
 "kind": "one of: ${KINDS.join(', ')}",
 "what": "what it is to the owner, one short line",
 "role": "the owner's relation to it",
 "who": [{"name": "a person or company", "role": "their part in it", "reach": "how to reach them, only if the notes say"}],
 "where": "place, site or room",
 "when": [{"what": "...", "at": "date or time", "repeats": "only if it repeats"}],
 "state": "where it stands now, one short line",
 "as_of": "the date of the latest note that shows that state",
 "next": [{"what": "what is still open", "on": "who or what it waits on"}],
 "needs": ["parts, tools or materials it needs"],
 "facts": {"a detail": "its value"},
 "reach": ["channels to act on it: a thread, an email, a phone number"],
 "links": ["names of related things"],
 "private": true when it is about health, money or anything not to read out with other people around,
 "importance": 0 to 1, how much it matters to the owner now
}
"what" comes from how it first came up; "state", "as_of" and "next" from the latest notes.
If the notes do not show what it is, reply with only: UNKNOWN
If "${name}" is only a public topic the owner talked about (a country, a team, a brand, a news story) with no part in the owner's own life (no plan, person, work, purchase or trip of theirs tied to it), reply with only: PUBLIC
${old ? `\nThe current note (keep what is still true, update the rest):\n${JSON.stringify(old)}\n` : ''}
How it first came up, oldest first:
${notes.first.join('\n') || '(none)'}

Since then, newest first:
${notes.later.join('\n') || '(none)'}

The JSON note on "${name}":`;

// The owner's name (setting display_name), so the model leaves the owner out of "who".
function ownerName() {
  try { return String(get(`SELECT value FROM settings WHERE key = 'display_name'`)?.value || '').replace(/^"|"$/g, '').trim(); } catch { return ''; }
}
// Details of the owner's own that never go in a note, whatever the model writes: notes reach prompts,
// and a prompt can go to a cloud model. The PCBWay note copied his delivery address and phone into
// its facts (2026-11-23).
const OWN_DETAIL_KEY = /address|phone|mobile|email|password|passcode|pin\b|card|iban|account|bank|ssn|passport|login/i;
// A phone number has 10+ digits in one run; a date (2026-11-23) or a size (67.5 x 64) does not.
const looksPrivate = (v) => /[\w.+-]+@[\w-]+\.[\w.]+|\[EMAIL-REDACTED\]/.test(v)
  || (String(v).match(/\+?\d[\d\s().-]{8,}\d/g) || []).some((m) => m.replace(/\D/g, '').length >= 10);
const oldObj = (thing) => { try { return thing.obj ? JSON.parse(thing.obj) : null; } catch { return null; } };
// Filler the model writes for a key it should have left out ("where: Not specified") is no value.
const FILLER = /^(?:not specified|unspecified|not stated|not mentioned|unknown|none|n\/a|null|no note yet\b.*|nothing yet)\.?$/i;
const cut = (v, n) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); if (FILLER.test(t)) return ''; return t.length > n ? t.slice(0, n - 3).replace(/\s+\S*$/, '') + '...' : t; };
const list = (v, n) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).slice(0, n);
const dropEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

/** The model's reply made into a clean note object, or null. Unknown keys are dropped. */
export function cleanThing(raw, name, evidence = '') {
  let o = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (/^UNKNOWN\b/i.test(t)) return null;
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    const body = t.slice(a, b + 1);
    try { o = JSON.parse(body); } catch {
      try { o = JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
    }
  }
  if (!o || typeof o !== 'object') return null;
  const out = { name: cut(name || o.name, 80) };
  const owner = ownerName().toLowerCase();
  const what = cut(o.what, 200);
  if (!what || /^unknown$/i.test(what)) return null;
  const aliases = list(o.aliases, 6).map((x) => cut(x, 60)).filter((x) => x && x.toLowerCase() !== out.name.toLowerCase());
  if (aliases.length) out.aliases = aliases;
  out.kind = KINDS.includes(String(o.kind || '').toLowerCase()) ? String(o.kind).toLowerCase() : 'other';
  out.what = what;
  // A value copied word for word out of the evidence is a pasted passage, not the model's summary:
  // the PCBWay note's state was a line of an assistant's chat reply (2026-11-23).
  // Compared as letters and digits only, so markdown the model stripped ("**Website:**") still matches.
  const bare = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const ev = bare(evidence);
  const copied = (v) => { const t = bare(String(v).replace(/\.\.\.$/, '')); return ev && t.length >= 40 && ev.includes(t.slice(0, 40)); };
  for (const k of ['role', 'where', 'state', 'as_of']) { const v = cut(o[k], 120); if (v && !looksPrivate(v) && !copied(v)) out[k] = v; }
  const who = list(o.who, 6).map((w) => (typeof w === 'string' ? { name: cut(w, 60) } : dropEmpty({ name: cut(w?.name, 60), role: cut(w?.role, 80), reach: cut(w?.reach, 100) }))).filter((w) => w.name);
  if (who.length) out.who = who;
  const when = list(o.when, 6).map((w) => (typeof w === 'string' ? { what: cut(w, 100) } : dropEmpty({ what: cut(w?.what, 100), at: cut(w?.at, 60), repeats: cut(w?.repeats, 60) }))).filter((w) => w.what || w.at);
  if (when.length) out.when = when;
  const next = list(o.next, 6).map((w) => (typeof w === 'string' ? { what: cut(w, 120) } : dropEmpty({ what: cut(w?.what, 120), on: cut(w?.on, 80) }))).filter((w) => w.what);
  if (next.length) out.next = next;
  for (const k of ['needs', 'reach', 'links']) {
    const v = list(o[k], k === 'needs' ? 10 : 8).map((x) => cut(typeof x === 'object' ? JSON.stringify(x) : x, 100)).filter((x) => x && !/^[\w\s]*:?\s*\[EMAIL-REDACTED\]$/i.test(x));
    if (v.length) out[k] = v;
  }
  if (out.who && owner) out.who = out.who.filter((w) => !owner.split(/\s+/).some((part) => part.length > 2 && w.name.toLowerCase().includes(part)));
  if (out.who && !out.who.length) delete out.who;
  if (o.facts && typeof o.facts === 'object' && !Array.isArray(o.facts)) {
    for (const k of Object.keys(o.facts)) if (OWN_DETAIL_KEY.test(k) || looksPrivate(String(o.facts[k]))) delete o.facts[k];
    const f = Object.entries(o.facts).slice(0, 12).map(([k, v]) => [cut(k, 40), cut(typeof v === 'object' ? JSON.stringify(v) : v, 100)]).filter(([k, v]) => k && v);
    if (f.length) out.facts = Object.fromEntries(f);
  }
  if (o.private === true || /^(true|yes)$/i.test(String(o.private))) out.private = true;
  const imp = Number(o.importance);
  out.importance = Number.isFinite(imp) ? Math.max(0, Math.min(1, imp)) : 0.5;
  return out;
}

/**
 * The note as short key: value lines for a prompt. `keys` picks fields (default all); the name,
 * kind and what always lead.
 */
export function renderThing(o, keys = null) {
  if (!o) return '';
  const want = (k) => !keys || keys.includes(k);
  const parts = [`${o.name} (${o.kind || 'other'}): ${o.what}`];
  if (o.aliases?.length && want('aliases')) parts.push(`also called: ${o.aliases.join(', ')}`);
  if (o.role && want('role')) parts.push(`role: ${o.role}`);
  if (o.who?.length && want('who')) parts.push(`who: ${o.who.map((w) => [w.name, w.role && `(${w.role})`, w.reach && `via ${w.reach}`].filter(Boolean).join(' ')).join('; ')}`);
  if (o.where && want('where')) parts.push(`where: ${o.where}`);
  if (o.when?.length && want('when')) parts.push(`when: ${o.when.map((w) => [w.what, w.at, w.repeats && `(${w.repeats})`].filter(Boolean).join(' ')).join('; ')}`);
  if (o.state && want('state')) parts.push(`state: ${o.state}${o.as_of ? ` (as of ${o.as_of})` : ''}`);
  if (o.next?.length && want('next')) parts.push(`next: ${o.next.map((w) => w.what + (w.on ? ` (waiting on ${w.on})` : '')).join('; ')}`);
  if (o.needs?.length && want('needs')) parts.push(`needs: ${o.needs.join(', ')}`);
  if (o.facts && want('facts')) parts.push(`facts: ${Object.entries(o.facts).map(([k, v]) => `${k} ${v}`).join('; ')}`);
  if (o.reach?.length && want('reach')) parts.push(`reach: ${o.reach.join(', ')}`);
  if (o.links?.length && want('links')) parts.push(`links: ${o.links.join(', ')}`);
  return parts.join('\n  ');
}

// The model that writes records: job_models 'memory-things' if he set one, else gemma4:e4b on the
// hub's own Ollama. gemma4:e2b (the consolidation default) wrote "PCBWay is where the reply to the
// sheet is in your Gmail" from good notes (2026-11-23).
function recordModel() {
  try { const m = JSON.parse(get(`SELECT value FROM settings WHERE key = 'job_models'`)?.value || '{}')['memory-things']; if (m) return m; } catch {}
  return 'ollama:gemma4:e4b';
}

// A note takes about a minute of the hub's CPU, the same CPU his voice turns run on. Any line heard
// (pauseForTalk, from routeStream) stops the note being written and holds the next one off for
// QUIET_MS; the stopped note stays due and is written later.
let _writing = null;
let _quietUntil = 0;
export function pauseForTalk() {
  _quietUntil = Date.now() + QUIET_MS;
  if (_writing) { try { _writing.abort(); } catch {} }
}

/** True when the note shows a public topic he only talked about, not a thing in his own life. */
async function onlyATopic(obj) {
  const q = `A note PAN wrote from one person's own words:\n${renderThing(obj)}\n\nIs "${obj.name}" part of this person's own life (their plan, work, purchase, trip, people, home or belongings), or only a public topic they talked about (a country, a region, a team, a brand, a news story)? Something they use, build, buy, or work on or with is MINE, even when it is well known (an operating system they develop for, a shop they order from).\nAnswer with one word, MINE or TOPIC:`;
  let a = '';
  try {
    for await (const c of askAIStream(q, { model: recordModel(), maxTokens: 4, timeout: 60000, caller: 'memory-things', temperature: 0 })) a += typeof c === 'string' ? c : (c?.text || '');
  } catch { return false; }
  return /^\W*TOPIC\b/i.test(a.trim());
}

/** Write or update one thing's record. Returns the record, null, or { aborted: true }. */
export async function writeRecord(thing, { dry = false } = {}) {
  const aliases = (() => { try { return JSON.parse(thing.aliases || '[]'); } catch { return []; } })();
  const notes = await gatherEvidence(thing.name, aliases);
  if (notes.first.length + notes.later.length < 2) return null;
  let text = '';
  const ac = new AbortController();
  _writing = ac;
  try {
    for await (const c of askAIStream(RECORD_PROMPT(thing.name, notes, oldObj(thing), ownerName()), { model: recordModel(), maxTokens: 500, timeout: 180000, caller: 'memory-things', signal: ac.signal })) {
      text += typeof c === 'string' ? c : (c?.text || '');
    }
    text = text.trim();
  } catch (err) {
    if (ac.signal.aborted) return { aborted: true };
    console.warn(`[things] record for ${thing.name} failed:`, err.message);
    return null;
  } finally {
    if (_writing === ac) _writing = null;
  }
  if (ac.signal.aborted) return { aborted: true };
  // A public topic he only talked about (Lithuania in a talk on the Baltics, 2026-11-23) is not one of
  // his things: its note is dropped, so the shelf never answers "Lithuania" with a news summary as if
  // it were his. More mentions bring it back for another look (a trip there would make it his).
  if (/^PUBLIC\b/i.test(text)) {
    if (!dry) run(`UPDATE memory_things SET record = NULL, obj = NULL, embedding = NULL, written_at = datetime('now','localtime'), written_mentions = mentions WHERE id = :id`, { ':id': thing.id });
    return { record: null, public: true };
  }
  const obj = cleanThing(text, thing.name, [...notes.first, ...notes.later].map((n) => (typeof n === 'string' ? n : JSON.stringify(n))).join(' '));
  if (!obj) return null;
  // The PUBLIC rule above, inside the long note prompt, was not followed: Lithuania was written up
  // again (2026-11-23). Asked alone, about the short note just written, it is one easy question.
  // Only for the kinds a public topic comes as (a country, a group of people, a news event, a
  // company he has no dealings with): asked about everything, the same model called Linux, which he
  // builds PAN for, a topic, even when told a thing he works with is his.
  const dealings = obj.who?.length || obj.next?.length || obj.needs?.length;
  const topicKind = ['place', 'group', 'event'].includes(obj.kind) || (obj.kind === 'organization' && !dealings);
  if (topicKind && await onlyATopic(obj)) {
    if (!dry) run(`UPDATE memory_things SET record = NULL, obj = NULL, embedding = NULL, written_at = datetime('now','localtime'), written_mentions = mentions WHERE id = :id`, { ':id': thing.id });
    return { record: null, public: true };
  }
  const record = renderThing(obj);
  const n = notes.first.length + notes.later.length;
  if (dry) return { record, obj, notes: n };
  let vec = null;
  try { vec = await embed(`${obj.name}: ${obj.what}. ${obj.state || ''}`); } catch {}
  const had = (() => { try { return JSON.parse(thing.aliases || '[]'); } catch { return []; } })();
  const aliasesAll = [...new Set([...had, ...(obj.aliases || [])])].slice(0, 10);
  run(`UPDATE memory_things SET record = :r, obj = :o, kind = :k, aliases = :a, importance = :imp, private = :p,
      written_at = datetime('now','localtime'), written_mentions = mentions, embedding = :v WHERE id = :id`,
    { ':r': record, ':o': JSON.stringify(obj), ':k': obj.kind, ':a': JSON.stringify(aliasesAll), ':imp': obj.importance,
      ':p': obj.private ? 1 : 0, ':v': vec ? toBlob(vec) : null, ':id': thing.id });
  return { record, obj, notes: n };
}

/**
 * Notes due: a thing never understood yet (a name new today first, so it is understood within
 * minutes of first showing up; then the most mentioned), then things with MORE new mentions.
 */
export function dueThings(limit = 1) {
  ensureThings();
  return all(`SELECT * FROM memory_things WHERE mentions >= :min AND mentions > plain
    AND (written_at IS NULL OR mentions >= written_mentions + :more)
    ORDER BY (written_at IS NULL) DESC, (asked_at > datetime('now','localtime','-1 hour')) DESC, (first_seen > datetime('now','localtime','-1 day')) DESC, mentions DESC LIMIT :lim`, { ':min': MIN_MENTIONS, ':more': MORE, ':lim': limit });
}

/** Write the next due note. A thing the notes cannot explain yet waits for MORE mentions. */
export async function writeNextDue() {
  const t = dueThings(1)[0];
  if (!t) return null;
  const r = await writeRecord(t);
  if (r?.aborted) return { name: t.name, aborted: true };   // stays due
  if (!r) run(`UPDATE memory_things SET written_at = COALESCE(written_at, datetime('now','localtime')), written_mentions = mentions WHERE id = :id`, { ':id': t.id });
  return { name: t.name, record: r?.record || null };
}

// ── The watch: new names are understood as they come, not twice a day ───────────────────
// Every WATCH_MS it reads the typed prompts since the last event it saw and counts their names;
// then, if nobody talked to PAN in the last QUIET_MS (a note is about a minute of the hub's CPU),
// it writes one due note.
let _watch = null, _busy = false;
function lastSeenId() {
  try { return Number(get(`SELECT value FROM settings WHERE key = 'things_last_event_id'`)?.value || 0); } catch { return 0; }
}
async function watchOnce() {
  if (_busy) return;
  // Setting things_watch 'off' stops it at once on a running hub, no swap needed.
  try { if (/off/i.test(String(get(`SELECT value FROM settings WHERE key = 'things_watch'`)?.value || ''))) return; } catch {}
  _busy = true;
  try {
    ensureThings();
    let since = lastSeenId();
    if (!since) since = Number(get(`SELECT MAX(id) m FROM events`)?.m || 0);   // a new hub starts from now
    const ev = all(`SELECT id, session_id, event_type, data, created_at FROM events WHERE id > :id AND +event_type IN ('UserPromptSubmit', 'RouterCommand') ORDER BY id LIMIT 2000`, { ':id': since });
    if (ev.length) noteMentions(ev);
    const top = ev.length ? ev[ev.length - 1].id : since;
    run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('things_last_event_id', :v)`, { ':v': String(top) });
    const talk = get(`SELECT COUNT(*) c FROM events WHERE +event_type = 'RouterCommand' AND created_at > datetime('now','localtime', :ago)`, { ':ago': `-${Math.round(QUIET_MS / 1000)} seconds` })?.c || 0;
    if (!talk && Date.now() >= _quietUntil) {
      const w = await writeNextDue();
      if (w?.record) console.log(`[things] understood ${w.name}: ${w.record.slice(0, 120)}`);
      else if (w?.aborted) console.log(`[things] note on ${w.name} stopped: someone is talking`);
    }
  } catch (err) {
    console.warn('[things] watch failed:', err.message);
  } finally {
    _busy = false;
  }
}
export function startThingsWatch() {
  if (_watch) return;
  _watch = setInterval(watchOnce, WATCH_MS);
  _watch.unref?.();
  setTimeout(watchOnce, 60 * 1000).unref?.();
}
export function stopThingsWatch() {
  if (_watch) { clearInterval(_watch); _watch = null; }
}

/** Every thing with a record, for the shelf. */
export function thingsWithRecords() {
  ensureThings();
  return all(`SELECT id, name, norm, aliases, kind, record, obj, importance, private, last_seen FROM memory_things WHERE record IS NOT NULL`);
}

export function thingsStats() {
  ensureThings();
  return get(`SELECT COUNT(*) things, SUM(record IS NOT NULL) records, MAX(written_at) last_written FROM memory_things`);
}

// ── For the API (GET /api/v1/things, POST /api/v1/things/write) ─────────────────────────
const asNote = (t) => t && ({ id: t.id, name: t.name, kind: t.kind, mentions: t.mentions, importance: t.importance, private: !!t.private,
  first_seen: t.first_seen, last_seen: t.last_seen, asked_at: t.asked_at, written_at: t.written_at,
  note: (() => { try { return t.obj ? JSON.parse(t.obj) : null; } catch { return null; } })(), text: t.record });

export function listThings({ q = '', limit = 50, withNotes = true } = {}) {
  ensureThings();
  const n = normName(q);
  return all(`SELECT * FROM memory_things WHERE (:n = '' OR norm LIKE :like) ${withNotes ? 'AND record IS NOT NULL' : ''}
    ORDER BY COALESCE(importance, 0) DESC, last_seen DESC LIMIT :lim`, { ':n': n, ':like': `%${n}%`, ':lim': Math.min(500, Number(limit) || 50) }).map(asNote);
}

export function getThing(name) {
  ensureThings();
  return asNote(get(`SELECT * FROM memory_things WHERE norm = :n OR name = :name COLLATE NOCASE`, { ':n': normName(name), ':name': String(name || '') }));
}

/** Write one thing's note now (dry: return it without saving). */
export async function writeThingNow(name, { dry = false } = {}) {
  ensureThings();
  const t = get(`SELECT * FROM memory_things WHERE norm = :n OR name = :name COLLATE NOCASE`, { ':n': normName(name), ':name': String(name || '') });
  if (!t) return { error: 'not a thing yet' };
  const r = await writeRecord(t, { dry });
  return r?.aborted ? { aborted: true } : r || { note: null, reason: 'the notes do not show what it is' };
}

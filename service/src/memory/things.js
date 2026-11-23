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
  // asked_at: when he last asked PAN about it by voice (added 2026-11-23, after the table)
  try { run(`ALTER TABLE memory_things ADD COLUMN asked_at TEXT`); } catch {}
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

const RECORD_PROMPT = (name, notes, old) => `You keep PAN's notes on the things in one man's life and work. PAN is his voice assistant. The notes are his own words and what his Claude threads reported doing for him.

Write what "${name}" is to him, from the notes below only.
- Two or three plain sentences about him in the third person ("he"): what it is, how it relates to him, and where it stands now.
- Say what the thing IS, in the first words: "X is his ...". Not what was said in one conversation about it.
- What it is usually shows in how it first came up; where it stands shows in the latest notes.
- Only what the notes say. Never guess or add general knowledge.
- If it has other names or spellings in the notes, say so.
- If the notes do not show what it is, write exactly: UNKNOWN
${old ? `\nThe current note, to update (keep what is still true):\n${old}\n` : ''}
How it first came up, oldest first:
${notes.first.join('\n') || '(none)'}

Since then, newest first:
${notes.later.join('\n') || '(none)'}

The note on "${name}":`;

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

/** Write or update one thing's record. Returns the record, null, or { aborted: true }. */
export async function writeRecord(thing, { dry = false } = {}) {
  const aliases = (() => { try { return JSON.parse(thing.aliases || '[]'); } catch { return []; } })();
  const notes = await gatherEvidence(thing.name, aliases);
  if (notes.first.length + notes.later.length < 2) return null;
  let text = '';
  const ac = new AbortController();
  _writing = ac;
  try {
    for await (const c of askAIStream(RECORD_PROMPT(thing.name, notes, thing.record), { model: recordModel(), maxTokens: 220, timeout: 180000, caller: 'memory-things', signal: ac.signal })) {
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
  text = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  // gemma4:e4b sometimes says it all twice: keep the first three different sentences.
  const sentences = [];
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    const k = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (k && !sentences.some((x) => x.k === k)) sentences.push({ s, k });
    if (sentences.length === 3) break;
  }
  text = sentences.map((x) => x.s).join(' ');
  if (!text || /^UNKNOWN\b/i.test(text) || text.length < 20) return null;
  if (dry) return { record: text, notes: notes.first.length + notes.later.length };
  let vec = null;
  try { vec = await embed(`${thing.name}: ${text}`); } catch {}
  run(`UPDATE memory_things SET record = :r, written_at = datetime('now','localtime'), written_mentions = mentions, embedding = :v WHERE id = :id`,
    { ':r': text, ':v': vec ? toBlob(vec) : null, ':id': thing.id });
  return { record: text, notes: notes.first.length + notes.later.length };
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
  return all(`SELECT id, name, norm, aliases, kind, record, last_seen FROM memory_things WHERE record IS NOT NULL`);
}

export function thingsStats() {
  ensureThings();
  return get(`SELECT COUNT(*) things, SUM(record IS NOT NULL) records, MAX(written_at) last_written FROM memory_things`);
}

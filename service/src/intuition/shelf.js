// The shelf (docs/INTUITION-STATE.md section 11): what a person in the room already knows about
// the names going by. Every line heard, addressed to PAN or not, is checked for the names of the
// things in his memory (memory/things.js); a match puts that thing's record on the shelf, where it
// stays for 15 minutes unless the name comes up again. On a turn, the freshest records go into the
// prompt, already there, so nothing is fetched while he waits.
//
// Matching is by name, not by meaning: by meaning his stored notes scored 0.67 for a relevant one
// and 0.60 for an unrelated one (2026-11-23), too close to pick from. Names are compared with
// doubled letters made single, so "ellipsis" from the speech recognizer finds "Elipsis".
import { thingsWithRecords, normName } from '../memory/things.js';

const FADE_MS = 15 * 60 * 1000;
const RELOAD_MS = 5 * 60 * 1000;
const MAX_ON_TURN = 2;

let _things = [];
let _loadedAt = 0;
const _shelf = new Map();   // thing id -> { at, n }

function load() {
  if (Date.now() - _loadedAt < RELOAD_MS) return;
  _loadedAt = Date.now();
  try {
    _things = thingsWithRecords().map((t) => {
      let aliases = [];
      try { aliases = JSON.parse(t.aliases || '[]'); } catch {}
      const keys = [t.norm, ...aliases.map(normName)].filter((k) => k && k.length >= 3);
      return { id: t.id, name: t.name, record: t.record, keys, private: !!t.private, importance: Number(t.importance ?? 0.5) };
    });
  } catch (e) {
    console.warn('[shelf] things not loaded:', e.message);
  }
}

// A line as words, plus each pair of words run together: speech writes "PCB way" for PCBWay
// (his phone, 2026-11-23), so "pcbway" must match either way.
function lineOf(text) {
  const words = normName(text).split(' ').filter(Boolean);
  const joined = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) joined.add(words[i] + words[i + 1]);
  return { padded: ` ${words.join(' ')} `, joined };
}
const named = (t, l) => t.keys.some((k) => l.padded.includes(` ${k} `) || l.joined.has(k.replace(/ /g, '')));

/** Note a heard line. Returns the names it put on the shelf. */
export function hear(text) {
  load();
  if (!_things.length) return [];
  const l = lineOf(text);
  const now = Date.now();
  const hit = [];
  for (const t of _things) {
    if (!named(t, l)) continue;
    const e = _shelf.get(t.id) || { n: 0 };
    e.at = now; e.n++;
    _shelf.set(t.id, e);
    hit.push(t.name);
  }
  return hit;
}

/**
 * The block for this turn's prompt: the freshest records on the shelf, his line counted first.
 * `named` is the things his own line names (a question about one of his things: his notes answer it,
 * not a web search).
 */
export function shelfForTurn(text, { othersNearby = false } = {}) {
  const named = hear(text);
  const now = Date.now();
  for (const [id, e] of _shelf) if (now - e.at >= FADE_MS) _shelf.delete(id);
  // A private note (health, money) is not handed to a reply while other voices are around.
  const recs = [..._shelf.entries()].sort((a, b) => b[1].at - a[1].at)
    .map(([id]) => _things.find((t) => t.id === id)).filter((t) => t && !(othersNearby && t.private)).slice(0, MAX_ON_TURN);
  const block = recs.length
    // Worded as an instruction: worded as "background", the hub model answered a long question
    // about one of his projects with "I don't know what that is" (replay of his real lines,
    // 2026-11-23), with this very note in its prompt.
    ? `His own notes on names in this talk. If he asks what one of these is, or talks about it, this is what he means (his own thing, not the dictionary word); answer from the note:\n${recs.map((t) => `- ${t.name}: ${t.record}`).join('\n')}`
    : '';
  return { block, named };
}

const firstSentence = (s, max = 110) => {
  const one = String(s || '').split(/(?<=[.!?])\s+/)[0] || '';
  return one.length > max ? one.slice(0, max - 3).replace(/\s+\S*$/, '') + '...' : one;
};

/**
 * For the situation line: what the things named in these texts are (a window title, the talk's
 * topic). "WOE Camera" in a window title becomes "WOE Camera is his thread for ...", so the state
 * says what he is doing, not only which window is up.
 */
export function notesNamedIn(texts, max = 2) {
  load();
  if (!_things.length) return [];
  const lines = texts.filter(Boolean).map(lineOf);
  const out = [];
  // Longer names first: "WOE Camera" before "WoE".
  for (const t of [..._things].sort((a, b) => b.keys[0].length - a.keys[0].length)) {
    if (out.length >= max) break;
    if (!lines.some((l) => named(t, l))) continue;
    if (out.some((o) => o.keys.some((k) => t.keys.some((k2) => k.includes(k2))))) continue;   // "WoE" inside "WOE Camera"
    out.push(t);
  }
  return out.map((t) => firstSentence(String(t.record).split('\n')[0]));   // "Name (kind): what"
}

/**
 * For memory search: notes whose name the query holds, or that hold the query ("elipsis" finds
 * Elipsis). Returned as search results, ahead of the raw events.
 */
export function notesForQuery(query, max = 2) {
  load();
  const l = lineOf(query);
  const q = l.padded;
  if (q.trim().length < 3) return [];
  return _things.filter((t) => named(t, l) || t.keys.some((k) => q.trim().length >= 4 && ` ${k} `.includes(q)))
    .slice(0, max).map((t) => ({ name: t.name, record: t.record }));
}

export function shelfState() {
  load();
  const now = Date.now();
  return { things: _things.length, on_shelf: [..._shelf.entries()].filter(([, e]) => now - e.at < FADE_MS).map(([id, e]) => ({ name: _things.find((t) => t.id === id)?.name, ago_s: Math.round((now - e.at) / 1000), n: e.n })) };
}

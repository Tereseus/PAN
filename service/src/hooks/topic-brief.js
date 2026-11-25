// Topic briefing for Claude threads (UserPromptSubmit hook, routes/hooks.js).
//
// Why (2026-11-24): the SessionStart briefing only finds past work when a new thread's folder matches a
// project, and the owner rarely starts new threads anyway: he renames old ones and they drift into new
// tasks. A thread asked him which way his balconies face when a doc from Nov 15 already said. So when a
// prompt opens a topic (first prompt of a session, first after a compaction, or a prompt whose rare words
// the thread's last turns never used), ΠAN searches the stored history the way pan_search's some-words pass
// does and hands the thread the best few hits as additionalContext: date, thread, one line each.
//
// No keyword lists and no special lookups: the prompt's own words are the query, the stored history is the
// only source, and how much a word counts comes from the history too: the search index itself says how many
// events hold it (an FTS match count, stopped once the word is too common to matter). Words that many events hold ("different", "actually" in spoken
// prompts) carry no topic and are dropped; a hit counts only when it shares enough of the rare ones.
// First replay without rarity (16,321 real prompts): it fired on a third of them and matched on filler.
//
// Not for the phone's voice path: its prompt budget is small and every token costs reading time there.
import { STOP_WORDS, eventSearchText } from '../event-search.js';

export const MAX_WORDS = 20;          // words of the prompt looked up (longest first)
export const MAX_TERMS = 8;           // rare words kept (rarest first)
export const MIN_TERMS = 1;           // fewer rare words than this: nothing to brief on
export const MIN_WEIGHT = 9.5;        // weight = ln(index size / events holding the word); 9.5 is a word about 9
                                      // events in 125,000 hold ("balconies": 6), or two rare words. A prompt, its
                                      // new words and a hit's shared words must each weigh at least this
export const RARE_MAX = 0.004;        // a word held by more than this share of indexed events carries no topic
                                      // (about 500 of the 125,000 indexed events; "different" is in 8,000)
export const SWITCH_BELOW = 0.34;     // weighted share of the rare words the last turns used; below = new topic
                                      // ...and the rare words the last turns never used weigh MIN_WEIGHT
export const COOLDOWN = 4;            // prompts after a brief before a new-topic brief can fire again
export const MIN_COVER = 0.6;         // a hit must share at least this weighted share of the prompt's rare words,
export const MIN_SHARED = 2;          // and at least 2 of them (1 when the prompt has only 1)
export const OWN_MIN_SHARED = 3;      // his own earlier lines need 3 shared rare words and nearly all of the
export const OWN_MIN_COVER = 0.9;     // weight: replies hold the facts, and in replays his lines matched on the
                                      // words he says when upset or thinking aloud ("freaking" is in 278 events,
                                      // "qutebrowser" in 247, so counts alone cannot tell them apart)
export const MAX_HITS = 4;
export const MAX_CHARS = 1800;        // the whole block
export const LINE_CHARS = 240;        // one hit's excerpt
export const TIME_CAP_MS = 300;       // slower than this: thrown away, and briefs pause for a while
export const BACKOFF_MS = 10 * 60_000;
export const RECENT_TURNS = 6;        // prompts and replies of this thread to compare against
export const CANDIDATES = 60;         // FTS rows read per search
export const BRIEF_TYPES = ['UserPromptSubmit', 'Stop', 'AssistantMessage', 'AssistantTurnText'];

/** The prompt's candidate words: no stop words, no 1-2 letter words or numbers, longest first. */
export function contentTerms(text, max = MAX_WORDS) {
  const seen = new Set();
  const out = [];
  for (const w of String(text || '').match(/[\p{L}\p{N}_]+/gu) || []) {
    const lw = w.toLowerCase();
    // numbers, and ids or hashes (hex with a digit: "679ae4d8", "4b36") are not topic words
    if (lw.length < 3 || STOP_WORDS.has(lw) || /^\d+$/.test(lw) || (/\d/.test(lw) && /^[0-9a-f]+$/.test(lw)) || seen.has(lw)) continue;
    seen.add(lw);
    out.push(lw);
  }
  return out.sort((a, b) => b.length - a.length).slice(0, max);
}

/** The part of a word compared against other text: drops a short ending (balconies ~ balcony). */
export function stemOf(w) {
  return w.length <= 5 ? w : w.slice(0, Math.max(5, w.length - 3));
}

/**
 * The rare words of the prompt with their weight, rarest first: [{ word, stem, df, weight }].
 * stats.df(word) = how many indexed events hold the word (the index applies its own stemmer), counted
 * only up to stats.cap: a word at the cap is common. stats.n = index size. The hook stores and indexes the
 * prompt before it runs, so every word counts once for the prompt itself: `own` (1) is taken off, and a
 * word only this prompt holds is dropped (it made "remind" and "again" outweigh "balconies").
 */
export function rareTerms(words, stats, max = MAX_TERMS, own = 1) {
  const out = [];
  const stems = new Set();
  for (const w of words) {
    const stem = stemOf(w);
    if ([...stems].some((s) => s.startsWith(stem) || stem.startsWith(s))) continue;   // statement ~ statements
    const d = (stats.df(w) || 0) - own;
    if (d <= 0 || d > RARE_MAX * stats.n) continue;
    stems.add(stem);
    out.push({ word: w, stem, df: d, weight: Math.log(stats.n / d) });
  }
  return out.sort((a, b) => a.df - b.df).slice(0, max);
}

/** FTS5 query: any of the words, quoted so the text is never FTS syntax (the index stems them). */
export function briefQuery(terms) {
  return terms.map((t) => `"${t.word}"`).join(' OR ');
}

function wordsOf(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
}

/** The terms whose stem starts some word of the text. */
export function sharedTerms(terms, text) {
  const ws = wordsOf(text);
  return terms.filter((t) => ws.some((w) => w.startsWith(t.stem)));
}

const weightOf = (ts) => ts.reduce((a, t) => a + t.weight, 0);

/** Weighted share of the prompt's rare words that the thread's recent turns already used. 0..1. */
export function topicOverlap(terms, recentTexts) {
  if (!terms.length) return 1;
  return weightOf(sharedTerms(terms, recentTexts.join(' '))) / weightOf(terms);
}

/**
 * '' (no brief) or why this prompt gets one. newWeight = weight of the rare words the last turns never used;
 * sinceLast = prompts since this session's last brief (Infinity when none).
 */
export function briefReason({ terms, firstTurn, afterCompact, overlap, newWeight = Infinity, sinceLast = Infinity }) {
  if (!terms || terms.length < MIN_TERMS || weightOf(terms) < MIN_WEIGHT) return '';
  if (firstTurn) return 'first prompt';
  if (afterCompact) return 'after compaction';
  if (overlap < SWITCH_BELOW && newWeight >= MIN_WEIGHT && sinceLast >= COOLDOWN) return 'new topic';
  return '';
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A short piece of the text around the first shared word, so the line shows why it matched. */
export function excerpt(text, terms, max = LINE_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.search(new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(t.stem)}`, 'u'));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(max / 3));
  const piece = flat.slice(start, start + max).trim();
  return (start > 0 ? '… ' : '') + piece + (start + max < flat.length ? ' …' : '');
}

/**
 * Pick the hits worth handing over from FTS candidate rows ({id, session_id, event_type, created_at,
 * data, cwd?}). Skips the current session, markup, the same prompt stored again under another session
 * id, and rows sharing too few of the rare words; at most one hit per other session, best weighted share
 * first, newer first on a tie.
 */
export function pickHits(rows, terms, sessionId, prompt = '') {
  const total = weightOf(terms);
  const own = String(prompt).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
  const scored = [];
  for (const r of rows) {
    if (!r || r.session_id === sessionId) continue;
    const text = eventSearchText(r);
    if (!text || text.trim().startsWith('<')) continue;
    if (own && text.replace(/\s+/g, ' ').trim().toLowerCase().startsWith(own)) continue;
    const shared = sharedTerms(terms, text);
    const cover = total ? weightOf(shared) / total : 0;
    if (weightOf(shared) < MIN_WEIGHT || cover < MIN_COVER || shared.length < Math.min(MIN_SHARED, terms.length)) continue;
    if (r.event_type === 'UserPromptSubmit' && (shared.length < OWN_MIN_SHARED || cover < OWN_MIN_COVER)) continue;
    scored.push({ row: r, text, shared, cover });
  }
  scored.sort((a, b) => b.cover - a.cover || String(b.row.created_at).localeCompare(String(a.row.created_at)));
  const out = [];
  const sessions = new Set();
  const seenText = new Set();
  for (const s of scored) {
    const k = s.text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160);
    if (sessions.has(s.row.session_id) || seenText.has(k)) continue;
    sessions.add(s.row.session_id);
    seenText.add(k);
    out.push(s);
    if (out.length >= MAX_HITS) break;
  }
  return out;
}

function folderOf(cwd) {
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** The block handed to Claude, at most MAX_CHARS. '' when there are no hits. */
export function formatBrief(hits) {
  if (!hits.length) return '';
  const head = 'ΠAN history on this topic (earlier threads; pan_search for more before asking the user):';
  const lines = [head];
  let size = head.length;
  for (const h of hits) {
    const r = h.row;
    const who = r.event_type === 'UserPromptSubmit' ? 'user said' : 'reply';
    const where = [folderOf(r.cwd), String(r.session_id || '').slice(0, 8)].filter(Boolean).join(' ');
    const line = `- ${String(r.created_at || '').slice(0, 10)}, thread ${where}, ${who} (shares ${h.shared.map((t) => t.word).join(', ')}): ${excerpt(h.text, h.shared)}`;
    if (size + 1 + line.length > MAX_CHARS) break;
    lines.push(line);
    size += 1 + line.length;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Word counts from the search index, for a better-sqlite3 handle: { df(word), n }. One FTS match per word,
 * stopped after enough rows to call it common, so a common word costs a few hundred index reads; answers
 * are cached for an hour. (An fts5vocab lookup was faster but needs the stemmed form, and guessing it by
 * cutting letters matched junk tokens: "always" read as "alw", a word 3 events hold.)
 */
export function indexStats(db) {
  // events indexed (125,000 of 1 million events on the Nov 1 copy: not every event is indexed)
  const size = db.prepare('SELECT COUNT(*) AS m FROM events_fts_docsize');
  const cache = new Map();
  let n = 0;
  let nAt = 0;
  const stats = {
    get n() {
      if (Date.now() - nAt > 3600_000) { n = size.get()?.m || 0; nAt = Date.now(); }
      return n;
    },
    df(word) {
      const c = cache.get(word);
      if (c && Date.now() - c.at < 3600_000) return c.doc;
      const cap = Math.ceil(RARE_MAX * stats.n) + 1;
      let doc = 0;
      try {
        doc = db.prepare('SELECT COUNT(*) AS c FROM (SELECT rowid FROM events_fts WHERE events_fts MATCH ? LIMIT ?)')
          .get(`"${String(word).replace(/"/g, '')}"`, cap)?.c || 0;
      } catch { doc = 0; }
      if (cache.size > 20_000) cache.clear();
      cache.set(word, { doc, at: Date.now() });
      return doc;
    },
  };
  return stats;
}

/** The text without the <system-reminder> blocks the app can put in front of his words. */
export function withoutReminders(text) {
  return String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim();
}

// ---- state per session, kept in this process ----------------------------------------------------
const compacted = new Set();
const sinceBrief = new Map();   // session -> prompts since its last brief
let pausedUntil = 0;

/** SessionStart with source 'compact': the next prompt of that session gets a brief. */
export function noteCompaction(sessionId) {
  if (sessionId) compacted.add(sessionId);
}

/** For tests. */
export function _reset() { compacted.clear(); sinceBrief.clear(); pausedUntil = 0; }

/**
 * The whole step. `all(sql, params)` runs a read query; `stats` gives the index word counts (indexStats);
 * orgId scopes the queries. Returns { text, reason, ms, terms, hits }, text '' when nothing is added.
 * Never throws.
 */
export function topicBrief({ prompt, sessionId, all, stats, orgId = 'org_personal', now = Date.now, clock = () => performance.now() }) {
  const out = { text: '', reason: '', ms: 0, terms: [], hits: 0 };
  try {
    // The app can put a <system-reminder> block in front of his first words: take it off. What is left
    // must be his own words: markup and messages relayed from other sessions or tasks are not his topic.
    const p = withoutReminders(prompt);
    if (!p || p.startsWith('<') || /<(cross-session-message|agent-message|task-notification|system-reminder|scheduled-task)\b/.test(p.slice(0, 400))) return out;
    // every prompt counts toward the cooldown, briefed or not
    if (sinceBrief.has(sessionId)) sinceBrief.set(sessionId, sinceBrief.get(sessionId) + 1);
    if (now() < pausedUntil) { out.reason = 'paused (slow search earlier)'; return out; }
    const words = contentTerms(p);
    if (words.length < MIN_TERMS) return out;
    const t0 = clock();
    const terms = rareTerms(words, stats);
    out.terms = terms.map((t) => t.word);
    if (terms.length < MIN_TERMS) return out;

    // The thread's last turns, newest first; the current prompt is already stored, so drop it.
    const recent = all(
      `SELECT event_type, data FROM events WHERE session_id = :sid AND org_id = :org_id
         AND event_type IN ('UserPromptSubmit','Stop')
       ORDER BY id DESC LIMIT :n`, { ':sid': sessionId, ':org_id': orgId, ':n': RECENT_TURNS + 1 });
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
    const rest = [...recent];
    if (rest.length && rest[0].event_type === 'UserPromptSubmit' && norm(withoutReminders(eventSearchText(rest[0]))) === norm(p)) rest.shift();
    const texts = rest.map((r) => withoutReminders(eventSearchText(r))).filter(Boolean);
    const earlierPrompt = rest.some((r) => r.event_type === 'UserPromptSubmit');
    const afterCompact = compacted.delete(sessionId);
    const last = texts.slice(0, RECENT_TURNS);
    const sinceLast = sinceBrief.has(sessionId) ? sinceBrief.get(sessionId) : Infinity;
    if (sinceBrief.size > 5000) sinceBrief.clear();
    const reason = briefReason({
      terms, firstTurn: !earlierPrompt, afterCompact, overlap: topicOverlap(terms, last),
      newWeight: weightOf(terms) - weightOf(sharedTerms(terms, last.join(' '))), sinceLast,
    });
    if (!reason) return out;
    out.reason = reason;
    sinceBrief.set(sessionId, 0);

    const rows = all(
      `SELECT events.id, events.session_id, events.event_type, events.created_at, events.data, sessions.cwd AS cwd
       FROM (SELECT rowid AS fts_id, rank FROM events_fts WHERE events_fts MATCH :q ORDER BY rank LIMIT :cap) f
       CROSS JOIN events ON events.id = f.fts_id
       LEFT JOIN sessions ON sessions.id = events.session_id
       WHERE events.org_id = :org_id AND events.event_type IN (${BRIEF_TYPES.map((t) => `'${t}'`).join(',')})`,
      { ':q': briefQuery(terms), ':cap': CANDIDATES, ':org_id': orgId });
    out.ms = Math.round(clock() - t0);
    if (out.ms > TIME_CAP_MS) {
      pausedUntil = now() + BACKOFF_MS;
      out.reason += `, dropped: took ${out.ms} ms`;
      return out;
    }
    const hits = pickHits(rows, terms, sessionId, p);
    out.hits = hits.length;
    out.text = formatBrief(hits);
    return out;
  } catch (err) {
    out.reason = `error: ${err.message}`;
    return out;
  }
}

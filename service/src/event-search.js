// Keyword + meaning search over events: the pure parts, kept out of the route so
// they can be tested without a database. The route is GET /dashboard/api/events?q=
// in routes/dashboard.js, which pan_search calls.
//
// Why three passes (2026-11-21): a search for "GL.iNet GoodCloud unbind cloud KVM
// router" found the advice but not the outcome, a Stop row that said "KVM block:
// done. The router now refuses anything from the KVM". The outcome lacked three of
// the six words, and the any-word pass only ran when the every-word pass found
// NOTHING, so two weak every-word hits hid it. Now:
//   1. all words  (newest first)            match: 'all words'
//   2. some words (bm25, best first) when pass 1 found less than a page or < 10
//   3. meaning    (nearest embeddings) when 1 + 2 together found < 5
// Each hit says which pass found it, so the calling Claude can see why it matched.

export const MATCH_ALL = 'all words';
export const MATCH_SOME = 'some words';
export const MATCH_MEANING = 'meaning';

// Run the some-words pass when the all-words pass found fewer than this (or less than the page).
export const FILL_TARGET = 10;
// Run the meaning pass when both keyword passes together found fewer than this.
export const MEANING_BELOW = 5;
// How many nearest events the meaning pass asks for.
export const MEANING_K = 10;

const MAX_WORDS = 12;

// Words that carry no topic. In the some-words pass every term is OR'd, so one of
// these would match most of the database and make bm25 score all of it.
export const STOP_WORDS = new Set(`
a an and are as at be been but by can could did do does doing done for from had has have how i if in
into is it its just me my no not of on or our so than that the their them then there these they this
to too up us was we were what when where which who why will with would you your yes ok okay please
about any all also get got make made some more most very want need know like there here out over
`.trim().split(/\s+/));

function words(text) {
  return (String(text || '').match(/[\p{L}\p{N}_]+/gu) || []).slice(0, MAX_WORDS);
}

/**
 * Free text -> FTS5 query. Each word becomes a quoted prefix term, so the user's
 * text can never be parsed as FTS syntax. joiner ' ' = every word, ' OR ' = any.
 * (events_fts uses the porter tokenizer, which stems prefix terms too:
 * "routing"* finds "router". It cannot join irregular forms like unbind/unbound;
 * the meaning pass is for those.)
 */
export function toFtsQuery(text, joiner) {
  return words(text).map((w) => `"${w}"*`).join(joiner);
}

/** Pass 1: every word must be there. Empty string when the text has no words. */
export function allWordsQuery(text) {
  return toFtsQuery(text, ' ');
}

/**
 * Pass 2: any of the content words, OR'd for bm25 to rank (rows with more and
 * rarer words score best). Stop words and 1-2 letter words are dropped, and
 * 3-letter words are exact rather than prefix, because an OR of a word that is
 * everywhere ranks the whole index. Returns '' when nothing worth searching is left.
 */
export function someWordsQuery(text) {
  const seen = new Set();
  const terms = [];
  for (const w of words(text)) {
    const lw = w.toLowerCase();
    if (lw.length < 3 || STOP_WORDS.has(lw) || seen.has(lw)) continue;
    seen.add(lw);
    terms.push(lw.length === 3 ? `"${w}"` : `"${w}"*`);
  }
  return terms.join(' OR ');
}

/** Should pass 2 run, given how many all-words hits there were? */
export function needsSomeWords(allCount, offset, limit) {
  return allCount < Math.max(offset + limit, FILL_TARGET);
}

/** Should pass 3 run? Only on the first page, and only when keywords found little. */
export function needsMeaning(keywordCount, offset) {
  return offset === 0 && keywordCount < MEANING_BELOW;
}

/**
 * Merge the keyword passes: all-words hits first (in their order), then
 * some-words hits not already present (in bm25 order). Returns [{ id, match }].
 * The route pages this list, and total is its length.
 */
export function mergeKeywordHits(allIds, someIds = []) {
  const out = [];
  const seen = new Set();
  for (const id of allIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, match: MATCH_ALL });
  }
  for (const id of someIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, match: MATCH_SOME });
  }
  return out;
}

/**
 * The readable text of an event row, for dedupe and for dropping hook-envelope
 * rows from meaning hits. '' when the row has nothing a person wrote or read.
 */
export function eventSearchText(row) {
  if (!row) return '';
  let d;
  try { d = JSON.parse(row.data); } catch { return ''; }
  if (!d || typeof d !== 'object') return typeof d === 'string' ? d : '';
  const t = d.prompt || d.last_assistant_message || d.text || d.assistant_message
    || d.user_message || d.description || d.decision || d.transcript || '';
  return typeof t === 'string' ? t : '';
}

function textKey(row) {
  return eventSearchText(row).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200);
}

/** Worth showing as a meaning hit: some real words, not a bare hook envelope. */
export function isReadableHit(row) {
  const t = eventSearchText(row).trim();
  if (t.length < 12) return false;
  return t.split(/\s+/).filter((w) => /[\p{L}]{3,}/u.test(w)).length >= 3;
}

/**
 * Append meaning hits to the page. meaningRows are hydrated event rows in nearest-
 * first order. Skips ids already on the page, rows with no readable text, and rows
 * whose text repeats a hit already shown (the same reply is often stored twice, as
 * a Stop row that FTS finds and an AssistantMessage row that only the embeddings
 * hold). Returns the new page (rows with .match set), at most `limit` long.
 */
export function appendMeaningHits(pageRows, meaningRows, limit) {
  const out = [...pageRows];
  const ids = new Set(out.map((r) => r.id));
  const keys = new Set(out.map(textKey).filter(Boolean));
  for (const r of meaningRows) {
    if (out.length >= limit) break;
    if (ids.has(r.id) || !isReadableHit(r)) continue;
    const k = textKey(r);
    if (keys.has(k)) continue;
    ids.add(r.id);
    keys.add(k);
    out.push({ ...r, match: MATCH_MEANING });
  }
  return out;
}

/** Keep rows in the order of `ids` (SQL IN returns them in any order). */
export function orderByIds(rows, ids) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

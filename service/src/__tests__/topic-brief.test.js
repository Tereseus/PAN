// Topic brief for Claude threads (hooks/topic-brief.js). Standalone, no database.
// Usage: node service/src/__tests__/topic-brief.test.js
import {
  topicBrief, contentTerms, rareTerms, stemOf, briefReason, pickHits, formatBrief, noteCompaction, _reset,
  MAX_CHARS, TIME_CAP_MS, MIN_TERMS,
} from '../hooks/topic-brief.js';

// Index word counts: a few rare words, a few common ones (held by 5 % of events), the rest unknown.
const RARE = new Set(['balconies', 'solar', 'panels', 'roof', 'medallion', 'wireless', 'charging', 'drc']);
const COMMON = new Set(['house', 'face', 'way', 'different', 'every', 'thing', 'board', 'route', 'check', 'report', 'chip', 'actually']);
const stats = { n: 1_000_000, df: (s) => (RARE.has(s) ? 12 : COMMON.has(s) ? 50_000 : 0) };

let passed = 0, failed = 0;
function test(name, fn) {
  _reset();
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

const ups = (sid, prompt, id = 1) => ({ id, session_id: sid, event_type: 'UserPromptSubmit', created_at: '2026-11-15 10:00:00', data: JSON.stringify({ prompt }), cwd: 'C:\\Users\\x\\Desktop' });
const stop = (sid, text, id = 2, when = '2026-11-15 10:01:00') => ({ id, session_id: sid, event_type: 'Stop', created_at: when, data: JSON.stringify({ last_assistant_message: text }), cwd: 'C:\\Users\\x\\Desktop\\PAN' });

// A fake db: `recent` answers the thread's own turns, `hits` answers the FTS search.
function fakeDb({ recent = [], hits = [], searchMs = 5 } = {}) {
  const calls = { search: 0 };
  let t = 0;
  return {
    calls,
    clock: () => t,
    all(sql) {
      if (sql.includes('events_fts')) { calls.search++; t += searchMs; return hits; }
      return recent;
    },
    stats,
  };
}

const SOLAR = 'Which way do the balconies face for the solar panels on the house roof?';
const OLD_HIT = stop('old-session', 'Solar doc: the balconies face the garden, so panels on the balcony railings get the afternoon sun; the house roof is flat.', 50);

console.log('\nTopic brief\n');

test('first prompt of a session fires and hands over the old answer', () => {
  const db = fakeDb({ recent: [ups('s1', SOLAR)], hits: [OLD_HIT] });
  const b = topicBrief({ prompt: SOLAR, sessionId: 's1', all: db.all, stats, clock: db.clock });
  assert(b.reason === 'first prompt', `reason ${b.reason}`);
  assert(b.text.includes('the garden'), 'the old reply is in the brief');
  assert(b.text.includes('2026-11-15') && b.text.includes('old-sess'), 'date and thread on the line');
});

test('a short question with one very rare word gets the old answer (the balconies case)', () => {
  const q = 'Which way do the balconies face?';
  const db = fakeDb({ recent: [ups('s1', q)], hits: [OLD_HIT] });
  const b = topicBrief({ prompt: q, sessionId: 's1', all: db.all, stats, clock: db.clock });
  assert(b.text.includes('the garden'), `got "${b.reason}" ${b.text}`);
});

test('words only the current prompt holds do not count (it is indexed before the hook runs)', () => {
  const q = 'remind me about the balconies again';
  const withSelf = { n: 1_000_000, df: (w) => ({ balconies: 13, remind: 1, again: 1 }[w] || 0) };
  const terms = rareTerms(contentTerms(q), withSelf);
  assert(terms.length === 1 && terms[0].word === 'balconies', `terms ${terms.map((t) => t.word)}`);
  const db = fakeDb({ recent: [ups('s1', q)], hits: [OLD_HIT] });
  const b = topicBrief({ prompt: q, sessionId: 's1', all: db.all, stats: withSelf, clock: db.clock });
  assert(b.text.includes('the garden'), `got ${b.reason} ${b.text}`);
});

test('a prompt on the same topic as the last turns stays quiet', () => {
  const recent = [ups('s1', SOLAR, 10), ups('s1', 'which side do the balconies face again', 9), stop('s1', 'The balconies face the garden; solar panels on the railings of the house would get afternoon sun.', 8), ups('s1', 'tell me about the solar panels and balconies', 7)];
  const db = fakeDb({ recent, hits: [OLD_HIT] });
  const b = topicBrief({ prompt: SOLAR, sessionId: 's1', all: db.all, stats, clock: db.clock });
  assert(b.text === '' && b.reason === '', `expected quiet, got "${b.reason}"`);
  assert(db.calls.search === 0, 'no search when the topic has not changed');
});

test('a topic switch inside a long thread fires', () => {
  const recent = [ups('s1', 'Route the medallion board again with the wireless charging chip', 9),
    stop('s1', 'Routed: DRC clean, the receiver chip sits by the USB end, coil pads beside the battery.', 8),
    ups('s1', 'Check the medallion board DRC report', 7)];
  const prompt = SOLAR;
  const db = fakeDb({ recent: [ups('s1', prompt, 10), ...recent], hits: [OLD_HIT] });
  const b = topicBrief({ prompt, sessionId: 's1', all: db.all, stats, clock: db.clock });
  assert(b.reason === 'new topic', `reason ${b.reason}`);
  assert(b.text.includes('the garden'), 'brief handed over');
});

test('a second topic switch right after a brief waits for the cooldown', () => {
  const medallion = 'Route the medallion board again with the wireless charging chip and check DRC';
  const db1 = fakeDb({ recent: [ups('s1', SOLAR, 10), ups('s1', medallion, 9), stop('s1', 'Routed the medallion wireless charging board, DRC clean.', 8)], hits: [OLD_HIT] });
  const first = topicBrief({ prompt: SOLAR, sessionId: 's1', all: db1.all, stats, clock: db1.clock });
  assert(first.reason === 'new topic', `first switch: ${first.reason}`);
  const db2 = fakeDb({ recent: [ups('s1', medallion, 11), ups('s1', SOLAR, 10), stop('s1', 'The balconies face the garden, solar panels on the roof.', 9)], hits: [OLD_HIT] });
  const second = topicBrief({ prompt: medallion, sessionId: 's1', all: db2.all, stats, clock: db2.clock });
  assert(second.reason === '', `switch back inside the cooldown should stay quiet, got ${second.reason}`);
});

test('after a compaction the next prompt fires even on the same topic', () => {
  // the current prompt is stored before the hook runs, so it is the newest row
  const recent = [ups('s1', SOLAR, 10), ups('s1', SOLAR, 9), stop('s1', 'The balconies face the garden for the solar panels.', 8)];
  noteCompaction('s1');
  const db = fakeDb({ recent, hits: [OLD_HIT] });
  const b = topicBrief({ prompt: SOLAR, sessionId: 's1', all: db.all, stats, clock: db.clock });
  assert(b.reason === 'after compaction', `reason ${b.reason}`);
  const again = topicBrief({ prompt: SOLAR, sessionId: 's1', all: db.all, stats, clock: db.clock });
  assert(again.reason === '', 'only the first prompt after it');
});

test('weak hits add nothing', () => {
  // shares only common words, or one rare word of three
  const weak = [stop('other', 'A different way to face the house, every thing.', 60), stop('other2', 'The solar inverter is quiet.', 61)];
  const db = fakeDb({ recent: [ups('s1', SOLAR)], hits: weak });
  const b = topicBrief({ prompt: SOLAR, sessionId: 's1', all: db.all, stats, clock: db.clock });
  assert(b.reason === 'first prompt' && b.text === '', `expected nothing, got ${b.text.length} chars`);
});

test('short or chatty prompts add nothing and do not search', () => {
  for (const p of ['ok go', 'yes do it', 'Thanks!', 'what about that one?']) {
    const db = fakeDb({ recent: [ups('s1', p)], hits: [OLD_HIT] });
    const b = topicBrief({ prompt: p, sessionId: 's1', all: db.all, stats, clock: db.clock });
    assert(b.text === '' && db.calls.search === 0, `"${p}" searched or added text`);
  }
  assert(contentTerms('ok go').length < MIN_TERMS, 'chat has too few content words');
  assert(!contentTerms('see 679ae4d8-f39c-4b36 and alloc_static').some((w) => /\d/.test(w)), 'ids and hashes are not words');
  // long spoken prompts full of common words have no rare words: nothing
  const chatty = 'Actually that is a different thing every way you check the house report';
  const db = fakeDb({ recent: [ups('s1', chatty)], hits: [OLD_HIT] });
  const b = topicBrief({ prompt: chatty, sessionId: 's1', all: db.all, stats, clock: db.clock });
  assert(b.text === '' && db.calls.search === 0, 'common words alone never search');
});

test('hits from the current session and system markup are skipped', () => {
  const own = stop('s1', 'Solar balconies face panels house roof: this thread said it already.', 70);
  const markup = stop('x', '<task-notification> solar balconies face panels house roof', 71);
  const again = stop('copy', SOLAR + ' and more', 72);
  const rows = pickHits([own, markup, again], rareTerms(contentTerms(SOLAR), stats), 's1', SOLAR);
  assert(rows.length === 0, 'own session and markup dropped');
});

test('the brief stays under the size cap, one hit per thread', () => {
  const long = 'solar balconies face panels house roof '.repeat(80);
  const many = Array.from({ length: 20 }, (_, i) => stop(`t${i}`, `${long} ${i}`, 100 + i));
  many.push(stop('t0', 'solar balconies face panels house roof again', 200));
  const db = fakeDb({ recent: [ups('s1', SOLAR)], hits: many });
  const b = topicBrief({ prompt: SOLAR, sessionId: 's1', all: db.all, stats, clock: db.clock });
  assert(b.text.length > 0 && b.text.length <= MAX_CHARS, `size ${b.text.length}`);
  const threads = b.text.split('\n').slice(1).map((l) => l.match(/thread \S+ (\S+)/)?.[1]);
  assert(new Set(threads).size === threads.length, 'one line per thread');
  assert(b.hits <= 4, `${b.hits} hits`);
});

test('a slow search is thrown away and briefs pause', () => {
  const db = fakeDb({ recent: [ups('s1', SOLAR)], hits: [OLD_HIT], searchMs: TIME_CAP_MS + 50 });
  const b = topicBrief({ prompt: SOLAR, sessionId: 's1', all: db.all, stats, clock: db.clock });
  assert(b.text === '' && /dropped/.test(b.reason), `reason ${b.reason}`);
  const fast = fakeDb({ recent: [ups('s2', SOLAR)], hits: [OLD_HIT] });
  const next = topicBrief({ prompt: SOLAR, sessionId: 's2', all: fast.all, stats, clock: fast.clock });
  assert(next.text === '' && /paused/.test(next.reason) && fast.calls.search === 0, 'paused after a slow search');
});

test('a database error adds nothing and does not throw', () => {
  const b = topicBrief({ prompt: SOLAR, sessionId: 's1', stats, all: () => { throw new Error('locked'); } });
  assert(b.text === '' && /error/.test(b.reason), 'error swallowed');
});

test('briefReason needs enough words and a reason', () => {
  const w = (weight) => ({ word: 'x', stem: 'x', df: 1, weight });
  assert(briefReason({ terms: [w(8)], firstTurn: true }) === '', 'one mildly rare word is not enough');
  assert(briefReason({ terms: [w(12)], firstTurn: true }) === 'first prompt', 'one very rare word is (balconies)');
  assert(briefReason({ terms: [w(8), w(8)], firstTurn: false, afterCompact: false, overlap: 0.8 }) === '', 'same topic');
  assert(briefReason({ terms: [w(8), w(8)], overlap: 0.1, newWeight: 8 }) === '', 'new words too light');
  assert(briefReason({ terms: [w(8), w(8)], overlap: 0.1, newWeight: 16 }) === 'new topic', 'new topic');
  assert(formatBrief([]) === '', 'no hits, no text');
});

test('rarity comes from the index: stems found, common words dropped, rarest first', () => {
  assert('balcony'.startsWith(stemOf('balconies')), 'balconies ~ balcony');
  const t = rareTerms(contentTerms(SOLAR), stats);
  const words = t.map((x) => x.word);
  assert(words.includes('balconies') && words.includes('solar') && words.includes('roof'), `rare kept: ${words}`);
  assert(!words.includes('house') && !words.includes('face'), 'common dropped');
});

console.log(`\n${'='.repeat(40)}\nResults: ${passed} passed, ${failed} failed\n${'='.repeat(40)}\n`);
process.exit(failed ? 1 : 0);

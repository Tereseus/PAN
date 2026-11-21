// Keyword + meaning search passes for /dashboard/api/events?q= (pan_search): the pure
// logic in event-search.js, plus the queries run against a real FTS5 porter index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  toFtsQuery, allWordsQuery, someWordsQuery, needsSomeWords, needsMeaning,
  mergeKeywordHits, appendMeaningHits, orderByIds, eventSearchText, isReadableHit,
  MATCH_ALL, MATCH_SOME, MATCH_MEANING, FILL_TARGET,
} from '../event-search.js';

const require = createRequire(import.meta.url);

test('every-word query quotes each word as a prefix term', () => {
  assert.equal(allWordsQuery('GL.iNet GoodCloud'), '"GL"* "iNet"* "GoodCloud"*');
  assert.equal(toFtsQuery('a OR b', ' OR '), '"a"* OR "OR"* OR "b"*');
  assert.equal(allWordsQuery('"); DROP --'), '"DROP"*');
  assert.equal(allWordsQuery('...'), '');
});

test('some-words query drops stop words, short words and repeats', () => {
  assert.equal(someWordsQuery('what did we decide about the router'), '"decide"* OR "router"*');
  assert.equal(someWordsQuery('GL.iNet GoodCloud unbind cloud KVM router'),
    '"iNet"* OR "GoodCloud"* OR "unbind"* OR "cloud"* OR "KVM" OR "router"*');
  assert.equal(someWordsQuery('Router router ROUTER'), '"Router"*');   // FTS is case-blind; first spelling kept
  assert.equal(someWordsQuery('is it the one'), '"one"');
  assert.equal(someWordsQuery('a to of'), '');
});

test('some-words runs when all-words found less than the page or under 10', () => {
  assert.equal(needsSomeWords(2, 0, 50), true);
  assert.equal(needsSomeWords(49, 0, 50), true);
  assert.equal(needsSomeWords(50, 0, 50), false);
  assert.equal(needsSomeWords(FILL_TARGET - 1, 0, 5), true);
  assert.equal(needsSomeWords(FILL_TARGET, 0, 5), false);
  assert.equal(needsSomeWords(12, 10, 5), true);   // page 3 of 5 needs 15
});

test('meaning runs only on the first page when keywords found under 5', () => {
  assert.equal(needsMeaning(0, 0), true);
  assert.equal(needsMeaning(4, 0), true);
  assert.equal(needsMeaning(5, 0), false);
  assert.equal(needsMeaning(0, 50), false);
});

test('merge puts all-words hits first, then new some-words hits', () => {
  assert.deepEqual(mergeKeywordHits([5, 3], [3, 9, 5, 1]), [
    { id: 5, match: MATCH_ALL }, { id: 3, match: MATCH_ALL },
    { id: 9, match: MATCH_SOME }, { id: 1, match: MATCH_SOME },
  ]);
  assert.deepEqual(mergeKeywordHits([], [2]), [{ id: 2, match: MATCH_SOME }]);
  assert.deepEqual(mergeKeywordHits([4, 4], []), [{ id: 4, match: MATCH_ALL }]);
});

const ev = (id, type, data) => ({ id, event_type: type, data: JSON.stringify(data) });

test('event text reads the field each type keeps its words in', () => {
  assert.equal(eventSearchText(ev(1, 'Stop', { last_assistant_message: 'done' })), 'done');
  assert.equal(eventSearchText(ev(1, 'UserPromptSubmit', { prompt: 'hi', cwd: 'x' })), 'hi');
  assert.equal(eventSearchText(ev(1, 'AssistantTurnText', { text: 'mid' })), 'mid');
  assert.equal(eventSearchText({ id: 1, data: 'not json' }), '');
  assert.equal(isReadableHit(ev(1, 'Stop', { session_id: 'abc', transcript_path: '/x' })), false);
  assert.equal(isReadableHit(ev(1, 'Stop', { last_assistant_message: 'The KVM is unbound now.' })), true);
});

test('meaning hits are appended, marked, deduped and capped', () => {
  const page = [{ ...ev(1, 'Stop', { last_assistant_message: 'KVM block: done. The router refuses the KVM.' }), match: MATCH_SOME }];
  const near = [
    ev(1, 'Stop', { last_assistant_message: 'KVM block: done. The router refuses the KVM.' }),          // same id
    ev(2, 'AssistantMessage', { text: 'KVM  block: done. The router refuses the KVM.' }),               // same text
    ev(3, 'Stop', { session_id: 's', hook_event_name: 'Stop' }),                                        // no words
    ev(4, 'AssistantMessage', { text: 'The KVM is unbound, but it is not fully local yet.' }),
    ev(5, 'UserPromptSubmit', { prompt: 'Is the KVM off the GL cloud before the breach?' }),
  ];
  const out = appendMeaningHits(page, near, 3);
  assert.deepEqual(out.map((r) => [r.id, r.match]), [[1, MATCH_SOME], [4, MATCH_MEANING], [5, MATCH_MEANING]]);
  assert.equal(appendMeaningHits(page, near, 1).length, 1);
});

test('rows come back in the order of the ids', () => {
  assert.deepEqual(orderByIds([{ id: 1 }, { id: 3 }, { id: 2 }], [3, 9, 1]).map((r) => r.id), [3, 1]);
});

test('the GL.iNet miss: the outcome is found by some words', () => {
  let Database;
  try { Database = require('better-sqlite3-multiple-ciphers'); } catch { return; }
  const db = new Database(':memory:');
  db.exec(`CREATE VIRTUAL TABLE events_fts USING fts5(content_text, content='', tokenize='porter unicode61')`);
  const rows = [
    'To unbind it from GL.iNet GoodCloud, open the KVM cloud page, then the router.',
    'GL.iNet GoodCloud unbind steps for the KVM: cloud off, then a router rule.',
    'KVM block: done. The router now refuses anything from the KVM.',
    'Dinner is at eight.',
  ];
  rows.forEach((t, i) => db.prepare('INSERT INTO events_fts(rowid, content_text) VALUES (?, ?)').run(i + 1, t));
  const ids = (q, order) => db.prepare(
    `SELECT rowid AS id FROM events_fts WHERE events_fts MATCH ? ORDER BY ${order} LIMIT 2000`).all(q).map((r) => r.id);

  const q = 'GL.iNet GoodCloud unbind cloud KVM router';
  const all = ids(allWordsQuery(q), 'rowid DESC');
  assert.deepEqual(all, [2, 1]);
  assert.equal(needsSomeWords(all.length, 0, 50), true);
  const some = ids(someWordsQuery(q), 'rank');
  const merged = mergeKeywordHits(all, some);
  assert.deepEqual(merged.find((h) => h.id === 3), { id: 3, match: MATCH_SOME });
  assert.equal(merged.some((h) => h.id === 4), false);
  // porter stems prefix terms too
  assert.deepEqual(ids(allWordsQuery('routing refused'), 'rowid'), [3]);
});

// The hub model asking for one more search (search-again.js): the tag is caught before anything is
// said, and every other reply passes through whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchAgainQuery, maybeSearchTag, peekSearch, peekDecline, declineState } from '../search-again.js';

async function* from(pieces) { for (const p of pieces) yield p; }
const drain = async (s) => { let out = ''; for await (const c of s) out += c; return out; };

test('a search tag gives its words', () => {
  assert.equal(searchAgainQuery('[SEARCH: NBA finals 2026 MVP]'), 'NBA finals 2026 MVP');
  assert.equal(searchAgainQuery(' "[search:who won the world cup 2026 ]'), 'who won the world cup 2026');
  assert.equal(searchAgainQuery('[ Search : price of gold today] and more'), 'price of gold today');
});

test('anything else is not a search', () => {
  assert.equal(searchAgainQuery('[AMBIENT]'), null);
  assert.equal(searchAgainQuery('I am not sure who won.'), null);
  assert.equal(searchAgainQuery('Search me, I do not know.'), null);
  assert.equal(searchAgainQuery('[SEARCH: ]'), null);
  assert.equal(searchAgainQuery('[SEARCH: no closing bracket'), null);
});

test('a tag left open counts only when the reply is over', () => {
  assert.equal(searchAgainQuery('[SEARCH: super bowl winner 2026', true), 'super bowl winner 2026');
  assert.equal(searchAgainQuery('[SEARCH:', true), null);
});

test('it can tell early that a reply is not a tag', () => {
  for (const h of ['', ' ', '"', '[', '[s', '[SEA', '[search', '[search ', '[search:', '[SEARCH: who won']) assert.equal(maybeSearchTag(h), true, h);
  for (const h of ['T', 'The', '[A', '[AMBIENT', '[searching', '[search!', '[SEARCH: x]', 'I [SEARCH:']) assert.equal(maybeSearchTag(h), false, h);
});

test('a tag in pieces is caught and nothing of it comes out', async () => {
  const r = await peekSearch(from(['[SE', 'ARCH: f1 ', 'champion 2026', ']', ' extra']));
  assert.deepEqual(r, { query: 'f1 champion 2026' });
});

test('a plain answer comes out whole, from its first piece', async () => {
  const r = await peekSearch(from(['Lando', ' Norris won', ' it.']));
  assert.equal(r.query, undefined);
  assert.equal(await drain(r.stream), 'Lando Norris won it.');
});

test('the quiet tag passes through for plainAsReply to read', async () => {
  const r = await peekSearch(from(['[', 'AMB', 'IENT]']));
  assert.equal(await drain(r.stream), '[AMBIENT]');
});

test('a tag the model never closed is still a search', async () => {
  const r = await peekSearch(from(['[SEARCH: ', 'oscar best picture 2026']));
  assert.deepEqual(r, { query: 'oscar best picture 2026' });
});

test('an empty reply stays empty', async () => {
  const r = await peekSearch(from([]));
  assert.equal(await drain(r.stream), '');
});

test('stopping early closes the model stream', async () => {
  let closed = false;
  async function* model() { try { yield 'One. '; yield 'Two. '; yield 'Three.'; } finally { closed = true; } }
  const r = await peekSearch(model());
  for await (const c of r.stream) { if (c) break; }
  assert.equal(closed, true);
});

test('a decline (I do not know) is caught, an answer is not, and the answer is not held back', async () => {
  assert.equal(declineState("I don't know that."), true);
  assert.equal(declineState('I’m not sure who won.'), true);
  assert.equal(declineState('I '), null);
  assert.equal(declineState('It is 3,776 metres.'), false);
  assert.equal(declineState('In 1989.'), false);
  let pulled = 0;
  async function* model() { for (const c of ['It', "'s ", 'about ', '3 euros.']) { pulled++; yield c; } }
  const r = await peekDecline(model());
  assert.equal(r.declined, false);
  assert.ok(pulled <= 2, 'stopped reading as soon as it could not be a decline');
  assert.equal(await drain(r.stream), "It's about 3 euros.");
});

test('a decline is caught, and close() ends the model stream', async () => {
  let closed = false;
  async function* model() { try { yield 'I don'; yield "'t know"; yield ' that.'; } finally { closed = true; } }
  const r = await peekDecline(model());
  assert.equal(r.declined, true);
  await r.close();
  assert.equal(closed, true);
});

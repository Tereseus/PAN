// The brief (intuition/brief.js): the situation line plus his threads, the things in play and the
// talk, about 500 tokens, with clock times so it stays the same from minute to minute.
// Runs standalone on a fresh database, no PAN server needed.
// Usage: node service/src/__tests__/brief.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-brief-'));
process.env.PAN_DEV = '1';

const tr = await import('../thread-relay.js');
const { buildBrief, threadLines, briefMode } = await import('../intuition/brief.js');
const { run } = await import('../db.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function ok(v, what) { if (!v) throw new Error(what); }

tr.ensureThreadRelaySchema();
const now = Date.now();
const job = (id, title, text, status, reply, ago, extra = '') => run(`INSERT INTO thread_relay_jobs (id, host, session_id, title, text, status, reply, created_at, replied_at, source${extra ? ', asked_by' : ''})
  VALUES (:id, 'laptop', :s, :t, :x, :st, :r, :c, :rc, 'phone'${extra ? ', 7' : ''})`,
  { ':id': id, ':s': 's_' + title, ':t': title, ':x': text, ':st': status, ':r': reply, ':c': now - ago, ':rc': now - ago + 60_000 });
job('a', 'Map Creation', 'make the river wider', 'replied', '**Done.** The river is wider now, see the [map](http://x).', 30 * 60_000);
job('b', 'Map Creation', 'older ask', 'replied', 'old answer', 50 * 60_000);
job('c', 'Tax Papers', 'is the form signed', 'delivered', null, 10 * 60_000);
job('d', 'Old Thread', 'from yesterday', 'replied', 'yesterday', 26 * 3600_000);
job('e', 'Someone Else', 'not his', 'replied', 'theirs', 5 * 60_000, 'other');

console.log('the brief');

test('threads: the newest ask to each of his threads in the last 3 hours', () => {
  const t = threadLines(now);
  ok(t.length === 2, `two threads, got ${t.length}: ${JSON.stringify(t)}`);
  ok(/^sent Tax Papers "is the form signed" at .*; no answer yet$/.test(t[0]), `waiting: ${t[0]}`);
  ok(/sent Map Creation "make the river wider" at .*it answered at .*: Done\. The river is wider now, see the map\.$/.test(t[1]), `answered, markdown gone: ${t[1]}`);
  ok(!t.some((l) => /older ask|yesterday|not his/.test(l)), 'no older ask, no old thread, nobody else\'s');
});

test('same words a minute later (clock times, never "ago")', () => {
  const a = buildBrief('Situation (background only, never read it out): at home; dark.', { now });
  const b = buildBrief('Situation (background only, never read it out): at home; dark.', { now: now + 60_000 });
  ok(a.text === b.text, 'stable');
  ok(a.text.startsWith('Situation (background only, never read it out): at home; dark. His threads: '), a.text.slice(0, 120));
  ok(!/ago\b/.test(a.text), 'no relative times');
});

test('about 500 tokens at most', () => {
  for (let i = 0; i < 40; i++) job('z' + i, 'Thread ' + i, 'x'.repeat(300), 'replied', 'y '.repeat(400), 60_000 + i);
  const b = buildBrief('Situation (background only, never read it out): ' + 'here; '.repeat(50), { now });
  ok(b.text.length <= 2100, `length ${b.text.length}`);
});

test('nothing known: no brief', () => {
  run(`DELETE FROM thread_relay_jobs`);
  ok(buildBrief('', { now }).text === '', 'empty');
});

test('mode is bench until set', () => ok(briefMode() === 'bench', briefMode()));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

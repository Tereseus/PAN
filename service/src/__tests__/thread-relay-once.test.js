// One send per thing he says, and a thread named in passing is not a send by itself
// (thread-relay.js sendPlan, sendOnce, sendQuestion, wantsSend). On Nov 22 one thought, said while
// describing the idea of "send to the PAN thread", went to that thread seven times in 70 s.
// Runs standalone on a fresh database.  Usage: node service/src/__tests__/thread-relay-once.test.js
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import assert from 'node:assert/strict';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-relay-once-'));
process.env.PAN_DEV = '1';
const tr = await import('../thread-relay.js');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("ok", name); };

// The three growing versions the phone sent (made up words in the same shape, not his line).
const a = 'Maybe a system that works the way I say send it to the garden thread, but for anyone with a terminal.';
const b = a + ' So having a button, I guess. Not really a button. Because we do the other thing now.';
const c = b + ' The purpose is to promote the best one, but also leave the open source side, so people can build it their own way.';
const other = 'Ask the garden thread to order more seed trays and check the delivery date for the soil.';

await t('a longer version of the same line is the same talk; a different ask is not', () => {
  assert.equal(tr.sameTalk(a, b), true);
  assert.equal(tr.sameTalk(a, c), true);
  assert.equal(tr.sameTalk(a, other), false);
  assert.equal(tr.sameTalk('ok go', 'ok go now'), false, 'too short to judge');
});

await t('sendPlan: merge while waiting, skip or again once sent, new after the window', () => {
  const now = 1_000_000;
  const waiting = { kind: 'send', status: 'queued', created_at: now - 5_000, utterance: a };
  const sent = { ...waiting, status: 'delivered' };
  assert.equal(tr.sendPlan(null, a, now), 'new');
  assert.equal(tr.sendPlan(waiting, b, now), 'merge');
  assert.equal(tr.sendPlan(sent, a + ' Yeah.', now), 'skip');
  assert.equal(tr.sendPlan(sent, c, now), 'again');
  assert.equal(tr.sendPlan(sent, other, now), 'new');
  assert.equal(tr.sendPlan({ ...sent, created_at: now - tr.SAME_TALK_MS - 1 }, c, now), 'new');
  assert.equal(tr.sendPlan({ ...waiting, kind: 'status' }, b, now), 'new');
});

await t('sendOnce on the database: three growing lines make one job holding the longest words', () => {
  const thread = { host: 'test-host', session_id: 'local_test', title: 'Garden' };
  const now = Date.now();
  const r1 = tr.sendOnce({ thread, text: a, utterance: a, device_id: 'phone-x' }, now);
  const r2 = tr.sendOnce({ thread, text: b, utterance: b, device_id: 'phone-x' }, now + 4_000);
  const r3 = tr.sendOnce({ thread, text: c, utterance: c, device_id: 'phone-x' }, now + 9_000);
  assert.deepEqual([r1.plan, r2.plan, r3.plan], ['new', 'merge', 'merge']);
  assert.equal(r3.job.id, r1.job.id);
  assert.equal(tr.getJob(r1.job.id).utterance, c);
  assert.equal(tr.listJobs({ host: 'test-host' }).length, 1);
  const r4 = tr.sendOnce({ thread, text: other, utterance: other, device_id: 'phone-x' }, now + 12_000);
  assert.equal(r4.plan, 'new');
  assert.equal(tr.listJobs({ host: 'test-host' }).length, 2);
});

await t('a held job is not handed to the relay before its time', async () => {
  const thread = { host: 'hold-host', session_id: 'local_hold', title: 'Hold' };
  const j = tr.enqueueJob({ thread, text: 'hello there friend', hold_ms: 60_000 });
  assert.equal(await tr.claimNext('hold-host', 1000), null);
  assert.equal(tr.getJob(j.id).status, 'queued');
});

await t('the yes or no question and its answer', () => {
  const q = tr.sendQuestion('ΠΑΝ', 'when I say send it to the pan thread, how would it know?');
  assert.match(q, /Reply with one word, Yes or No\./);
  assert.match(q, /talking ABOUT sending to the thread/);
  assert.match(q, /he says it "Pan"/);
  assert.equal(tr.wantsSend('Yes'), true);
  assert.equal(tr.wantsSend(' yes.'), true);
  assert.equal(tr.wantsSend('No'), false);
  assert.equal(tr.wantsSend('Yesterday'), false);
  assert.equal(tr.wantsSend(''), false);
});

await t('a thread named mid-line is marked, a line that starts with the ask is not', () => {
  tr.reportThreads('mark-host', [{ session_id: 'local_pan', title: 'ΠΑΝ', last_activity: Date.now() }]);
  const mid = tr.parseThreadCommand('Okay so we could also send that to the pan thread later maybe, I guess');
  const front = tr.parseThreadCommand('Tell the pan thread to check the logs');
  if (mid) assert.equal(mid.via, 'anywhere');
  assert.ok(front && front.kind === 'send' && front.via !== 'anywhere', JSON.stringify(front));
});

console.log(`\n${passed} passed`);
process.exit(0);

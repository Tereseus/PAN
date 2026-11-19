// Which spoken lines become a message to a Claude thread (thread-relay.js parseThreadCommand):
// the ways of asking that were missed in the car on 2026-11-19, and lines that must stay PAN's.
// Runs standalone on a fresh database, no PAN server needed.
// Usage: node service/src/__tests__/thread-relay-parse.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-relay-parse-'));
process.env.PAN_DEV = '1';

const tr = await import('../thread-relay.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

tr.relayHeartbeat('laptop', {});
tr.reportThreads('laptop', [
  { session_id: 'local_1', title: 'PAN', cwd: '', last_activity: Date.now(), pinned: true },
  { session_id: 'local_2', title: 'Map Creation', cwd: '', last_activity: Date.now(), pinned: false },
  { session_id: 'local_3', title: 'Tax Papers', cwd: '', last_activity: Date.now(), pinned: false },
]);
const read = (line) => tr.parseThreadCommand(line, { peek: true });
const sent = (line) => { const r = read(line); return r && r.kind === 'send' ? `${r.thread.title}: ${r.text}` : r ? r.kind : null; };

console.log('thread relay, what a line means');

test('the plain ways still work', () => {
  eq(sent('tell the pan thread it is too slow'), 'PAN: it is too slow', 'tell');
  eq(sent('I need you to send a message to the map creation thread that the river is wrong'), 'Map Creation: the river is wrong', 'send a message');
  eq(sent('ask map creation what it is doing'), 'Map Creation: what it is doing', 'no "thread" word');
});

test('"send another message to <name> that says ..." is a message to that thread', () => {
  eq(sent('Send another message to Pan that says the voice in the car is the wrong one.'), 'PAN: the voice in the car is the wrong one.', 'another');
  eq(sent('send another message to the tax papers thread saying the form is signed'), 'Tax Papers: the form is signed', 'another, with thread');
});

test('a few words first, then the ask', () => {
  eq(sent("I'm stopped. Send another message to Pan that says it is slow."), 'PAN: it is slow.', 'a short sentence first');
  // A line that names its thread with the word "thread" was already sent whole, and still is.
  eq(sent('Okay. Tell the map creation thread the river is wrong.'), 'Map Creation: Okay. Tell the map creation thread the river is wrong.', 'okay first');
});

test('a second ask that starts with also or and', () => {
  eq(sent('Also ask the pan thread why it is slow'), 'PAN: why it is slow', 'also');
  eq(sent('and tell the map creation thread to stop'), 'Map Creation: stop', 'and');
  // With a message sent a moment ago, "ask them" goes to the same thread.
  const job = tr.enqueueJob({ thread: { host: 'laptop', session_id: 'local_1', title: 'PAN' }, text: 'it is too slow', utterance: 'tell the pan thread it is too slow', source: 'test' });
  eq(!!job, true, 'a job to follow up on');
  eq(sent('Also, ask them why the voice sounds the way it sounds.'), 'PAN: why the voice sounds the way it sounds.', 'also, ask them');
});

test('lines that are PAN\'s own stay PAN\'s', () => {
  for (const line of ['tell me a joke', 'also tell me what the weather is', 'Send another message to my wife that says I am late.',
    'I got another message about the pan this morning', 'What did you actually send as a message to Pan?', 'Did you get the messages that it sent to you?',
    'Also, what time is it', 'and then we went home. It was late.']) {
    eq(sent(line), null, line);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

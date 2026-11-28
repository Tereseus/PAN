import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// A data dir of its own, with a two question twin bench in it.
const dir = mkdtempSync(join(tmpdir(), 'pan-smtest-'));
process.env.PAN_DATA_DIR = dir;
writeFileSync(join(dir, 'bench-twin.json'), JSON.stringify({
  today: 'March 5, 2026',
  notes: { projects: [{ name: 'Talisman', summary: 'A made-up project.', facts: ['The battery is 500 mAh.'], qa: [] }], waiting_on_owner: [], owner_waiting_on: [] },
  cases: [
    { id: 'battery', ask: 'How big is the battery?', need: ['500'], wrong: [] },
    { id: 'colour', ask: 'What colour is it?', need: ["don't know|not sure"], wrong: ['red'] },
  ],
}));
const { startTest, testState, ownLine, scoreReply, testMinutes } = await import('../smart-model-test.js');
globalThis.__panLastVoiceAt = 0;

test('a reply is right when it has every needed part and nothing wrong', () => {
  assert.equal(scoreReply({ need: ['500'], wrong: [] }, 'It is 500 mAh.'), true);
  assert.equal(scoreReply({ need: ['500'], wrong: [] }, 'It is 400 mAh.'), false);
  assert.equal(scoreReply({ need: ["don't know"], wrong: ['red'] }, "I don't know, maybe red."), false);
  assert.equal(scoreReply({ need: ['500'] }, ''), false);
});

test('a test runs the twin bench with the one choice, keeps the result and says it', async () => {
  const asked = [];
  async function* ask(prompt, opts) {
    asked.push(opts.chain);
    assert.match(prompt, /Today is March 5, 2026/);
    assert.match(prompt, /PROJECT: Talisman/);
    yield /battery/.test(prompt) ? 'It is 500 mAh.' : 'It is red.';
  }
  assert.equal(ownLine('x:model'), '');
  const r = startTest('x:model', { ask });
  assert.deepEqual(r, { ok: true, of: 2 });
  // one at a time
  assert.equal(startTest('y:model', { ask }).error, 'busy');
  for (let i = 0; i < 50 && !testState().finished; i++) await new Promise((res) => setTimeout(res, 20));
  const s = testState();
  assert.equal(s.finished, true);
  assert.equal(s.right, 1);
  assert.deepEqual(asked, [['x:model'], ['x:model']]);
  assert.match(ownLine('x:model'), /^Your test: 1 of 2 right, about [\d.]+ s an answer, [A-Z][a-z]{2} \d+\.$/);
});

test('how long a test takes comes from our reference time', () => {
  assert.equal(testMinutes('a', { models: { a: { whole_s: 6.5 } } }), 1);
  assert.equal(testMinutes('b', { models: { b: { whole_s: 60 } } }), 2);
  assert.equal(testMinutes('c', null), 1);
});

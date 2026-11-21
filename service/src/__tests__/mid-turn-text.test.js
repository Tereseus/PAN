// Mid-turn assistant text (hooks/mid-turn-text.js): what the Stop command hook pulls
// out of a transcript, the size caps, and the hub's dedupe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { midTurnBlocks, capBlocks, dropSeenBlocks, turnTextData, LIMITS } from '../hooks/mid-turn-text.js';

const user = (text, extra = {}) => JSON.stringify({ type: 'user', uuid: 'u-' + text.slice(0, 5), message: { role: 'user', content: text }, ...extra });
const toolResult = (id) => JSON.stringify({ type: 'user', uuid: 'tr-' + id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'secret tool output 12345' }] } });
const say = (uuid, msgId, text) => JSON.stringify({ type: 'assistant', uuid, message: { id: msgId, role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (uuid, msgId, id) => JSON.stringify({ type: 'assistant', uuid, message: { id: msgId, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'curl http://router/secret' } }] } });
const think = (uuid, msgId) => JSON.stringify({ type: 'assistant', uuid, message: { id: msgId, role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning that must never be stored' }] } });

const FINAL = 'KVM block: done. The router now refuses anything from the KVM.';
const transcript = [
  user('earlier question about something else'),
  say('a0', 'm0', 'An earlier turn answer that is long enough to count.'),
  user('Unbind the KVM from GoodCloud and block it at the router'),
  think('a1', 'm1'),
  say('a2', 'm1', 'Checking the KVM cloud settings first, then the router.'),
  tool('a3', 'm1', 't1'),
  toolResult('t1'),
  say('a4', 'm2', "The KVM is unbound, but it isn't fully local yet."),
  tool('a5', 'm2', 't2'),
  toolResult('t2'),
  say('a6', 'm3', 'ok'),
  tool('a7', 'm3', 't3'),
  toolResult('t3'),
  JSON.stringify({ type: 'system', content: 'hook ran' }),
  'not json at all {',
  say('a8', 'm4', FINAL),
];

test('takes this turn only, text only, without the final message', () => {
  const blocks = midTurnBlocks(transcript, { lastAssistantMessage: FINAL });
  assert.deepEqual(blocks, [
    { uuid: 'a2', text: 'Checking the KVM cloud settings first, then the router.' },
    { uuid: 'a4', text: "The KVM is unbound, but it isn't fully local yet." },
    { uuid: 'a6', text: 'ok' },
  ]);
  const all = JSON.stringify(blocks);
  assert.ok(!all.includes('secret'), 'no tool input or output');
  assert.ok(!all.includes('private reasoning'), 'no thinking');
});

test('without last_assistant_message the last text message is dropped', () => {
  const blocks = midTurnBlocks(transcript);
  assert.deepEqual(blocks.map((b) => b.uuid), ['a2', 'a4', 'a6']);
});

test('a final message not yet flushed to the transcript drops nothing else', () => {
  const blocks = midTurnBlocks(transcript.slice(0, -1), { lastAssistantMessage: FINAL });
  assert.deepEqual(blocks.map((b) => b.uuid), ['a2', 'a4', 'a6']);
});

test('injected meta and sidechain entries do not start a turn or count', () => {
  const lines = [
    ...transcript.slice(0, -1),
    user('<system-reminder>meta</system-reminder>', { isMeta: true }),
    JSON.stringify({ type: 'assistant', uuid: 's1', isSidechain: true, message: { id: 'sx', content: [{ type: 'text', text: 'subagent text that is long enough' }] } }),
    say('a8', 'm4', FINAL),
  ];
  assert.deepEqual(midTurnBlocks(lines, { lastAssistantMessage: FINAL }).map((b) => b.uuid), ['a2', 'a4', 'a6']);
});

test('a turn with only the final message has nothing mid-turn', () => {
  assert.deepEqual(midTurnBlocks([user('hello there'), say('x', 'm', FINAL)], { lastAssistantMessage: FINAL }), []);
  assert.deepEqual(midTurnBlocks([], {}), []);
});

test('caps: short blocks skipped, long ones cut, latest kept when over the total', () => {
  const capped = capBlocks(midTurnBlocks(transcript, { lastAssistantMessage: FINAL }));
  assert.deepEqual(capped.map((b) => b.uuid), ['a2', 'a4']);   // 'ok' is too short

  const long = 'x'.repeat(5000);
  const [one] = capBlocks([{ uuid: 'l', text: long }]);
  assert.equal(one.text.length, LIMITS.maxBlock);
  assert.ok(one.text.endsWith('…'));

  const many = Array.from({ length: 10 }, (_, i) => ({ uuid: 'b' + i, text: String(i).repeat(700) }));
  const kept = capBlocks(many);
  const joined = turnTextData(kept).text;
  assert.ok(joined.length <= LIMITS.maxTotal, `joined ${joined.length}`);
  assert.equal(kept.at(-1).uuid, 'b9');
  assert.equal(kept[0].uuid, 'b8');

  assert.equal(capBlocks(Array.from({ length: 40 }, (_, i) => ({ uuid: 'c' + i, text: 'a block of text number ' + i }))).length, LIMITS.maxBlocks);
});

test('the hub drops blocks it already holds', () => {
  const blocks = [
    { uuid: 'a2', text: 'Checking the KVM cloud settings first, then the router.' },
    { uuid: 'a4', text: "The KVM is unbound, but it isn't fully local yet." },
    { uuid: 'zz', text: 'Earlier  final reply of this same turn.' },
  ];
  const recent = [
    { event_type: 'AssistantTurnText', data: JSON.stringify(turnTextData([blocks[0]])) },
    { event_type: 'Stop', data: JSON.stringify({ last_assistant_message: 'Earlier final reply of this same turn.' }) },
    { event_type: 'Stop', data: 'garbage' },
  ];
  assert.deepEqual(dropSeenBlocks(blocks, recent).map((b) => b.uuid), ['a4']);
});

test('stored row: joined text, uuids, no duplicate copy of the blocks', () => {
  const d = turnTextData([{ uuid: 'a', text: 'one block here' }, { uuid: null, text: 'two block here' }], '/x');
  assert.deepEqual(d, { text: 'one block here\n\ntwo block here', count: 2, transcript_uuids: ['a'], cwd: '/x' });
});

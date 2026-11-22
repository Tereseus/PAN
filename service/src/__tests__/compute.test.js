import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHardware, machineForUrl, isAllowed, tokensPerSecond, modelToTime, keepAliveFor, machineList, placeUse, chipsLine } from '../compute.js';

const mint = { id: 'box-linux', name: 'linux box', online: true, tailscale_ip: '100.1.2.3',
  hardware: cleanHardware({ gpus: [{ name: 'NVIDIA GeForce RTX 3050', vram_mb: 8192 }], cpu: 'Ryzen 7', cores: 16, ram_gb: 64, ips: ['192.168.0.20'] }) };
const hub = { id: 'hub-pc', name: 'hub-pc', online: true, hardware: cleanHardware({ cpu: 'Intel N100', cores: 4, ram_gb: 16, npus: [], ips: ['192.168.0.10'] }) };
const bridge = { id: 'chat-bridge', name: 'Chat bridge', online: true, hardware: null };

test('cleanHardware keeps the shown fields, caps them, and drops an empty report', () => {
  assert.equal(cleanHardware(null), null);
  assert.equal(cleanHardware({ gpus: [], npus: [] }), null);
  const hw = cleanHardware({ gpus: [{ name: '  RTX   3050 ', vram_mb: '8192' }, { name: '' }], npus: ['Intel AI Boost'], ips: ['192.168.0.5', 'not an ip; rm'], cpu: 'x'.repeat(200) });
  assert.deepEqual(hw.gpus, [{ name: 'RTX 3050', vram_mb: 8192 }]);
  assert.deepEqual(hw.npus, ['Intel AI Boost']);
  assert.deepEqual(hw.ips, ['192.168.0.5']);
  assert.equal(hw.cpu.length, 80);
});

test('machineForUrl finds the machine by id, tailscale address, home address, or this computer', () => {
  const ms = [mint, hub];
  assert.equal(machineForUrl(ms, 'http://box-linux:11434', 'hub-pc'), 'box-linux');
  assert.equal(machineForUrl(ms, 'http://box-linux.tail1234.ts.net:11434', 'hub-pc'), 'box-linux');
  assert.equal(machineForUrl(ms, 'http://100.1.2.3:11434', 'hub-pc'), 'box-linux');
  assert.equal(machineForUrl(ms, 'http://192.168.0.10:11434', 'hub-pc'), 'hub-pc');
  assert.equal(machineForUrl(ms, 'http://localhost:11434', 'hub-pc'), 'hub-pc');
  assert.equal(machineForUrl(ms, 'http://10.9.9.9:11434', 'hub-pc'), '');
  assert.equal(machineForUrl(ms, 'not a url', 'hub-pc'), '');
});

test('isAllowed: the hub always, the shared card by its own switch, others until turned off', () => {
  const sw = { hubId: 'hub-pc', allowedMap: { other: false }, shareId: 'box-linux', shareAllowed: false };
  assert.equal(isAllowed('hub-pc', { ...sw, allowedMap: { 'hub-pc': false } }), true);
  assert.equal(isAllowed('box-linux', sw), false);
  assert.equal(isAllowed('box-linux', { ...sw, shareAllowed: true }), true);
  assert.equal(isAllowed('box-linux', { ...sw, shareAllowed: false, allowedMap: { 'box-linux': true } }), false, 'his WoE switch wins for the shared card');
  assert.equal(isAllowed('other', sw), false);
  assert.equal(isAllowed('new-pc', sw), true);
});

test('tokensPerSecond from an Ollama reply', () => {
  assert.equal(tokensPerSecond({ eval_count: 64, eval_duration: 853_333_333 }), 75);
  assert.equal(tokensPerSecond({ eval_count: 0, eval_duration: 5 }), 0);
  assert.equal(tokensPerSecond({}), 0);
});

test('modelToTime prefers the answer model when loaded, never loads a new one when something is loaded', () => {
  assert.equal(modelToTime({ answerModel: 'ollama:pan-phi-r1:latest', loaded: ['x:1', 'pan-phi-r1:latest'] }), 'pan-phi-r1:latest');
  assert.equal(modelToTime({ answerModel: 'ollama:pan-phi-r1:latest', loaded: ['x:1'], installed: ['pan-phi-r1:latest'] }), 'x:1');
  assert.equal(modelToTime({ answerModel: 'ollama:pan-phi-r1', loaded: [], installed: ['pan-phi-r1:latest'] }), 'pan-phi-r1');
  assert.equal(modelToTime({ answerModel: 'ollama:pan-phi-r1', loaded: [], installed: ['other'] }), '');
});

test('keepAliveFor keeps a model loaded forever, leaves others to Ollama', () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  assert.equal(keepAliveFor('2318-01-01T00:00:00Z', now), -1);
  assert.equal(keepAliveFor('2026-11-22T10:05:00Z', now), undefined);
  assert.equal(keepAliveFor('', now), undefined);
});

test('machineList: hub first, bridges left out, jobs placed, a switched off machine hands its job to the hub', () => {
  const uses = [{ what: 'Answer model', model: 'ollama:pan-phi-r1:latest', pinnedUrl: 'http://box-linux:11434', defaultUrl: 'http://192.168.0.10:11434' },
    { what: 'Voice reader', model: 'reader:syrinx', pinnedUrl: '', defaultUrl: 'http://192.168.0.10:11434' }];
  const ollama = { 'hub-pc': { loaded: [] }, 'box-linux': { loaded: [{ name: 'pan-phi-r1:latest' }] } };
  const on = machineList({ devices: [bridge, mint, hub], hubId: 'hub-pc', ollama, uses,
    switches: { shareId: 'box-linux', shareAllowed: true }, speeds: { 'box-linux': { tok_s: 75, model: 'pan-phi-r1:latest' } } });
  assert.deepEqual(on.map(m => m.id), ['hub-pc', 'box-linux']);
  assert.deepEqual(on[1].runs, [{ what: 'Answer model', model: 'ollama:pan-phi-r1:latest', note: 'the hub takes over if linux box is off' }]);
  assert.deepEqual(on[0].runs.map(r => r.what), ['Voice reader']);
  assert.equal(on[1].chips, 'NVIDIA GeForce RTX 3050 8 GB · Ryzen 7, 16 threads, 64 GB memory');

  const off = machineList({ devices: [mint, hub], hubId: 'hub-pc', ollama, uses, switches: { shareId: 'box-linux', shareAllowed: false } });
  assert.equal(off[1].allowed, false);
  assert.deepEqual(off[1].runs, []);
  assert.deepEqual(off[0].runs.map(r => [r.what, r.note]), [['Answer model', 'linux box is switched off'], ['Voice reader', '']]);
});

test('placeUse: an offline machine hands its job to the hub', () => {
  const ms = [{ ...hub, hub: true, allowed: true }, { ...mint, hub: false, allowed: true, online: false }];
  assert.equal(placeUse(ms, { pinnedUrl: 'http://box-linux:11434' }, 'hub-pc').note, 'linux box is offline');
});

test('chipsLine with an AI chip and no graphics card', () => {
  assert.equal(chipsLine(cleanHardware({ npus: ['Intel AI Boost'], cpu: 'Core Ultra 7', ram_gb: 32 })), 'Intel AI Boost · Core Ultra 7, 32 GB memory');
});

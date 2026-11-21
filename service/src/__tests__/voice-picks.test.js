import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceTimes, pickChoices } from '../voice-picks.js';

const line = (dev, first, total) => ({ device_id: dev, message: `Stream (first=${first}ms total=${total}ms) up=10KB/200ms: ` });

test('deviceTimes uses the total, never the first word', () => {
  const rows = [line('car', 2700, 4000), line('car', 100, 6000), line('car', 900, 5000), { device_id: 'car', message: 'Heard: hi' }];
  assert.deepEqual(deviceTimes(rows), [{ device: 'car', turns: 3, avg_total_ms: 5000, median_total_ms: 5000, slowest_ms: 6000 }]);
});

test('deviceTimes keeps only the newest turns per device, and splits devices', () => {
  const rows = [line('a', 1, 1000), line('a', 1, 3000), line('a', 1, 99000), line('b', 1, 2000)];
  const out = deviceTimes(rows, 2);
  assert.deepEqual(out.find(d => d.device === 'a'), { device: 'a', turns: 2, avg_total_ms: 2000, median_total_ms: 2000, slowest_ms: 3000 });
  assert.equal(out.find(d => d.device === 'b').turns, 1);
});

test('deviceTimes skips rows with no device or no stream line', () => {
  assert.deepEqual(deviceTimes([{ message: 'Stream (first=1ms total=2ms)' }, { device_id: 'x', message: 'nothing' }]), []);
  assert.deepEqual(deviceTimes(null), []);
});

test('pickChoices lists chat models with their setting prefix and leaves out embedding and photo models', () => {
  const c = pickChoices(['pan-phi-r1:latest', 'qwen3-embedding:0.6b', 'moondream:latest'], { 'qwen3.5:9b': 'http://mint:11434' });
  assert.deepEqual(c.voice_world_model, ['ollama:pan-phi-r1:latest', 'ollama:qwen3.5:9b']);
  assert.deepEqual(c.voice_student_model, ['reader:pan-phi-r1:latest', 'reader:qwen3.5:9b']);
});

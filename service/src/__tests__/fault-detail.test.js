// Fault report details keep nothing of the person's (fault-detail.js). Standalone, no server.
// Usage: node service/src/__tests__/fault-detail.test.js
import assert from 'assert';
import { plainDetail } from '../fault-detail.js';

const cases = [
  ['ollama 500: model "pan-gemma" failed', 'ollama 500: model … failed'],
  ["Claude said 'my wife Anna' bad", 'Claude said … bad'],
  ['fetch failed http://10.0.0.5:11434/api/chat', 'fetch failed …'],
  ['cannot open C:\\Users\\someone\\notes.txt now', 'cannot open … now'],
  ['cannot open /home/someone/notes.txt now', 'cannot open … now'],
  ['connect ECONNREFUSED 192.168.1.40:7781', 'connect ECONNREFUSED …:7781'],
  ['timeout > 60000ms', 'timeout > 60000ms'],
  ['body {"text":"what about my doctor"} rejected', 'body … rejected'],
];
let ok = 0;
for (const [i, want] of cases) {
  const got = plainDetail(i);
  try { assert.strictEqual(got, want); ok++; } catch { console.log('FAIL', JSON.stringify(i), '->', JSON.stringify(got), 'want', JSON.stringify(want)); }
}
assert.ok(plainDetail('x'.repeat(500)).length <= 160);
console.log(`fault-detail: ${ok} of ${cases.length} pass`);
if (ok !== cases.length) process.exit(1);

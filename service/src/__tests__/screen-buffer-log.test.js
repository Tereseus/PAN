// Tests for ScreenBuffer append-only log system
import { ScreenBuffer } from '../screen-buffer.js';

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('ScreenBuffer Log Tests\n');

test('Log accumulates on scroll-up', () => {
  const buf = new ScreenBuffer(80, 5);
  // Write 10 lines — first 5 fill screen, next 5 cause scroll-ups
  // The trailing \n after line 9 causes one extra scroll, so 6 total
  for (let i = 0; i < 10; i++) {
    buf.write(`line ${i}\n`);
  }
  assert(buf.log.length === 6, `Expected 6 log entries, got ${buf.log.length}`);
  assert(buf.log[0].html.includes('line 0'), 'First log entry should be "line 0"');
  assert(buf.log[0].seq === 0, 'First seq should be 0');
});

test('Scrollback and log grow in parallel', () => {
  const buf = new ScreenBuffer(80, 5);
  for (let i = 0; i < 10; i++) {
    buf.write(`line ${i}\n`);
  }
  assert(buf.scrollback.length === buf.log.length, 'Scrollback and log should have same length');
  assert(buf.scrollback[0] === buf.log[0].html, 'Scrollback and log content should match');
});

test('Alt screen does not pollute log', () => {
  const buf = new ScreenBuffer(80, 5);
  // Write some lines to main screen
  for (let i = 0; i < 8; i++) buf.write(`main ${i}\n`);
  const logBefore = buf.log.length;

  // Switch to alt screen
  buf.write('\x1b[?1049h');
  // Write lots of lines in alt screen (should cause scroll-ups but NOT log entries)
  for (let i = 0; i < 20; i++) buf.write(`alt ${i}\n`);
  const logDuring = buf.log.length;

  // Switch back
  buf.write('\x1b[?1049l');
  assert(logDuring === logBefore, `Log should not grow during alt screen: was ${logBefore}, now ${logDuring}`);
  // Verify no alt screen content in log
  for (const entry of buf.log) {
    assert(!entry.html.includes('alt '), `Log should not contain alt screen content: ${entry.html}`);
  }
});

test('getLogSince returns correct incremental slices', () => {
  const buf = new ScreenBuffer(80, 3);
  for (let i = 0; i < 50; i++) buf.write(`line ${i}\n`);

  const full = buf.getLogSince(0);
  assert(full.lines.length === buf.log.length, 'getLogSince(0) should return all entries');

  const mid = buf.getLogSince(Math.floor(buf.logSeq / 2));
  assert(mid.lines.length < full.lines.length, 'Partial slice should be smaller');
  assert(mid.lines.length > 0, 'Partial slice should not be empty');

  const future = buf.getLogSince(buf.logSeq + 100);
  assert(future.lines.length === 0, 'Future seq should return empty');
});

test('Log survives screen corruption', () => {
  const buf = new ScreenBuffer(80, 5);
  for (let i = 0; i < 10; i++) buf.write(`safe ${i}\n`);
  const logSnapshot = buf.log.map(e => e.html);

  // Simulate corruption: mess up scroll region
  buf.scrollTop = 99;
  buf.scrollBottom = -1;
  buf.cy = 999;

  // Log entries should be untouched
  assert(buf.log.length === logSnapshot.length, 'Log length should not change');
  for (let i = 0; i < logSnapshot.length; i++) {
    assert(buf.log[i].html === logSnapshot[i], `Log entry ${i} should be unchanged`);
  }
});

test('Resize pushes displaced lines to log', () => {
  const buf = new ScreenBuffer(80, 10);
  for (let i = 0; i < 10; i++) buf.write(`row ${i}\n`);
  const logBefore = buf.log.length;

  // Shrink to 5 rows — 5 lines should be displaced
  buf.resize(80, 5);
  assert(buf.log.length > logBefore, `Log should grow on resize: was ${logBefore}, now ${buf.log.length}`);
});

test('isAltScreen getter works', () => {
  const buf = new ScreenBuffer(80, 5);
  assert(!buf.isAltScreen, 'Should not be alt screen initially');
  buf.write('\x1b[?1049h');
  assert(buf.isAltScreen, 'Should be alt screen after switch');
  buf.write('\x1b[?1049l');
  assert(!buf.isAltScreen, 'Should not be alt screen after exit');
});

test('Log respects maxLog cap', () => {
  const buf = new ScreenBuffer(80, 2);
  buf.maxLog = 10;
  for (let i = 0; i < 50; i++) buf.write(`line ${i}\n`);
  assert(buf.log.length <= 10, `Log should be capped at 10, got ${buf.log.length}`);
  // First entry should NOT be seq 0 (it was shifted out)
  assert(buf.log[0].seq > 0, 'Oldest entry should have been shifted');
});

console.log('\nDone.');

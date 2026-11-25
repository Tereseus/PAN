// pan-client's Ollama watchdog decision: when it may start `ollama serve`, and
// which address it asks. Runs standalone, no server or Ollama needed.
// Usage: node service/src/__tests__/pan-client-ollama.test.js
//
// pan-client.js is downloaded to machines as one file, so the decision cannot
// live in its own module. The test cuts the marked pure block out of the file
// and runs it alone; if the block ever reaches for an import, this fails.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../../pan-client/pan-client.js'), 'utf8');
const begin = src.indexOf('// ── Ollama watchdog decision (pure) ── BEGIN');
const end = src.indexOf('// ── Ollama watchdog decision (pure) ── END');
if (begin < 0 || end < 0) { console.log('✗ pure block markers not found in pan-client.js'); process.exit(1); }
const block = src.slice(begin, end);
const { ollamaBaseFromHost, parseSystemdShow, decideOllamaWatchdog } =
  new Function(`"use strict";\n${block}\nreturn { ollamaBaseFromHost, parseSystemdShow, decideOllamaWatchdog };`)();

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// Placeholder addresses only (100.64.0.0/10 is the shared range tailnets use).
const TAILNET = '100.64.0.10';

// What `systemctl show ollama.service --property=...` prints.
const showText = ({ load = 'loaded', file = 'enabled', active = 'active', env = '' } = {}) =>
  `LoadState=${load}\nUnitFileState=${file}\nActiveState=${active}\nEnvironment=${env}\n`;

console.log('ollamaBaseFromHost');
test('empty is the local default', () => eq(ollamaBaseFromHost(''), 'http://127.0.0.1:11434', 'base'));
test('undefined is the local default', () => eq(ollamaBaseFromHost(undefined), 'http://127.0.0.1:11434', 'base'));
test('host:port', () => eq(ollamaBaseFromHost(`${TAILNET}:11434`), `http://${TAILNET}:11434`, 'base'));
test('host alone gets 11434', () => eq(ollamaBaseFromHost(TAILNET), `http://${TAILNET}:11434`, 'base'));
test('0.0.0.0 is asked on 127.0.0.1', () => eq(ollamaBaseFromHost('0.0.0.0:11434'), 'http://127.0.0.1:11434', 'base'));
test(':port alone', () => eq(ollamaBaseFromHost(':11500'), 'http://127.0.0.1:11500', 'base'));
test('[::]:port listen everywhere', () => eq(ollamaBaseFromHost('[::]:11434'), 'http://127.0.0.1:11434', 'base'));
test('bracketed IPv6', () => eq(ollamaBaseFromHost('[fd7a::1]:11434'), 'http://[fd7a::1]:11434', 'base'));
test('bare IPv6', () => eq(ollamaBaseFromHost('fd7a::1'), 'http://[fd7a::1]:11434', 'base'));
test('http:// with port', () => eq(ollamaBaseFromHost(`http://${TAILNET}:11434`), `http://${TAILNET}:11434`, 'base'));
test('http:// without port is 80 (as Ollama reads it)', () => eq(ollamaBaseFromHost('http://ollama.example'), 'http://ollama.example:80', 'base'));
test('https:// without port is 443', () => eq(ollamaBaseFromHost('https://ollama.example'), 'https://ollama.example:443', 'base'));
test('quotes and a trailing path are dropped', () => eq(ollamaBaseFromHost(`"${TAILNET}:11434/"`), `http://${TAILNET}:11434`, 'base'));

console.log('parseSystemdShow');
test('keys and one env var', () => {
  const u = parseSystemdShow(showText({ env: `OLLAMA_HOST=${TAILNET}:11434` }));
  eq([u.LoadState, u.UnitFileState, u.ActiveState, u.env.OLLAMA_HOST], ['loaded', 'enabled', 'active', `${TAILNET}:11434`], 'parsed');
});
test('several env vars, one quoted with spaces', () => {
  const u = parseSystemdShow(showText({ env: `"PATH=/usr/bin:/bin" OLLAMA_HOST=${TAILNET}:11434 "OLLAMA_ORIGINS=a b"` }));
  eq(u.env, { PATH: '/usr/bin:/bin', OLLAMA_HOST: `${TAILNET}:11434`, OLLAMA_ORIGINS: 'a b' }, 'env');
});
test('CRLF and junk lines', () => eq(parseSystemdShow('LoadState=loaded\r\n\r\nnoequals\r\n').LoadState, 'loaded', 'LoadState'));
test('unit that does not exist', () => {
  const u = parseSystemdShow(showText({ load: 'not-found', file: '', active: 'inactive' }));
  eq([u.LoadState, u.env], ['not-found', {}], 'parsed');
});

console.log('decideOllamaWatchdog');
const linux = (unitOpts, more = {}) => decideOllamaWatchdog({
  platform: 'linux', flagOn: true, processHost: undefined,
  unit: unitOpts === null ? null : parseSystemdShow(showText(unitOpts)), ...more,
});

test('the Nov 21 case: enabled systemd unit on a tailnet address -> no restart, probe the tailnet address', () => {
  const d = linux({ env: `OLLAMA_HOST=${TAILNET}:11434` });
  eq([d.restart, d.systemd, d.base, d.pullModels], [false, true, `http://${TAILNET}:11434`, true], 'decision');
});
test('enabled unit that is down right now: still no restart (systemd brings it back)', () => {
  const d = linux({ active: 'failed', env: `OLLAMA_HOST=${TAILNET}:11434` });
  eq([d.restart, d.systemd], [false, true], 'decision');
});
test('enabled unit with no OLLAMA_HOST -> local default', () => {
  const d = linux({});
  eq([d.restart, d.base], [false, 'http://127.0.0.1:11434'], 'decision');
});
test('enabled-runtime counts as enabled', () => eq(linux({ file: 'enabled-runtime', active: 'inactive' }).systemd, true, 'systemd'));
test('disabled but running under systemd -> hands off', () => eq(linux({ file: 'disabled', active: 'active' }).restart, false, 'restart'));
test('disabled and stopped -> watchdog runs, unit address not used', () => {
  const d = linux({ file: 'disabled', active: 'inactive', env: `OLLAMA_HOST=${TAILNET}:11434` });
  eq([d.restart, d.systemd, d.base], [true, false, 'http://127.0.0.1:11434'], 'decision');
});
test('no such unit -> watchdog runs on the local default', () => {
  const d = linux({ load: 'not-found', file: '', active: 'inactive' });
  eq([d.restart, d.systemd, d.base], [true, false, 'http://127.0.0.1:11434'], 'decision');
});
test('no systemd at all (macOS) -> watchdog runs', () => {
  const d = decideOllamaWatchdog({ platform: 'darwin', flagOn: true, unit: null });
  eq([d.restart, d.systemd], [true, false], 'decision');
});
test('no unit: this process OLLAMA_HOST is the address its own serve binds', () => {
  const d = linux(null, { processHost: '0.0.0.0:11500' });
  eq([d.restart, d.base], [true, 'http://127.0.0.1:11500'], 'decision');
});
test('Windows ignores any unit', () => {
  const d = decideOllamaWatchdog({ platform: 'win32', flagOn: true, unit: parseSystemdShow(showText({ env: `OLLAMA_HOST=${TAILNET}:11434` })) });
  eq([d.restart, d.systemd, d.base], [true, false, 'http://127.0.0.1:11434'], 'decision');
});
test('config off -> no restart and no pulls, still probes the right address', () => {
  const d = linux({ env: `OLLAMA_HOST=${TAILNET}:11434` }, { flagOn: false });
  eq([d.restart, d.pullModels, d.base], [false, false, `http://${TAILNET}:11434`], 'decision');
});
test('config off, no unit -> nothing runs', () => {
  const d = linux(null, { flagOn: false });
  eq([d.restart, d.pullModels], [false, false], 'decision');
});
test('reason says why', () => {
  if (!/systemd/.test(linux({}).reason)) throw new Error('systemd reason missing');
  if (!/config/.test(linux(null, { flagOn: false }).reason)) throw new Error('config reason missing');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

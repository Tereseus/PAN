// Platform utility unit tests — runs standalone, no server needed
// Usage: node service/src/__tests__/platform.test.js

import {
  platform, isWindows, isLinux, isMac,
  getDataDir, getConfigDir, getTempDir, getHomeDir, getDesktopDir,
  getRecordingsDir, getTerminalLogDir, getClaudeCmd, getShell,
  killProcess, killProcessOnPort, listProcesses,
  detectMode, normalizePath, toNativePath, ensureDataDirs
} from '../platform.js';

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

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

console.log('\n=== Platform Detection ===');

test('platform is a string', () => {
  assert(typeof platform === 'string', `got ${typeof platform}`);
  assert(['win32', 'linux', 'darwin'].includes(platform), `unexpected: ${platform}`);
});

test('exactly one of isWindows/isLinux/isMac is true', () => {
  const count = [isWindows, isLinux, isMac].filter(Boolean).length;
  assert(count === 1, `${count} platforms detected`);
});

test('platform matches boolean flags', () => {
  if (platform === 'win32') assert(isWindows);
  if (platform === 'linux') assert(isLinux);
  if (platform === 'darwin') assert(isMac);
});

console.log('\n=== Directory Paths ===');

test('getDataDir returns non-empty string', () => {
  const dir = getDataDir();
  assert(typeof dir === 'string' && dir.length > 5, `got: ${dir}`);
  if (isWindows) assert(dir.includes('PAN'), `Windows data dir should contain PAN: ${dir}`);
  if (isLinux) assert(dir.includes('pan'), `Linux data dir should contain pan: ${dir}`);
});

test('getConfigDir returns non-empty string', () => {
  const dir = getConfigDir();
  assert(typeof dir === 'string' && dir.length > 5, `got: ${dir}`);
});

test('getTempDir returns non-empty string', () => {
  const dir = getTempDir();
  assert(typeof dir === 'string' && dir.length > 1, `got: ${dir}`);
});

test('getHomeDir returns non-empty string', () => {
  const dir = getHomeDir();
  assert(typeof dir === 'string' && dir.length > 1, `got: ${dir}`);
});

test('getDesktopDir contains Desktop', () => {
  const dir = getDesktopDir();
  assert(dir.toLowerCase().includes('desktop'), `got: ${dir}`);
});

test('getRecordingsDir is under data dir', () => {
  const rec = getRecordingsDir();
  const data = getDataDir();
  assert(rec.startsWith(data.substring(0, data.length - 5)), `recordings not under data: ${rec}`);
});

test('getTerminalLogDir is under data dir', () => {
  const logs = getTerminalLogDir();
  const data = getDataDir();
  assert(logs.startsWith(data.substring(0, data.length - 5)), `logs not under data: ${logs}`);
});

test('getClaudeCmd returns a path or command', () => {
  const cmd = getClaudeCmd();
  assert(typeof cmd === 'string' && cmd.length > 0, `got: ${cmd}`);
  if (isWindows) assert(cmd.includes('claude'), `should contain claude: ${cmd}`);
  if (isLinux) assert(cmd === 'claude', `Linux should be 'claude': ${cmd}`);
});

console.log('\n=== Shell Detection ===');

test('getShell returns shell and args', () => {
  const { shell, args } = getShell();
  assert(typeof shell === 'string' && shell.length > 0, `empty shell`);
  assert(Array.isArray(args), `args should be array`);
  if (isWindows) assert(shell.includes('bash') || shell.includes('powershell'), `unexpected: ${shell}`);
  if (isLinux) assert(shell.startsWith('/'), `Linux shell should be absolute: ${shell}`);
});

console.log('\n=== Mode Detection ===');

test('detectMode returns user or service', () => {
  const mode = detectMode();
  assert(mode === 'user' || mode === 'service', `unexpected mode: ${mode}`);
});

console.log('\n=== Path Normalization ===');

test('normalizePath converts backslashes to forward slashes', () => {
  assert(normalizePath('C:\\Users\\test') === 'C:/Users/test');
  assert(normalizePath('C:/Users/test') === 'C:/Users/test');
  assert(normalizePath('') === '');
});

test('normalizePath strips trailing slash', () => {
  assert(normalizePath('C:/Users/test/') === 'C:/Users/test');
  assert(normalizePath('C:\\Users\\test\\') === 'C:/Users/test');
});

test('toNativePath converts to OS separators', () => {
  if (isWindows) {
    assert(toNativePath('C:/Users/test') === 'C:\\Users\\test');
  } else {
    assert(toNativePath('C:\\Users\\test') === 'C:/Users/test');
  }
});

console.log('\n=== Process Management ===');

test('killProcess returns false for invalid PID', () => {
  assert(killProcess(0) === false, 'PID 0 should fail');
  assert(killProcess(null) === false, 'null PID should fail');
});

test('killProcess refuses to kill own process', () => {
  assert(killProcess(process.pid) === false, 'should not kill self');
});

test('listProcesses returns array', async () => {
  const procs = await listProcesses(['node']);
  assert(Array.isArray(procs), 'should return array');
  assert(procs.length > 0, 'should find at least this node process');
  assert(procs[0].pid && procs[0].name, 'process should have pid and name');
});

console.log('\n=== ensureDataDirs ===');

test('ensureDataDirs creates directories without error', () => {
  ensureDataDirs(); // should not throw
});

// Async tests need to be awaited
const asyncTests = [];

asyncTests.push((async () => {
  console.log('\n=== Async Tests ===');

  try {
    const procs = await listProcesses(['node']);
    assert(Array.isArray(procs), 'should return array');
    assert(procs.length > 0, 'should find at least this node process');
    assert(procs[0].pid && procs[0].name, 'process should have pid and name');
    passed++;
    console.log('  ✓ listProcesses finds node processes');
  } catch (err) {
    failed++;
    console.log(`  ✗ listProcesses finds node processes: ${err.message}`);
  }

  try {
    const killed = await killProcessOnPort(99999); // unused port
    assert(killed.size === 0, 'should kill nothing on unused port');
    passed++;
    console.log('  ✓ killProcessOnPort handles unused port gracefully');
  } catch (err) {
    failed++;
    console.log(`  ✗ killProcessOnPort handles unused port: ${err.message}`);
  }
})());

Promise.all(asyncTests).then(() => {
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
});

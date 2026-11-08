// Where the stdio MCP servers look for PAN (mcp/pan-address.js). Runs standalone, no server needed.
// Usage: node service/src/__tests__/pan-address.test.js

import { panBaseUrl, linkClientState, LINK_CLIENT_URL, LOCAL_PAN_URL } from '../mcp/pan-address.js';

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
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// A computer with these files and nothing else.
const only = (...files) => (p) => files.includes(p);
const win = { platform: 'win32', home: 'C:\\Users\\someone', env: { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' } };
const linux = { platform: 'linux', home: '/home/someone', env: {} };
const winState = 'C:\\Users\\someone\\AppData\\Local\\PAN\\link-client\\client.json';
const linuxState = '/home/someone/.local/share/pan/link-client/client.json';

console.log('pan-address');

test('the link client state is where the installers put it', () => {
  eq(linkClientState(win), winState, 'Windows');
  eq(linkClientState(linux), linuxState, 'Linux');
  eq(linkClientState({ ...win, env: {} }), winState, 'Windows without LOCALAPPDATA');
});

test('a computer paired with PAN Link uses the link', () => {
  eq(panBaseUrl({ ...win, exists: only(winState) }), LINK_CLIENT_URL, 'Windows');
  eq(panBaseUrl({ ...linux, exists: only(linuxState) }), LINK_CLIENT_URL, 'Linux');
});

test('the PAN computer itself (no link client) uses its own PAN', () => {
  eq(panBaseUrl({ ...win, exists: only() }), LOCAL_PAN_URL, 'Windows');
  eq(panBaseUrl({ ...linux, exists: only() }), LOCAL_PAN_URL, 'Linux');
});

test('PAN_BASE_URL wins over both, without a slash at the end', () => {
  const env = { ...win.env, PAN_BASE_URL: 'http://pan.example:8080/' };
  eq(panBaseUrl({ ...win, env, exists: only(winState) }), 'http://pan.example:8080', 'set');
  eq(panBaseUrl({ ...win, env: { ...win.env, PAN_BASE_URL: '  ' }, exists: only(winState) }), LINK_CLIENT_URL, 'blank is not set');
});

test('a link client somewhere else does not count', () => {
  eq(panBaseUrl({ ...linux, exists: only('/home/someone/pan/link-client/client.json') }), LOCAL_PAN_URL, 'other folder');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

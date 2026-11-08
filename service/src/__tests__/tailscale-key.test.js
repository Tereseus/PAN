// The Tailscale fallback's key handout (routes/tailscale-key.js), against a stand-in for
// Tailscale's API. No PAN server or database needed.
// Usage: node service/src/__tests__/tailscale-key.test.js

import http from 'http';
import express from 'express';

const KEY = 'tskey-auth-test-0000';
const calls = [];
let answer = { status: 200, body: { id: 'k123', key: KEY } };
const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
process.env.PAN_TAILSCALE_API = `http://127.0.0.1:${api.address().port}`;

const { tailscaleKeyRouter, resetLimits, KEY_TTL_SECONDS } = await import('../routes/tailscale-key.js');

// Settings the route reads; tests change them.
let settings = {};
const secret = (name) => settings[name] ?? null;

// PAN in front of the route, with whoever the test says is calling.
let caller = {};
const app = express();
app.use(express.json());
app.use((req, res, next) => { Object.assign(req, caller); next(); });
app.use('/api/v1/tailscale', tailscaleKeyRouter(secret));
const pan = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const url = `http://127.0.0.1:${pan.address().port}/api/v1/tailscale/auto-auth`;
const ask = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

// Watch the log for the key itself.
const logged = [];
for (const m of ['log', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logged.push(a.join(' ')); if (!a.join(' ').startsWith('[Tailscale key]')) orig(...a); };
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  calls.length = 0;
  resetLimits();
  answer = { status: 200, body: { id: 'k123', key: KEY } };
  settings = { tailscale_oauth_client_id: 'cid', tailscale_oauth_client_secret: 'csecret', tailscale_tag: 'tag:pan-device' };
  caller = { panLinkDevice: { id: 'dabc123', name: 'Pixel test' }, user: { role: 'owner' } };
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ✗ ${name}: ${err.message}\n`);
  }
}
function ok(cond, what) { if (!cond) throw new Error(what); }

process.stdout.write('tailscale key handout\n');

await test('a phone paired through PAN Link gets a single use key', async () => {
  const r = await ask();
  const j = await r.json();
  ok(r.status === 200 && j.ok && j.auth_key === KEY && j.expires_in === KEY_TTL_SECONDS, `${r.status} ${JSON.stringify(j)}`);
  ok(calls.length === 1 && calls[0].method === 'POST' && calls[0].url === '/api/v2/tailnet/-/keys', JSON.stringify(calls));
  ok(calls[0].auth === 'Basic ' + Buffer.from('cid:csecret').toString('base64'), 'wrong OAuth credentials sent');
  const sent = JSON.parse(calls[0].body);
  const c = sent.capabilities.devices.create;
  ok(c.reusable === false && c.preauthorized === true && c.ephemeral === false, `capabilities ${JSON.stringify(c)}`);
  ok(c.tags.length === 1 && c.tags[0] === 'tag:pan-device', `tags ${c.tags}`);
  ok(sent.expirySeconds === 300, `expiry ${sent.expirySeconds}`);
  ok(!logged.some((l) => l.includes(KEY)), 'the key was logged');
  ok(logged.some((l) => l.includes('k123')), 'the key id was not logged');
});

await test('the owner on Tailscale or the home network, without the link: refused, Tailscale not asked', async () => {
  caller = { user: { role: 'owner' } };
  const r = await ask();
  ok(r.status === 403 && calls.length === 0, `${r.status}, ${calls.length} calls`);
});

await test('no OAuth client set up: 501, Tailscale not asked', async () => {
  delete settings.tailscale_oauth_client_secret;
  const r = await ask();
  ok(r.status === 501 && calls.length === 0, `${r.status}, ${calls.length} calls`);
});

await test('no tag, or not a tag: 501, Tailscale not asked', async () => {
  delete settings.tailscale_tag;
  let r = await ask();
  ok(r.status === 501 && calls.length === 0, `no tag: ${r.status}`);
  settings.tailscale_tag = 'pan-device';
  r = await ask();
  ok(r.status === 501 && calls.length === 0, `not a tag: ${r.status}`);
});

await test('Tailscale refuses: 502 with its reason, and nothing about the key', async () => {
  answer = { status: 400, body: { message: 'requested tags [tag:pan-device] are invalid or not permitted' } };
  const r = await ask();
  const j = await r.json();
  ok(r.status === 502 && /400/.test(j.error) && /not permitted/.test(j.detail), `${r.status} ${JSON.stringify(j)}`);
});

await test('at most 3 keys per device in 10 minutes', async () => {
  for (let i = 0; i < 3; i++) ok((await ask()).status === 200, `key ${i + 1} refused`);
  const r = await ask();
  ok(r.status === 429 && calls.length === 3, `fourth: ${r.status}, ${calls.length} calls`);
  caller = { panLinkDevice: { id: 'dother1', name: 'Laptop' } };
  ok((await ask()).status === 200, 'another device was limited too');
});

await test('Tailscale not reachable: 502, not a hang', async () => {
  const saved = process.env.PAN_TAILSCALE_API;
  process.env.PAN_TAILSCALE_API = 'http://127.0.0.1:9';
  try {
    const r = await ask();
    ok(r.status === 502, `status ${r.status}`);
  } finally {
    process.env.PAN_TAILSCALE_API = saved;
  }
});

for (const s of [pan, api]) {
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
}
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;

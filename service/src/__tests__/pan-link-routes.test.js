// PAN Link routes (routes/link.js): pairing codes and devices from pan-link's admin API.
// Runs standalone against a stand-in for pan-link, no PAN server needed.
// Usage: node service/src/__tests__/pan-link-routes.test.js

import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import http from 'http';
import express from 'express';

const SECRET = 'b'.repeat(64);
const dataDir = mkdtempSync(join(tmpdir(), 'panlink-routes-'));
writeFileSync(join(dataDir, 'link.json'), JSON.stringify({ secret: SECRET }));
const noLink = mkdtempSync(join(tmpdir(), 'panlink-routes-none-'));
process.env.PAN_DATA_DIR = dataDir; // the routes use getDataDir()

const URI = 'pan://pair?v=1&h=x&g=10.77.0.1&k=y&a=10.77.0.9&e=192.168.50.20%3A41720&x=1999999999&n=PAN+hub';

// Stand-in for pan-link's admin API: answers only with the right secret.
const calls = [];
const admin = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, body });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-pan-link-secret'] !== SECRET) return send(403, { error: 'forbidden' });
    if (req.method === 'POST' && req.url === '/admin/pair') return send(200, { uri: URI, expires: '2033-05-18T03:33:19Z', device_ip: '10.77.0.9' });
    if (req.method === 'GET' && req.url === '/admin/devices') return send(200, [{ id: 'd1', name: 'Pixel test' }]);
    if (req.method === 'DELETE' && req.url === '/admin/devices/d1') return send(200, { ok: true });
    if (req.method === 'DELETE') return send(404, { error: 'no such device' });
    send(404, { error: 'not found' });
  });
});
await new Promise((r) => admin.listen(0, '127.0.0.1', r));
process.env.PAN_LINK_ADMIN = `http://127.0.0.1:${admin.address().port}`;

const { default: linkRouter, callAdmin } = await import('../routes/link.js');

// PAN in front of the routes, with whoever the test says is calling.
let role = 'owner';
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 1, role }; next(); });
app.use('/api/v1/link', linkRouter);
const pan = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${pan.address().port}/api/v1/link`;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    role = 'owner';
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}
function ok(cond, what) { if (!cond) throw new Error(what); }

console.log('pan-link routes');

await test('pairing code: the pan://pair link and a QR of it', async () => {
  const r = await fetch(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pixel', ttl_minutes: 10 }) });
  const j = await r.json();
  ok(r.status === 200, `status ${r.status} ${JSON.stringify(j)}`);
  ok(j.uri === URI, `uri ${j.uri}`);
  ok(typeof j.svg === 'string' && j.svg.includes('<svg'), 'no QR svg');
  const sent = JSON.parse(calls.at(-1).body);
  ok(sent.name === 'Pixel' && sent.ttl_minutes === 10, `sent ${calls.at(-1).body}`);
});

await test('a long time to live is capped at 60 minutes', async () => {
  await fetch(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl_minutes: 100000 }) });
  ok(JSON.parse(calls.at(-1).body).ttl_minutes === 60, `sent ${calls.at(-1).body}`);
});

await test('only the owner gets a code', async () => {
  role = 'viewer';
  const before = calls.length;
  const r = await fetch(`${base}/pair`, { method: 'POST' });
  ok(r.status === 403, `status ${r.status}`);
  ok(calls.length === before, 'pan-link was asked anyway');
});

await test('paired devices come from pan-link', async () => {
  const r = await fetch(`${base}/devices`);
  const j = await r.json();
  ok(r.status === 200 && j[0]?.name === 'Pixel test', `${r.status} ${JSON.stringify(j)}`);
});

await test('removing a device asks pan-link to forget it', async () => {
  const r = await fetch(`${base}/devices/d1`, { method: 'DELETE' });
  const j = await r.json();
  ok(r.status === 200 && j.ok === true, `${r.status} ${JSON.stringify(j)}`);
  ok(calls.at(-1).method === 'DELETE' && calls.at(-1).url === '/admin/devices/d1', JSON.stringify(calls.at(-1)));
  const gone = await fetch(`${base}/devices/nope`, { method: 'DELETE' });
  ok(gone.status === 404, `unknown device: ${gone.status}`);
});

await test('a device id that is not an id never reaches pan-link', async () => {
  const before = calls.length;
  const r = await fetch(`${base}/devices/..%2Fpair`, { method: 'DELETE' });
  ok(r.status === 400, `status ${r.status}`);
  ok(calls.length === before, 'pan-link was asked anyway');
});

await test('only the owner removes devices', async () => {
  role = 'viewer';
  const before = calls.length;
  const r = await fetch(`${base}/devices/d1`, { method: 'DELETE' });
  ok(r.status === 403 && calls.length === before, `status ${r.status}`);
});

await test('no link.json here: 503, pan-link not asked', async () => {
  const before = calls.length;
  const r = await callAdmin('/admin/devices', {}, noLink);
  ok(r.status === 503 && /not set up/.test(r.body.error), JSON.stringify(r));
  ok(calls.length === before, 'pan-link was asked anyway');
});

await test('pan-link not running: status 0 and a plain reason', async () => {
  const saved = process.env.PAN_LINK_ADMIN;
  process.env.PAN_LINK_ADMIN = 'http://127.0.0.1:9'; // nothing listens there
  try {
    const r = await callAdmin('/admin/devices', {}, dataDir);
    ok(r.status === 0 && /not running/.test(r.body.error), JSON.stringify(r));
  } finally {
    process.env.PAN_LINK_ADMIN = saved;
  }
});

// Close everything and let Node exit on its own: process.exit() while sockets are still
// closing trips a libuv assertion on Windows.
for (const s of [pan, admin]) {
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

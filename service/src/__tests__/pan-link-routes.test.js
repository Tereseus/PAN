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
    if (req.method === 'PUT' && req.url === '/admin/devices/d1/allow') {
      const allow = JSON.parse(body).allow;
      return send(200, { id: 'd1', name: 'Work PC', ...(allow.length ? { allow } : {}) });
    }
    if (req.method === 'PUT') return send(404, { error: 'no such device' });
    if (req.method === 'DELETE') return send(404, { error: 'no such device' });
    send(404, { error: 'not found' });
  });
});
await new Promise((r) => admin.listen(0, '127.0.0.1', r));
process.env.PAN_LINK_ADMIN = `http://127.0.0.1:${admin.address().port}`;

const { default: linkRouter, callAdmin, LIMITED_ALLOW } = await import('../routes/link.js');

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

await test('a limited code asks pan-link for a device that may only send', async () => {
  const r = await fetch(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Work PC', limited: true }) });
  ok(r.status === 200, `status ${r.status}`);
  const sent = JSON.parse(calls.at(-1).body);
  ok(JSON.stringify(sent.allow) === JSON.stringify(LIMITED_ALLOW), `sent ${calls.at(-1).body}`);
  ok(!LIMITED_ALLOW.some((rule) => /memory|events|mcp|hooks|terminal|link|settings/.test(rule)), 'the preset reaches PAN data');
  await fetch(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pixel', limited: 'yes' }) });
  ok(!('allow' in JSON.parse(calls.at(-1).body)), 'only limited: true limits');
});

await test('limiting a paired device and lifting the limit', async () => {
  const put = (id, body) => fetch(`${base}/devices/${id}/limited`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let r = await put('d1', { limited: true });
  let j = await r.json();
  ok(r.status === 200 && JSON.stringify(j.allow) === JSON.stringify(LIMITED_ALLOW), `limit: ${r.status} ${JSON.stringify(j)}`);
  ok(calls.at(-1).method === 'PUT' && calls.at(-1).url === '/admin/devices/d1/allow', JSON.stringify(calls.at(-1)));
  r = await put('d1', { limited: false });
  j = await r.json();
  ok(r.status === 200 && !j.allow && JSON.parse(calls.at(-1).body).allow.length === 0, `lift: ${r.status} ${JSON.stringify(j)}`);
  ok((await put('nope', { limited: true })).status === 404, 'unknown device');
  const before = calls.length;
  ok((await put('d1', { limited: 'yes' })).status === 400, 'not a boolean');
  ok((await put('..%2Fpair', { limited: true })).status === 400, 'not an id');
  role = 'viewer';
  ok((await put('d1', { limited: false })).status === 403, 'a viewer lifted a limit');
  ok(calls.length === before, 'pan-link was asked anyway');
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

// A device for a person (people.js). The stand-in's code reserves 10.77.0.9.
const { run } = await import('../db.js');
const people = await import('../people.js');
const post = (path, body, method = 'POST') => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
run(`INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (1, 'owner@localhost', 'owner', 'owner')`);
const kid = Number(run(`INSERT INTO users (email, display_name, role, power_lvl, is_active) VALUES ('kid@local', 'Kid', 'child', 5, 1)`).lastInsertRowid);

await test('a code made for a person binds the device that pairs with it', async () => {
  const r = await post('/pair', { name: 'Kid tablet', for_user: kid });
  ok(r.status === 200, `status ${r.status}`);
  const sent = JSON.parse(calls.at(-1).body);
  ok(Array.isArray(sent.allow) && sent.allow.join() === people.PERSON_ALLOW.join(), `the code was not limited to the people's paths: ${calls.at(-1).body}`);
  ok(!sent.allow.some((x) => x.includes('query') || x.includes('/dashboard') || x.includes('*')), 'the list opens more than it should');
  ok(people.pairingsWaiting(), 'nothing is waiting for the device');
  ok(people.claimPairings([{ id: 'd1', tunnel_ip: '10.77.0.9' }]) === 1, 'the device was not bound');
  const p = people.personOfDevice('d1');
  ok(p?.display_name === 'Kid' && p.power === 5, `bound to ${JSON.stringify(p)}`);
});

await test('a code for a person who does not exist is refused', async () => {
  const r = await post('/pair', { for_user: 424242 });
  ok(r.status === 400, `status ${r.status}`);
});

await test('only the owner makes a code for a person or hands a device over', async () => {
  role = 'admin';
  ok((await post('/pair', { for_user: kid })).status === 403, 'an admin made a code');
  ok((await post('/devices/d1/person', { user_id: null }, 'PUT')).status === 403, 'an admin took a device');
  ok((await fetch(`${base}/people`)).status === 403, 'an admin read who has what');
});

await test('handing a device over limits it first; taking it back lifts the limit', async () => {
  people.setDevicePerson('d1', null);
  let r = await post('/devices/d1/person', { user_id: kid, shared: true }, 'PUT');
  ok(r.status === 200 && (await r.json()).person.shared === true, 'not handed over as shared');
  let asked = calls.at(-1);
  ok(asked.method === 'PUT' && asked.url === '/admin/devices/d1/allow', `pan-link was not asked to limit it: ${asked.method} ${asked.url}`);
  ok(JSON.parse(asked.body).allow.join() === people.PERSON_ALLOW.join(), `limited to ${asked.body}`);
  const list = (await (await fetch(`${base}/people`)).json()).devices;
  ok(list.some((d) => d.link_device_id === 'd1' && d.display_name === 'Kid'), `list ${JSON.stringify(list)}`);
  ok((await post('/devices/d1/person', { user_id: 'kid' }, 'PUT')).status === 400, 'a name was taken for an id');
  ok((await post('/devices/d1/person', { user_id: 424242 }, 'PUT')).status === 404, 'handed to nobody');
  r = await post('/devices/d1/person', { user_id: null }, 'PUT');
  ok(r.status === 200 && (await r.json()).person === null, 'not taken back');
  asked = calls.at(-1);
  ok(JSON.parse(asked.body).allow.length === 0, 'the limit was not lifted for the owner');
});

await test('a device pan-link cannot limit is not handed over', async () => {
  const r = await post('/devices/d2/person', { user_id: kid }, 'PUT');   // the stand-in has no d2
  ok(r.status === 404, `status ${r.status}`);
  ok(people.personOfDevice('d2') === null, 'it was bound without a wall');
});

await test('a code for the owner himself is not limited', async () => {
  const r = await post('/pair', { name: 'His own', for_user: 1 });
  ok(r.status === 200, `status ${r.status}`);
  ok(!('allow' in JSON.parse(calls.at(-1).body)), `limited: ${calls.at(-1).body}`);
  people.claimPairings([{ id: 'd9', tunnel_ip: '10.77.0.9' }]);
});

await test('removing a device removes whose it was', async () => {
  people.setDevicePerson('d1', kid);
  ok(people.personOfDevice('d1') !== null, 'd1 should be the child\'s');
  const r = await fetch(`${base}/devices/d1`, { method: 'DELETE' });
  ok(r.status === 200, `status ${r.status}`);
  ok(people.personOfDevice('d1') === null, 'the binding outlived the device');
});

// Close everything and let Node exit on its own: process.exit() while sockets are still
// closing trips a libuv assertion on Windows.
for (const s of [pan, admin]) {
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

// pan-link identity tests — runs standalone, no server needed
// Usage: node service/src/__tests__/pan-link-auth.test.js

import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { identify, linkSecret, linkDevice, resetLinkCache, HEADER_DEVICE, HEADER_SECRET, HEADER_DEVICE_NAME } from '../pan-link-auth.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    resetLinkCache();
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

const SECRET = 'a'.repeat(64);
const withLink = mkdtempSync(join(tmpdir(), 'panlink-'));
writeFileSync(join(withLink, 'link.json'), JSON.stringify({ secret: SECRET, private_key: 'x' }));
const noLink = mkdtempSync(join(tmpdir(), 'panlink-none-'));

const req = (headers) => ({ headers: { ...headers } });

console.log('pan-link-auth');

test('no link headers: not trusted, nothing to strip', () => {
  eq(identify(req({ 'x-device-name': 'phone' }), withLink), { ok: false }, 'result');
});

test('right secret and a real device id: trusted, headers stripped', () => {
  const r = req({ [HEADER_SECRET]: SECRET, [HEADER_DEVICE]: 'd18cf2700479c', [HEADER_DEVICE_NAME]: "My Pixel" });
  eq(identify(r, withLink), { ok: true, deviceId: 'd18cf2700479c', deviceName: "My Pixel" }, 'result');
  eq(Object.keys(r.headers), [], 'headers left');
});

test('wrong secret: forged', () => {
  eq(identify(req({ [HEADER_SECRET]: 'b'.repeat(64), [HEADER_DEVICE]: 'd18cf2700479c' }), withLink), { ok: false, forged: true }, 'result');
});

test('device id without a secret: forged', () => {
  const r = req({ [HEADER_DEVICE]: 'd18cf2700479c' });
  eq(identify(r, withLink), { ok: false, forged: true }, 'result');
  eq(r.headers[HEADER_DEVICE], undefined, 'stripped');
});

test('odd device id with the right secret: forged', () => {
  eq(identify(req({ [HEADER_SECRET]: SECRET, [HEADER_DEVICE]: 'dev-anything' }), withLink), { ok: false, forged: true }, 'result');
});

test('pan-link not set up here: headers never trusted, still stripped', () => {
  const r = req({ [HEADER_SECRET]: SECRET, [HEADER_DEVICE]: 'd18cf2700479c' });
  eq(identify(r, noLink), { ok: false, forged: true }, 'result');
  eq(Object.keys(r.headers), [], 'headers left');
  eq(linkSecret(noLink), null, 'secret');
});

test('PAN_LINK=0 turns it off', () => {
  process.env.PAN_LINK = '0';
  try {
    eq(linkSecret(withLink), null, 'secret');
    eq(identify(req({ [HEADER_SECRET]: SECRET, [HEADER_DEVICE]: 'd18cf2700479c' }), withLink).ok, false, 'ok');
  } finally {
    delete process.env.PAN_LINK;
  }
});

test('a link.json made right after a refused call works at once', () => {
  const d = mkdtempSync(join(tmpdir(), 'panlink-late-'));
  try {
    eq(identify(req({ [HEADER_SECRET]: SECRET, [HEADER_DEVICE]: 'd18cf2700479c' }), d).forged, true, 'before');
    writeFileSync(join(d, 'link.json'), JSON.stringify({ secret: SECRET }));
    eq(identify(req({ [HEADER_SECRET]: SECRET, [HEADER_DEVICE]: 'd18cf2700479c' }), d).ok, true, 'after');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('a new secret works at once, and the old one stops', () => {
  const d = mkdtempSync(join(tmpdir(), 'panlink-rotate-'));
  const file = join(d, 'link.json');
  const NEW = 'c'.repeat(64);
  try {
    writeFileSync(file, JSON.stringify({ secret: SECRET }));
    utimesSync(file, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    eq(identify(req({ [HEADER_SECRET]: SECRET, [HEADER_DEVICE]: 'd18cf2700479c' }), d).ok, true, 'old secret first');
    writeFileSync(file, JSON.stringify({ secret: NEW }));
    eq(identify(req({ [HEADER_SECRET]: NEW, [HEADER_DEVICE]: 'd18cf2700479c' }), d).ok, true, 'new secret');
    eq(identify(req({ [HEADER_SECRET]: SECRET, [HEADER_DEVICE]: 'd18cf2700479c' }), d).forged, true, 'old secret after');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('short secret in link.json is refused', () => {
  const d = mkdtempSync(join(tmpdir(), 'panlink-short-'));
  writeFileSync(join(d, 'link.json'), JSON.stringify({ secret: 'short' }));
  eq(linkSecret(d), null, 'secret');
  rmSync(d, { recursive: true, force: true });
});

test('linkDevice: limited, full, not listed, and no PAN Link here', () => {
  const d = mkdtempSync(join(tmpdir(), 'panlink-devs-'));
  try {
    writeFileSync(join(d, 'link.json'), JSON.stringify({ secret: SECRET, devices: [
      { id: 'd18cf2700479c', name: 'phone' },
      { id: 'd0fb0b7942a0e', name: 'shared pc', allow: ['POST /api/v1/notify/inbound'] },
      { id: 'd5555555555ee', name: 'old', allow: [] },
    ] }));
    eq(linkDevice(d, 'd18cf2700479c'), { limited: false }, 'full');
    eq(linkDevice(d, 'd0fb0b7942a0e'), { limited: true }, 'limited');
    eq(linkDevice(d, 'd5555555555ee'), { limited: false }, 'empty allow list is full');
    eq(linkDevice(d, 'd9999999999ff'), null, 'not listed');
    eq(linkDevice(noLink, 'd18cf2700479c'), undefined, 'no link.json');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('linkDevice finds a device paired a moment ago, and loses a removed one', () => {
  const d = mkdtempSync(join(tmpdir(), 'panlink-pair-'));
  const file = join(d, 'link.json');
  const old = new Date(Date.now() - 10_000);
  try {
    writeFileSync(file, JSON.stringify({ secret: SECRET, devices: [] }));
    utimesSync(file, old, old);
    eq(linkDevice(d, 'd18cf2700479c'), null, 'before pairing');
    writeFileSync(file, JSON.stringify({ secret: SECRET, devices: [{ id: 'd18cf2700479c' }] }));
    utimesSync(file, new Date(old.getTime() + 2000), new Date(old.getTime() + 2000));
    eq(linkDevice(d, 'd18cf2700479c'), { limited: false }, 'right after pairing');
    eq(linkDevice(d, 'd18cf2700479c', Date.now() + 120_000), { limited: false }, 'a while later');
    writeFileSync(file, JSON.stringify({ secret: SECRET, devices: [] }));
    utimesSync(file, new Date(old.getTime() + 4000), new Date(old.getTime() + 4000));
    eq(linkDevice(d, 'd18cf2700479c', Date.now() + 240_000), null, 'after removal (next reload)');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

rmSync(withLink, { recursive: true, force: true });
rmSync(noLink, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

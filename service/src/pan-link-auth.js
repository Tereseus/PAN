// pan-link-auth.js — trust the device identity that pan-link adds, and nothing else.
//
// pan-link (repo folder pan-link/, design in docs/INSTALL-PLAN.md) carries every phone
// and PC to PAN over plain WireGuard and forwards to PAN on this computer. Before
// forwarding it removes any X-PAN-Device / X-PAN-Device-Name / X-PAN-Link-Secret a
// device sent, then adds the real device id, its name, and the link secret. The secret
// lives in <data dir>/link.json, which only pan-link and PAN read.
//
// Off until pan-link has run here: with no link.json, identify() never trusts the
// headers and strips them, so nothing changes for today's Tailscale and LAN callers.
// PAN_LINK=0 turns it off even when link.json exists.
//
// PAN_HOST=127.0.0.1 (server.js, carrier.js, super-carrier.js) makes the link the only
// way in from outside: all three of PAN's ports then listen on this computer only.

import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { timingSafeEqual } from 'crypto';

export const HEADER_DEVICE = 'x-pan-device';
export const HEADER_DEVICE_NAME = 'x-pan-device-name';
export const HEADER_SECRET = 'x-pan-link-secret';

const RELOAD_MS = 60_000;
const EMPTY = { path: null, secret: null, devices: new Map(), mtimeMs: -1, checkedAt: 0 };
let cache = EMPTY;

/**
 * The link secret from <dataDir>/link.json, or null when pan-link is not set up.
 * Checked at most once a minute, unless fresh: then the file is checked now (a stat;
 * it is read again only when it changed).
 */
export function linkSecret(dataDir, now = Date.now(), fresh = false) {
  if (process.env.PAN_LINK === '0') return null;
  const path = join(dataDir, 'link.json');
  if (!fresh && cache.path === path && now - cache.checkedAt < RELOAD_MS) return cache.secret;
  let secret = null;
  let devices = new Map();
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
    if (cache.path === path && mtimeMs === cache.mtimeMs) {
      ({ secret, devices } = cache);
    } else {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      secret = typeof state.secret === 'string' && state.secret.length >= 32 ? state.secret : null;
      for (const d of Array.isArray(state.devices) ? state.devices : []) {
        if (typeof d?.id === 'string') devices.set(d.id, { limited: Array.isArray(d.allow) && d.allow.length > 0 });
      }
    }
  } catch {
    secret = null; // no link.json (normal until pan-link runs) or unreadable
  }
  if (!secret) devices = new Map();
  cache = { path, secret, devices, mtimeMs, checkedAt: now };
  return secret;
}

/** Forget the cached secret (tests, or after pan-link rotates it). */
export function resetLinkCache() {
  cache = EMPTY;
}

/**
 * pan-link's record of a paired device: { limited } (limited: pan-link lets it send only
 * its allow list, pan-link/allow.go). null when link.json doesn't list it (never paired,
 * or removed); link.json is read again first, so a device paired a moment ago is found.
 * undefined when pan-link isn't set up here, so nothing is known either way.
 */
export function linkDevice(dataDir, id, now = Date.now()) {
  if (!linkSecret(dataDir, now)) return undefined;
  if (!cache.devices.has(id) && !linkSecret(dataDir, now, true)) return undefined;
  return cache.devices.get(id) || null;
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Who pan-link says is calling. Always strips the three headers from req.headers so no
 * later code can read a forged value.
 * Returns { ok: true, deviceId, deviceName } when the secret matches,
 *         { ok: false, forged: true } when link headers came with a wrong secret,
 *         { ok: false } when there were none (or pan-link is not set up here).
 */
export function identify(req, dataDir) {
  const h = req.headers || {};
  const sent = h[HEADER_SECRET];
  const deviceId = h[HEADER_DEVICE];
  const deviceName = h[HEADER_DEVICE_NAME];
  delete h[HEADER_SECRET];
  delete h[HEADER_DEVICE];
  delete h[HEADER_DEVICE_NAME];
  if (sent === undefined && deviceId === undefined) return { ok: false };
  let secret = linkSecret(dataDir);
  // On a mismatch look at link.json again before refusing, so a link.json pan-link
  // just made, or a new secret, works at once instead of after the cache minute.
  if (sent !== undefined && (!secret || !sameSecret(sent, secret))) secret = linkSecret(dataDir, Date.now(), true);
  if (!secret || sent === undefined || !sameSecret(sent, secret)) return { ok: false, forged: true };
  if (typeof deviceId !== 'string' || !/^d[0-9a-f]{12}$/.test(deviceId)) return { ok: false, forged: true };
  return { ok: true, deviceId, deviceName: typeof deviceName === 'string' ? deviceName.slice(0, 80) : '' };
}

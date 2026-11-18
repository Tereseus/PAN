// PAN Link on this computer: pairing codes and the list of paired devices, for the
// owner. pan-link (pan-link/, docs/INSTALL-PLAN.md) runs beside PAN and has a small
// admin API on 127.0.0.1 that needs the link secret from <data dir>/link.json. PAN
// reads that secret anyway (pan-link-auth.js), so it can ask pan-link on the owner's
// behalf: the phone app's "Pair this phone" uses POST /pair over its Tailscale
// connection, and a pairing screen can show the code as a QR.
//
// Mounted at /api/v1/link after the login check. A pairing code lets a new device in as
// the owner, so only the owner gets one.

import { Router } from 'express';
import { notePairingFor, setDevicePerson, personOfDevice, forgetDevice, devicePeople, allowFor, PERSON_ALLOW } from '../people.js';
import { get as dbGet } from '../db.js';
import { getDataDir } from '../platform.js';
import { linkSecret, HEADER_SECRET } from '../pan-link-auth.js';

const router = Router();

// What a limited device may send to PAN, for a computer someone else also controls (a
// work computer, whose company has admin rights on it). pan-link refuses everything else
// itself, before PAN sees it (pan-link/allow.go). These let it send alerts and Slack
// messages in, ask for a Slack reply draft, and keep its scoped PAN client connected; none
// of them reads PAN's memory or changes PAN.
export const LIMITED_ALLOW = Object.freeze([
  'POST /api/v1/notify/inbound',
  'POST /api/v1/slack/inbound',
  'POST /api/v1/sn-loop/draft',
  'GET /ws/client',
  'GET /health',
]);

/** Where pan-link's admin API listens (pan-link hub --admin, 127.0.0.1:7792 by default). */
export function adminBase() {
  return process.env.PAN_LINK_ADMIN || 'http://127.0.0.1:7792';
}

/** Calls pan-link's admin API. Returns { status, body }; status 0 when it isn't running. */
export async function callAdmin(path, { method = 'GET', body } = {}, dataDir = getDataDir()) {
  const secret = linkSecret(dataDir, Date.now(), true);
  if (!secret) return { status: 503, body: { error: 'PAN Link is not set up on this computer' } };
  try {
    const r = await fetch(adminBase() + path, {
      method,
      headers: { [HEADER_SECRET]: secret, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const text = await r.text();
    // pan-link has just changed a device (limited, handed over, removed): read its list again now,
    // not up to a minute later, so the hub does not go on treating the device as it was.
    if (method !== 'GET') linkSecret(dataDir, Date.now(), true);
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { error: text.trim() || r.statusText }; }
    return { status: r.status, body: parsed };
  } catch (e) {
    return { status: 0, body: { error: `PAN Link is not running here (${e.cause?.code || e.message})` } };
  }
}

function ownerOnly(req, res, next) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'owner only' });
  next();
}

router.use(ownerOnly);

// A new pairing code. Body: { name?, ttl_minutes?, limited?, for_user?, shared? } (pan-link's
// default is 10 minutes; limited: true pairs a device that may only send LIMITED_ALLOW).
// for_user: the id of the person the device is for (people.js); without it the device is the
// owner's, as before. shared: a device several people use (a TV, the car), kept by for_user.
// Answers { uri, expires, svg }: the pan://pair link and the same as a QR image.
router.post('/pair', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.slice(0, 60) : '';
  const ttl = Number.isInteger(req.body?.ttl_minutes) ? Math.min(Math.max(req.body.ttl_minutes, 1), 60) : 0;
  const limited = req.body?.limited === true;
  const forUser = Number.isInteger(req.body?.for_user) ? req.body.for_user : null;
  // A device for anyone but the owner is paired limited from its first request: pan-link holds
  // the wall, so nothing depends on PAN having worked out whose it is yet.
  const forOther = forUser !== null && dbGet('SELECT role FROM users WHERE id = :id AND is_active = 1', { ':id': forUser })?.role !== 'owner';
  const allow = limited ? [...LIMITED_ALLOW] : forOther ? [...PERSON_ALLOW] : null;
  const { status, body } = await callAdmin('/admin/pair', {
    method: 'POST',
    body: { name, ttl_minutes: ttl, ...(allow ? { allow } : {}) },
  });
  if (status !== 200 || typeof body?.uri !== 'string') return res.status(status || 503).json(body);
  if (forUser !== null) {
    // pan-link says which tunnel address the code reserves; the device that pairs gets it.
    const expires = Date.parse(body.expires) || Date.now() + 10 * 60_000;
    if (!body.device_ip || !notePairingFor(body.device_ip, forUser, { shared: req.body?.shared === true, expires })) {
      return res.status(400).json({ error: 'no such person, or this PAN Link cannot make a code for a person' });
    }
  }
  let svg = null;
  try {
    const QR = (await import('qrcode')).default;
    svg = await QR.toString(body.uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  } catch (e) {
    console.warn(`[PAN Link] QR for a pairing code failed: ${e.message}`);
  }
  res.json({ uri: body.uri, expires: body.expires, svg });
});

// The paired devices: [{ id, name, ip, ... }].
router.get('/devices', async (req, res) => {
  const { status, body } = await callAdmin('/admin/devices');
  res.status(status || 503).json(body);
});

// Removes a paired device (a lost phone, say): it can't reach PAN through the link until
// it pairs again. The id is pan-link's, as GET /devices lists it.
router.delete('/devices/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-z0-9]{1,64}$/i.test(id)) return res.status(400).json({ error: 'bad device id' });
  const { status, body } = await callAdmin(`/admin/devices/${id}`, { method: 'DELETE' });
  if (status === 200) {
    forgetDevice(id);
    // A person's computer that is gone takes its threads with it (thread-relay.js).
    try { (await import('../thread-relay.js')).forgetHostsOf(id); } catch {}
    console.log(`[PAN Link] device ${id} removed by the owner`);
  }
  res.status(status || 503).json(body);
});

// Hands a paired device to a person, or takes it back. Body: { user_id: number | null, shared? }.
// null makes it the owner's own again.
router.put('/devices/:id/person', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-z0-9]{1,64}$/i.test(id)) return res.status(400).json({ error: 'bad device id' });
  const userId = req.body?.user_id;
  if (userId !== null && !Number.isInteger(userId)) return res.status(400).json({ error: 'user_id must be a number or null' });
  const to = userId === null ? null : dbGet('SELECT role FROM users WHERE id = :id AND is_active = 1', { ':id': userId });
  if (userId !== null && !to) return res.status(404).json({ error: 'no such person' });
  // The wall first, then the name on it: pan-link limits the device before PAN calls it theirs,
  // and lifts the limit only when it is the owner's again. A device handed over is never, even
  // for a moment, somebody else's with the owner's reach.
  const { status, body } = await callAdmin(`/admin/devices/${id}/allow`, { method: 'PUT', body: { allow: allowFor(to) } });
  if (status !== 200) return res.status(status || 503).json(body);
  if (!setDevicePerson(id, userId, { shared: req.body?.shared === true })) return res.status(404).json({ error: 'no such person' });
  console.log(`[PAN Link] device ${id} ${userId === null ? 'taken back by the owner' : `handed to user ${userId}`}`);
  res.json({ ok: true, person: personOfDevice(id) });
});

// Which devices belong to whom. Devices not listed are the owner's.
router.get('/people', (req, res) => {
  res.json({ devices: devicePeople() });
});

// PERSON_ALLOW grows as more of PAN is made a person's own. A device paired earlier still holds
// the list it was paired with at pan-link, so each one is given the current list: when this code
// starts, and on POST /people/sync. Answers how many were set and how many could not be.
export async function syncPersonAllow() {
  let set = 0, failed = 0;
  for (const d of devicePeople()) {
    if (d.role === 'owner') continue;
    const { status } = await callAdmin(`/admin/devices/${d.link_device_id}/allow`, { method: 'PUT', body: { allow: [...PERSON_ALLOW] } }).catch(() => ({ status: 0 }));
    if (status === 200) set++; else failed++;
  }
  return { set, failed };
}
router.post('/people/sync', async (req, res) => {
  res.json({ ok: true, ...(await syncPersonAllow()) });
});
if (!process.argv.some((a) => /__tests__/.test(a))) {
  setTimeout(() => syncPersonAllow().then((r) => { if (r.set || r.failed) console.log(`[PAN Link] people's devices given the current list: ${r.set} set, ${r.failed} not reachable`); }).catch(() => {}), 30_000).unref?.();
}

// Limits a paired device to LIMITED_ALLOW, or lifts the limit. Body: { limited: boolean }.
// It holds from the device's next request. Answers the device as pan-link now has it.
router.put('/devices/:id/limited', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-z0-9]{1,64}$/i.test(id)) return res.status(400).json({ error: 'bad device id' });
  if (typeof req.body?.limited !== 'boolean') return res.status(400).json({ error: 'limited must be true or false' });
  const allow = req.body.limited ? [...LIMITED_ALLOW] : [];
  const { status, body } = await callAdmin(`/admin/devices/${id}/allow`, { method: 'PUT', body: { allow } });
  if (status === 200) console.log(`[PAN Link] device ${id} ${req.body.limited ? 'limited' : 'given full access'} by the owner`);
  res.status(status || 503).json(body);
});

// pan-link's own view: hub key, addresses it can be reached on, number of devices.
router.get('/status', async (req, res) => {
  const { status, body } = await callAdmin('/admin/status');
  res.status(status || 503).json(body);
});

export default router;

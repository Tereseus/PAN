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
import { getDataDir } from '../platform.js';
import { linkSecret, HEADER_SECRET } from '../pan-link-auth.js';

const router = Router();

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

// A new pairing code. Body: { name?, ttl_minutes? } (pan-link's default is 10 minutes).
// Answers { uri, expires, svg }: the pan://pair link and the same as a QR image.
router.post('/pair', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.slice(0, 60) : '';
  const ttl = Number.isInteger(req.body?.ttl_minutes) ? Math.min(Math.max(req.body.ttl_minutes, 1), 60) : 0;
  const { status, body } = await callAdmin('/admin/pair', { method: 'POST', body: { name, ttl_minutes: ttl } });
  if (status !== 200 || typeof body?.uri !== 'string') return res.status(status || 503).json(body);
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
  if (status === 200) console.log(`[PAN Link] device ${id} removed by the owner`);
  res.status(status || 503).json(body);
});

// pan-link's own view: hub key, addresses it can be reached on, number of devices.
router.get('/status', async (req, res) => {
  const { status, body } = await callAdmin('/admin/status');
  res.status(status || 503).json(body);
});

export default router;

// SAVED FOR REFERENCE, NOT MOUNTED. Recovered 2026-11-08 from the hub's backup
// C:\PAN\service\src\routes\api.js.bak-statickey-2026-09-12T0025 (hand patch of 2026-09-11, never committed).
// The hub's live api.js lost this handler when C:\PAN was updated on 2026-11-02, so the phone's
// /api/v1/tailscale/auto-auth call gets a 404 again and only works because the phone remembers its
// Tailscale login (tsnet state). The later 'static key' version (PAN_TAILSCALE_AUTH_KEY) is gone.
// Replaced by pan-link pairing (docs/INSTALL-PLAN.md); kept for the Tailscale fallback work.
// It needs: getSecret (src/secrets.js), express router, and the login skip in server.js.


// ---------------------------------------------------------------------------
// POST /api/v1/tailscale/auto-auth  ->  { ok, auth_key, expires_in }
//
// Mints a SHORT-LIVED, SINGLE-USE Tailscale auth key so a fresh PAN device can
// join the tailnet headlessly.
//
// WHY (2026-09-11): the Android client has always POSTed here on connect and
// this route did not exist, so every call 404'd, the phone logged "Auto-auth
// failed, falling back to browser" and showed an interactive login. tsnet then
// never got far enough to write its node identity into files/tailscale/, so
// there was nothing to reuse and the login was demanded again on the next
// connect, forever. The endpoint was whitelisted in server.js's auth middleware
// from the start; only the handler was missing.
//
// This route is deliberately unauthenticated, and it has to be: the phone
// cannot authenticate to the hub until it is on the tailnet, and it cannot join
// the tailnet without a key. An unauthenticated endpoint that mints tailnet
// credentials is a real exposure, so the blast radius is cut three ways:
//   1. reusable:false + a 5 minute expiry, so one device, once, then dead
//   2. private/tailnet source addresses only, so never reachable from the WAN
//   3. the key value is never logged, only its id
//
// Tailscale REQUIRES OAuth-minted keys to carry a tag. Set PAN_TAILSCALE_TAG
// (e.g. "tag:pan-device") and make the OAuth client an owner of it in the ACL.
// Without it Tailscale rejects the mint and the error is returned verbatim.
// ---------------------------------------------------------------------------
import { getSecret } from '../secrets.js';

const TS_KEY_TTL_SECONDS = 300;

/** Loopback, RFC1918, or 100.64/10 (CGNAT, which is what the tailnet uses). */
function isPrivateAddr(ip) {
  if (!ip) return false;
  const a = String(ip).replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const x = Number(m[1]), y = Number(m[2]);
  if (x === 10) return true;
  if (x === 192 && y === 168) return true;
  if (x === 172 && y >= 16 && y <= 31) return true;
  if (x === 100 && y >= 64 && y <= 127) return true;
  return false;
}

router.post('/tailscale/auto-auth', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  if (!isPrivateAddr(ip)) {
    console.warn('[tailscale/auto-auth] refused non-private caller');
    return res.status(403).json({ ok: false, error: 'local network only' });
  }

  const clientId = getSecret('tailscale_oauth_client_id');
  const clientSecret = getSecret('tailscale_oauth_client_secret');
  if (!clientId || !clientSecret) {
    return res.status(501).json({ ok: false, error: 'tailscale oauth credentials not configured' });
  }

  const tag = String(process.env.PAN_TAILSCALE_TAG || '').trim();
  const auth = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const payload = {
    capabilities: { devices: { create: {
      reusable: false,
      ephemeral: false,
      preauthorized: true,
      tags: tag ? [tag] : [],
    } } },
    expirySeconds: TS_KEY_TTL_SECONDS,
    description: 'PAN device bootstrap',
  };

  try {
    const r = await fetch('https://api.tailscale.com/api/v2/tailnet/-/keys', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    if (!r.ok) {
      // Surface Tailscale's own message; the usual cause is a missing tag.
      console.warn('[tailscale/auto-auth] mint failed HTTP ' + r.status + ': ' + text.slice(0, 200));
      return res.status(502).json({
        ok: false,
        error: 'tailscale api ' + r.status,
        detail: text.slice(0, 300),
        hint: tag ? undefined : 'set PAN_TAILSCALE_TAG and make the OAuth client an owner of that tag',
      });
    }
    const j = JSON.parse(text);
    if (!j.key) return res.status(502).json({ ok: false, error: 'tailscale returned no key' });
    console.log('[tailscale/auto-auth] minted key id=' + j.id + ' ttl=' + TS_KEY_TTL_SECONDS + 's for ' + ip);
    return res.json({ ok: true, auth_key: j.key, expires_in: TS_KEY_TTL_SECONDS });
  } catch (e) {
    console.warn('[tailscale/auto-auth] ' + e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

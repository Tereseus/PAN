// The Tailscale fallback's key handout, for phones paired through PAN Link.
//
// Away from a home that lets nothing in (CGNAT, docs/INSTALL-PLAN.md), PAN Link reaches
// the hub only through Tailscale, so the phone's built in Tailscale has to be on the
// owner's tailnet. A phone paired through PAN Link (at home, by QR) asks here, through
// the link, for a single use Tailscale auth key and joins the tailnet with it: no
// Tailscale login on the phone. The phone already makes this call
// (PanServerApi.getTailscaleAuthKey) whenever its Tailscale has no login.
//
// The key is minted with the owner's Tailscale OAuth client (tailscale_oauth_client_id
// and tailscale_oauth_client_secret, in settings or PAN_TAILSCALE_OAUTH_CLIENT_ID /
// _SECRET) and a tag (setting tailscale_tag or PAN_TAILSCALE_TAG, e.g. "tag:pan-device"):
// Tailscale only mints tagged keys for an OAuth client, and the client has to own the
// tag in the tailnet's policy. Each key works once, for 5 minutes, and its value is never
// logged.
//
// Only a device PAN Link vouches for (req.panLinkDevice) gets a key, at most 3 in 10
// minutes. The old handout (docs/legacy/tailscale-auto-auth-2026-09.js) answered anyone
// on a private address, since a phone had no other way to prove itself then.
//
// Mounted at /api/v1/tailscale after the login check: tailscaleKeyRouter(getSecret).
// The secret lookup comes in as a parameter so tests never open PAN's database.

import { Router } from 'express';

export const KEY_TTL_SECONDS = 300;
const LIMIT = 3;
const WINDOW_MS = 10 * 60 * 1000;
const recent = new Map(); // device id -> times of its last keys

function apiBase() {
  return process.env.PAN_TAILSCALE_API || 'https://api.tailscale.com';
}

/** True when the device may have another key now (and counts this one). */
function allow(deviceId, now = Date.now()) {
  const times = (recent.get(deviceId) || []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= LIMIT) {
    recent.set(deviceId, times);
    return false;
  }
  times.push(now);
  recent.set(deviceId, times);
  return true;
}

/** For tests: forget the rate limit's memory. */
export function resetLimits() {
  recent.clear();
}

/** The router; secret(name) reads a setting (environment first, then settings). */
export function tailscaleKeyRouter(secret) {
  const router = Router();
  router.post('/auto-auth', async (req, res) => {
    const device = req.panLinkDevice;
    if (!device) {
      return res.status(403).json({ ok: false, error: 'pair this device with PAN Link first; Tailscale keys go only through the link' });
    }
    const clientId = secret('tailscale_oauth_client_id');
    const clientSecret = secret('tailscale_oauth_client_secret');
    if (!clientId || !clientSecret) {
      return res.status(501).json({ ok: false, error: 'Tailscale OAuth client not set up on this computer' });
    }
    const tag = String(secret('tailscale_tag') || '').trim();
    if (!/^tag:[a-z0-9-]+$/i.test(tag)) {
      return res.status(501).json({ ok: false, error: 'no Tailscale tag set (tailscale_tag, e.g. tag:pan-device, owned by the OAuth client)' });
    }
    if (!allow(device.id)) {
      return res.status(429).json({ ok: false, error: `at most ${LIMIT} Tailscale keys per device in 10 minutes` });
    }
    const payload = {
      capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [tag] } } },
      expirySeconds: KEY_TTL_SECONDS,
      description: `PAN Link ${device.id}`.slice(0, 50),
    };
    try {
      const r = await fetch(`${apiBase()}/api/v2/tailnet/-/keys`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await r.text();
      if (!r.ok) {
        // Tailscale's own words; the usual cause is a tag the OAuth client doesn't own.
        console.warn(`[Tailscale key] Tailscale refused (${r.status}): ${text.slice(0, 200)}`);
        return res.status(502).json({ ok: false, error: `Tailscale answered ${r.status}`, detail: text.slice(0, 300) });
      }
      let j = null;
      try { j = JSON.parse(text); } catch { /* checked below */ }
      if (!j?.key) return res.status(502).json({ ok: false, error: 'Tailscale returned no key' });
      console.log(`[Tailscale key] key ${j.id || '?'} for ${device.name || device.id} (${device.id}), single use, ${KEY_TTL_SECONDS} s`);
      return res.json({ ok: true, auth_key: j.key, expires_in: KEY_TTL_SECONDS });
    } catch (e) {
      console.warn(`[Tailscale key] ${e.message}`);
      return res.status(502).json({ ok: false, error: `Tailscale not reachable: ${e.message}` });
    }
  });
  return router;
}

// Capture-consent API — the privacy control plane (SHIP-PLAN Phase 4).
// Always mounted, every profile: a user must be able to see + control what's
// watching regardless of which profile they run.
//
//   GET  /api/v1/capture            → { profile, features:[{name,label,blurb,
//                                        enabled,running,source,env_locked}] }
//   POST /api/v1/capture/:name      → { enabled: true|false } toggle live

import { Router } from 'express';
import {
  getCaptureState, setCaptureConsent,
  isDeviceCaptureOn, setDeviceCaptureConsent, DEVICE_CAPTURE_FEATURES,
} from '../capture-consent.js';
import { all } from '../db.js';

const router = Router();

// Enumerate remote devices + their per-device capture consent. Reads the
// `devices` DB table (NOT the in-memory client map — this route runs in the
// Craft, where getConnectedClients() is always empty; the WS lives on the
// Carrier). Only PCs the hub can actually poll for a screenshot are listed.
function getDeviceCaptureList() {
  try {
    const rows = all(
      `SELECT hostname, name, display_name, device_type, capabilities, online
         FROM devices WHERE trusted = 1 ORDER BY online DESC, name`
    );
    return (rows || [])
      .map(r => {
        let caps = [];
        try { caps = JSON.parse(r.capabilities || '[]'); } catch {}
        const canScreen = Array.isArray(caps) && caps.includes('screenshot');
        return {
          device_id: r.hostname,
          name: r.display_name || r.name || r.hostname,
          device_type: r.device_type || null,
          online: !!r.online,
          features: DEVICE_CAPTURE_FEATURES
            .filter(f => f === 'screen' ? canScreen : true)
            .map(f => ({ name: f, enabled: isDeviceCaptureOn(r.hostname, f) })),
        };
      })
      .filter(d => d.features.length > 0);
  } catch { return []; }
}

router.get('/', (req, res) => {
  try { res.json({ ok: true, ...getCaptureState(), devices: getDeviceCaptureList() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/:name', (req, res) => {
  try {
    const b = req.body || {};
    const on = b.enabled === true || b.enabled === 'true' || b.on === true || b.on === 'true';
    const deviceId = b.device_id || req.query.device_id || null;

    // Per-device toggle (remote client) vs the hub's local watchers.
    if (deviceId && deviceId !== 'hub') {
      const result = setDeviceCaptureConsent(deviceId, req.params.name, on);
      return res.status(result.ok ? 200 : 409).json(result);
    }

    const result = setCaptureConsent(req.params.name, on);
    // 409 when the toggle was refused (env-pinned) — still return the state.
    res.status(result.ok ? 200 : 409).json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;

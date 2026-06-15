// Capture-consent API — the privacy control plane (SHIP-PLAN Phase 4).
// Always mounted, every profile: a user must be able to see + control what's
// watching regardless of which profile they run.
//
//   GET  /api/v1/capture            → { profile, features:[{name,label,blurb,
//                                        enabled,running,source,env_locked}] }
//   POST /api/v1/capture/:name      → { enabled: true|false } toggle live

import { Router } from 'express';
import { getCaptureState, setCaptureConsent } from '../capture-consent.js';

const router = Router();

router.get('/', (req, res) => {
  try { res.json({ ok: true, ...getCaptureState() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/:name', (req, res) => {
  try {
    const b = req.body || {};
    const on = b.enabled === true || b.enabled === 'true' || b.on === true || b.on === 'true';
    const result = setCaptureConsent(req.params.name, on);
    // 409 when the toggle was refused (env-pinned) — still return the state.
    res.status(result.ok ? 200 : 409).json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;

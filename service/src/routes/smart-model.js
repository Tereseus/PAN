// Is the smart model (Claude, through the person's own sign in) connected on this computer?
// For PAN Setup's last step and for a settings screen. The rule is in ../smart-model.js.
//
// Mounted at /api/v1/setup/smart-model after the login check. Owner only. It reads the sign in
// state and nothing else: no account name, no key, no token ever passes through here.

import { Router } from 'express';
import { checkSmartModel } from '../smart-model.js';
import { smartModel, smartModelChoices, setSmartModel } from '../smart-model-pick.js';

const router = Router();

router.get('/', async (req, res) => {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'owner only' });
  res.json(await checkSmartModel({ fresh: req.query.fresh !== undefined }));
});

// The picker (smart-model-pick.js): every smart model this hub can use, and the person's pick.
router.get('/choices', async (req, res) => {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'owner only' });
  try { res.json({ ok: true, current: smartModel(), choices: await smartModelChoices() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/', async (req, res) => {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'owner only' });
  try {
    const saved = await setSmartModel(req.body?.id);
    if (!saved) return res.status(400).json({ ok: false, error: 'this hub does not have that model' });
    console.log(`[PAN Settings] smart_model -> ${saved} (from ${req.headers['x-device-name'] || req.ip})`);
    res.json({ ok: true, current: saved });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;

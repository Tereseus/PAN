// Is the smart model (Claude, through the person's own sign in) connected on this computer?
// For PAN Setup's last step and for a settings screen. The rule is in ../smart-model.js.
//
// Mounted at /api/v1/setup/smart-model after the login check. Owner only. It reads the sign in
// state and nothing else: no account name, no key, no token ever passes through here.

import { Router } from 'express';
import { checkSmartModel } from '../smart-model.js';

const router = Router();

router.get('/', async (req, res) => {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'owner only' });
  res.json(await checkSmartModel({ fresh: req.query.fresh !== undefined }));
});

export default router;

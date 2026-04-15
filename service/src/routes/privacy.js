// Privacy Pipeline — unified API routes for all 5 layers
// GET  /api/v1/privacy/status    — full pipeline status (all layers)
// GET  /api/v1/privacy/dp        — differential privacy budget
// GET  /api/v1/privacy/routing   — context-aware routing stats
// GET  /api/v1/privacy/sensitivity — classifier stats
// POST /api/v1/privacy/config    — update any privacy setting
// POST /api/v1/privacy/classify  — manually classify content
// POST /api/v1/privacy/route     — manually route content through full pipeline

import { Router } from 'express';
import { getPrivacyConfig, getPrivacyStats } from '../privacy.js';
import { getGuardianConfig, getGuardianStats } from '../guardian.js';
import { getSensitivityConfig, getSensitivityStats, classify } from '../sensitivity.js';
import { getC2DConfig, getC2DStats } from '../compute-to-data.js';
import { getRoutingConfig, getRoutingStats, routeWithPrivacy } from '../context-router.js';
import { run } from '../db.js';

const router = Router();

// Full pipeline overview — all 5 layers at a glance
router.get('/status', (req, res) => {
  res.json({
    pipeline: {
      guardian:     { config: getGuardianConfig(),     stats: getGuardianStats() },
      dp:          { config: getPrivacyConfig(),       stats: getPrivacyStats() },
      c2d:         { config: getC2DConfig(),           stats: getC2DStats() },
      sensitivity: { config: getSensitivityConfig(),   stats: getSensitivityStats() },
      routing:     { config: getRoutingConfig(),       stats: getRoutingStats() },
    }
  });
});

// Individual layer stats
router.get('/dp', (req, res) => res.json(getPrivacyStats()));
router.get('/routing', (req, res) => res.json(getRoutingStats()));
router.get('/sensitivity', (req, res) => res.json(getSensitivityStats()));
router.get('/c2d', (req, res) => res.json(getC2DStats()));

// Update config for any layer
router.post('/config', (req, res) => {
  const { layer, ...values } = req.body;
  try {
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'boolean') {
        run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, key, value ? '1' : '0');
      } else if (value !== undefined) {
        run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, key, String(value));
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual classify
router.post('/classify', async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const result = await classify(content);
  res.json(result);
});

// Manual route through full pipeline
router.post('/route', async (req, res) => {
  const { content, context, source } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const result = await routeWithPrivacy(content, context || '', { source: source || 'manual', caller: 'dashboard' });
  res.json(result);
});

export default router;

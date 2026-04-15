// Guardian Guillotine — API routes
// GET  /api/v1/guardian/status    — config + stats
// GET  /api/v1/guardian/decisions — audit log with filters
// POST /api/v1/guardian/scan      — manual content scan
// POST /api/v1/guardian/config    — update guardian settings

import { Router } from 'express';
import { scan, getRecentDecisions, getGuardianStats, getGuardianConfig } from '../guardian.js';
import { run, get } from '../db.js';

const router = Router();

// Status + stats overview
router.get('/status', (req, res) => {
  const config = getGuardianConfig();
  const stats = getGuardianStats();
  res.json({ config, stats });
});

// Audit log — filterable decisions list
router.get('/decisions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const filter = {};
  if (req.query.decision) filter.decision = req.query.decision;
  if (req.query.source) filter.source = req.query.source;
  if (req.query.classification) filter.classification = req.query.classification;
  if (req.query.since) filter.since = parseInt(req.query.since);

  const result = getRecentDecisions(limit, offset, filter);
  res.json(result);
});

// Manual scan — test content against the Guillotine
router.post('/scan', async (req, res) => {
  const { content, source } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  const result = await scan(content, {
    source: source || 'manual',
    caller: 'dashboard',
    req,
  });
  res.json(result);
});

// Update config
router.post('/config', (req, res) => {
  const { enabled, mode, model } = req.body;
  try {
    if (enabled !== undefined) {
      run("INSERT OR REPLACE INTO settings (key, value) VALUES ('guardian_enabled', ?)", enabled ? '1' : '0');
    }
    if (mode && ['off', 'warn', 'block'].includes(mode)) {
      run("INSERT OR REPLACE INTO settings (key, value) VALUES ('guardian_mode', ?)", mode);
    }
    if (model) {
      run("INSERT OR REPLACE INTO settings (key, value) VALUES ('guardian_model', ?)", model);
    }
    res.json({ ok: true, config: getGuardianConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

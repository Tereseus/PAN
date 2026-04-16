// PAN Intuition API — /api/v1/intuition/*
//
// Exposes the live-situational-state daemon (see ../intuition.js) over HTTP:
//   GET  /current      current snapshot + as_of
//   GET  /history      recent snapshots (Atlas timeline feed)
//   GET  /status       daemon liveness
//   POST /observe      pendant/phone pushes a raw observation (frame/audio/sensor)
//   POST /tick         force a tick now (debug / manual refresh)

import { Router } from 'express';
import { db } from '../db.js';
import {
  getCurrentSnapshot,
  getSnapshotHistory,
  tickIntuition,
  getIntuitionStatus,
} from '../intuition.js';

const router = Router();

// GET /current — single latest snapshot
router.get('/current', (req, res) => {
  const snap = getCurrentSnapshot();
  if (!snap) return res.status(503).json({ ok: false, error: 'no snapshot yet' });
  res.json({ ok: true, snapshot: snap, as_of: snap.as_of });
});

// GET /history?limit=50 — recent snapshots for Atlas timeline
router.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  res.json({ ok: true, snapshots: getSnapshotHistory(limit) });
});

// GET /status — is the daemon alive, writing, which commander
router.get('/status', (req, res) => {
  res.json({ ok: true, ...getIntuitionStatus() });
});

// POST /observe — pendant / phone / any sensor source pushes raw data here.
// Body: { source, kind, data, timestamp? }
//   source: 'pendant' | 'phone' | 'desktop' | 'sensor:<id>'
//   kind:   'frame' | 'audio' | 'sensor' | 'text' | 'location'
//   data:   service-specific payload (base64 for binary, JSON for structured)
//
// v1: just logs it as an 'Observation' event so the daemon's next tick sees it.
// v2: will hand frames to vision model, audio to whisper, etc.
router.post('/observe', (req, res) => {
  const { source, kind, data, timestamp } = req.body || {};
  if (!source || !kind) return res.status(400).json({ ok: false, error: 'source and kind required' });

  const ts = timestamp || Date.now();
  try {
    db.prepare(`
      INSERT INTO events (event_type, session_id, data, org_id)
      VALUES ('Observation', ?, ?, 'org_personal')
    `).run(`intuition-${source}`, JSON.stringify({ source, kind, data, ts }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  // Trigger a fresh tick so the observation gets folded in immediately
  const snap = tickIntuition('observe');
  res.json({ ok: true, observed: { source, kind, ts }, snapshot_as_of: snap?.as_of || null });
});

// POST /tick — force a manual refresh (useful from Atlas "refresh now" button)
router.post('/tick', (req, res) => {
  const snap = tickIntuition('manual');
  if (!snap) return res.status(503).json({ ok: false, error: 'daemon not running' });
  res.json({ ok: true, snapshot: snap });
});

export default router;

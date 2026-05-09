// PAN Activity Routes — /api/v1/activity/*
//
// Endpoints:
//   POST /          Log an activity event (app focus, window change, etc.)
//   GET  /recent    Recent activity_events rows
//   GET  /preferences  Per-app open counts, last seen, avg duration
//   GET  /match?q=  Fuzzy match app_name or window_title (voice router use)

import { Router } from 'express';
import { run, get, all } from '../db.js';

const router = Router();

// POST / — log an activity event
// Body: { event_type, app_name, window_title, process_name, duration_ms, source, device_id, metadata }
router.post('/', (req, res) => {
  const {
    event_type,
    app_name,
    window_title,
    process_name,
    duration_ms,
    source = 'desktop',
    device_id,
    metadata,
  } = req.body || {};

  const metaStr = metadata && typeof metadata === 'object'
    ? JSON.stringify(metadata)
    : (metadata || null);

  const result = run(
    `INSERT INTO activity_events (event_type, app_name, window_title, process_name, duration_ms, source, device_id, metadata)
     VALUES (:event_type, :app_name, :window_title, :process_name, :duration_ms, :source, :device_id, :metadata)`,
    {
      ':event_type': event_type || null,
      ':app_name': app_name || null,
      ':window_title': window_title || null,
      ':process_name': process_name || null,
      ':duration_ms': duration_ms || null,
      ':source': source,
      ':device_id': device_id || null,
      ':metadata': metaStr,
    }
  );

  res.json({ ok: true, id: result.lastInsertRowid });
});

// GET /recent?limit=50&source=desktop — recent activity rows
router.get('/recent', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const source = req.query.source;

  let rows;
  if (source) {
    rows = all(
      `SELECT * FROM activity_events WHERE source = :source ORDER BY created_at DESC LIMIT :limit`,
      { ':source': source, ':limit': limit }
    );
  } else {
    rows = all(
      `SELECT * FROM activity_events ORDER BY created_at DESC LIMIT :limit`,
      { ':limit': limit }
    );
  }

  res.json({ ok: true, events: rows });
});

// GET /preferences — per-app usage stats
router.get('/preferences', (req, res) => {
  const rows = all(
    `SELECT app_name,
            COUNT(*) as opens,
            MAX(created_at) as last_seen,
            AVG(duration_ms) as avg_duration_ms
     FROM activity_events
     WHERE event_type = 'app_focus'
     GROUP BY app_name
     ORDER BY opens DESC
     LIMIT 100`
  );

  res.json({ ok: true, preferences: rows });
});

// GET /match?q=spotify — fuzzy match app_name or window_title
router.get('/match', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, matches: [] });

  const rows = all(
    `SELECT * FROM activity_events
     WHERE app_name LIKE '%' || :q || '%'
        OR window_title LIKE '%' || :q || '%'
     ORDER BY created_at DESC
     LIMIT 5`,
    { ':q': q }
  );

  res.json({ ok: true, matches: rows });
});

export default router;

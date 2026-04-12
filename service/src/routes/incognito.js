// Tier 0 Phase 4 — Incognito Mode
//
// Routes:
//   GET  /status   — is incognito active for this user?
//   POST /start    — enter incognito mode (optional TTL in minutes, default 60)
//   POST /stop     — exit incognito mode, returns summary
//   GET  /review   — preview incognito events before deletion
//   POST /confirm  — confirm deletion of incognito events
//   POST /keep     — move incognito events to regular events table

import { Router } from 'express';
import { db, run, get, all, insert } from '../db.js';
import { auditLog } from '../middleware/org-context.js';

const router = Router();
const PERSONAL_ORG_ID = 'org_personal';

// ============================================================
// Helpers
// ============================================================

/** Check if incognito is active for a user */
export function isIncognito(userId) {
  const row = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `incognito_active_${userId}` }
  );
  if (!row) return null;
  try {
    const state = JSON.parse(row.value);
    if (!state.active) return null;
    return state;
  } catch { return null; }
}

/** Delete expired incognito events (where expires_at < now) */
export function cleanupExpiredIncognito() {
  const now = Date.now();
  const result = run(
    `DELETE FROM incognito_events WHERE expires_at < :now`,
    { ':now': now }
  );
  if (result.changes > 0) {
    console.log(`[Incognito] Cleaned up ${result.changes} expired incognito events`);
  }
  return result.changes;
}

/** Log an event to incognito_events instead of regular events */
export function logIncognitoEvent(userId, eventType, data, ttlMinutes = 60) {
  const now = Date.now();
  const expiresAt = now + (ttlMinutes * 60 * 1000);
  const payload = JSON.stringify({
    event_type: eventType,
    data: typeof data === 'string' ? data : JSON.stringify(data),
    created_at: now,
  });
  return insert(
    `INSERT INTO incognito_events (user_id, payload, created_at, expires_at)
     VALUES (:uid, :payload, :now, :expires)`,
    { ':uid': userId, ':payload': payload, ':now': now, ':expires': expiresAt }
  );
}

// ============================================================
// Routes
// ============================================================

// GET /status — is incognito active for this user?
router.get('/status', (req, res) => {
  const userId = req.user.id;
  const state = isIncognito(userId);
  if (!state) {
    return res.json({ active: false });
  }
  const eventCount = get(
    `SELECT COUNT(*) as c FROM incognito_events WHERE user_id = :uid`,
    { ':uid': userId }
  )?.c || 0;
  res.json({
    active: true,
    started_at: state.started_at,
    ttl_minutes: state.ttl_minutes,
    org_id: state.org_id,
    event_count: eventCount,
  });
});

// POST /start — enter incognito mode
router.post('/start', (req, res) => {
  const userId = req.user.id;
  const orgId = req.org_id;
  const ttlMinutes = req.body.ttl_minutes || 60;

  // Check org policy
  if (orgId !== PERSONAL_ORG_ID) {
    let orgRow = null;
    try {
      orgRow = get(`SELECT policy_incognito_allowed FROM orgs WHERE id = :oid`, { ':oid': orgId });
    } catch {
      // orgs table may not have the column — allow by default
    }
    if (orgRow && orgRow.policy_incognito_allowed === 0) {
      return res.status(403).json({ error: 'Incognito mode is not allowed by your organization' });
    }
  }

  // Check if already active
  const existing = isIncognito(userId);
  if (existing) {
    return res.status(409).json({ error: 'Incognito mode is already active', state: existing });
  }

  const state = {
    active: true,
    started_at: Date.now(),
    ttl_minutes: ttlMinutes,
    org_id: orgId,
  };

  run(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (:key, :val, datetime('now','localtime'))`,
    { ':key': `incognito_active_${userId}`, ':val': JSON.stringify(state) }
  );

  auditLog(req, 'incognito_start', null, { ttl_minutes: ttlMinutes });
  console.log(`[Incognito] User ${userId} entered incognito mode (TTL: ${ttlMinutes}m)`);
  res.json({ ok: true, state });
});

// POST /stop — exit incognito mode
router.post('/stop', (req, res) => {
  const userId = req.user.id;
  const state = isIncognito(userId);

  if (!state) {
    return res.status(400).json({ error: 'Incognito mode is not active' });
  }

  // Deactivate but keep events for review
  const newState = { ...state, active: false, stopped_at: Date.now() };
  run(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (:key, :val, datetime('now','localtime'))`,
    { ':key': `incognito_active_${userId}`, ':val': JSON.stringify(newState) }
  );

  const eventCount = get(
    `SELECT COUNT(*) as c FROM incognito_events WHERE user_id = :uid`,
    { ':uid': userId }
  )?.c || 0;

  // Set auto-delete TTL: 24 hours from now for all current events
  const autoDeleteAt = Date.now() + (24 * 60 * 60 * 1000);
  run(
    `UPDATE incognito_events SET expires_at = :expires WHERE user_id = :uid AND expires_at > :expires`,
    { ':uid': userId, ':expires': autoDeleteAt }
  );

  auditLog(req, 'incognito_stop', null, { event_count: eventCount });
  console.log(`[Incognito] User ${userId} exited incognito mode (${eventCount} events pending review)`);
  res.json({
    ok: true,
    event_count: eventCount,
    message: `Incognito stopped. ${eventCount} events pending review. Call /review to inspect, /confirm to delete, or /keep to save. Auto-deletes in 24 hours.`,
  });
});

// GET /review — preview incognito events before deletion
router.get('/review', (req, res) => {
  const userId = req.user.id;
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;

  const events = all(
    `SELECT id, payload, created_at, expires_at FROM incognito_events
     WHERE user_id = :uid ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    { ':uid': userId, ':limit': limit, ':offset': offset }
  );

  const total = get(
    `SELECT COUNT(*) as c FROM incognito_events WHERE user_id = :uid`,
    { ':uid': userId }
  )?.c || 0;

  // Parse payloads for display
  const parsed = events.map(e => {
    let payload = {};
    try { payload = JSON.parse(e.payload); } catch {}
    return {
      id: e.id,
      event_type: payload.event_type || 'unknown',
      data: payload.data || null,
      created_at: e.created_at,
      expires_at: e.expires_at,
    };
  });

  res.json({ events: parsed, total, limit, offset });
});

// POST /confirm — confirm deletion of incognito events
router.post('/confirm', (req, res) => {
  const userId = req.user.id;

  const count = get(
    `SELECT COUNT(*) as c FROM incognito_events WHERE user_id = :uid`,
    { ':uid': userId }
  )?.c || 0;

  if (count === 0) {
    return res.json({ ok: true, deleted: 0, message: 'No incognito events to delete' });
  }

  run(
    `DELETE FROM incognito_events WHERE user_id = :uid`,
    { ':uid': userId }
  );

  // Clean up the incognito state setting
  run(
    `DELETE FROM settings WHERE key = :key`,
    { ':key': `incognito_active_${userId}` }
  );

  auditLog(req, 'incognito_confirm_delete', null, { deleted_count: count });
  console.log(`[Incognito] User ${userId} confirmed deletion of ${count} incognito events`);
  res.json({ ok: true, deleted: count });
});

// POST /keep — move incognito events to regular events table
router.post('/keep', (req, res) => {
  const userId = req.user.id;
  const orgId = req.org_id;

  const events = all(
    `SELECT id, user_id, payload, created_at FROM incognito_events WHERE user_id = :uid`,
    { ':uid': userId }
  );

  if (events.length === 0) {
    return res.json({ ok: true, kept: 0, message: 'No incognito events to keep' });
  }

  // Move each event to the regular events table
  const moveTransaction = db.transaction(() => {
    let moved = 0;
    for (const e of events) {
      let payload = {};
      try { payload = JSON.parse(e.payload); } catch { continue; }

      const sessionId = `incognito-${userId}-${e.created_at}`;
      const eventType = payload.event_type || 'IncognitoEvent';
      const data = payload.data || '{}';

      insert(
        `INSERT INTO events (session_id, event_type, data, user_id, org_id)
         VALUES (:sid, :type, :data, :uid, :oid)`,
        { ':sid': sessionId, ':type': eventType, ':data': data, ':uid': userId, ':oid': orgId }
      );
      moved++;
    }

    // Delete from incognito_events
    run(
      `DELETE FROM incognito_events WHERE user_id = :uid`,
      { ':uid': userId }
    );

    // Clean up the incognito state setting
    run(
      `DELETE FROM settings WHERE key = :key`,
      { ':key': `incognito_active_${userId}` }
    );

    return moved;
  });

  const moved = moveTransaction();
  auditLog(req, 'incognito_keep', null, { kept_count: moved });
  console.log(`[Incognito] User ${userId} kept ${moved} incognito events (moved to regular events)`);
  res.json({ ok: true, kept: moved });
});

export default router;

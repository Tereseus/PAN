// Action Preference Store — remembers which device+app to use for each action type.
// Used by router.js to resolve "play movie" → VLC on the mini PC without asking every time.

import { Router } from 'express';
import { get, all, run, insert, getScoped, allScoped, runScoped, insertScoped } from '../db.js';

const router = Router();

// ── Preference resolution (exported for use by router.js) ────────────────────

/**
 * Resolve what device+app to use for an action.
 * Checks user preference first, then org default, then returns null (ask user).
 *
 * @param {object} req - Express request (used for org_id scoping)
 * @param {string} action_type - e.g. "play_movie", "play_music"
 * @param {string} user_id    - requesting user
 * @param {string} org_id     - org context
 * @returns {{ device_id, device_type, app, args, confidence, source } | null}
 */
export function resolvePreference(req, action_type, user_id, org_id) {
  // 1. User-specific preference
  const userPref = get(
    `SELECT * FROM action_preferences WHERE action_type = :a AND user_id = :u AND org_id = :o LIMIT 1`,
    { ':a': action_type, ':u': user_id, ':o': org_id }
  );
  if (userPref) return { ...userPref, source: 'user' };

  // 2. Org-wide default
  const orgPref = get(
    `SELECT * FROM action_preferences WHERE action_type = :a AND user_id = 'default' AND org_id = :o LIMIT 1`,
    { ':a': action_type, ':o': org_id }
  );
  if (orgPref) return { ...orgPref, source: 'org' };

  return null; // unknown — need to ask
}

/**
 * Resolve a device alias ("projector") to a device hostname.
 * First checks direct hostname/name match in devices table, then device_aliases.
 *
 * @param {string} alias  - friendly name, e.g. "projector"
 * @param {string} org_id - org context
 * @returns {string|null} - resolved hostname, or null if not found
 */
export function resolveDeviceAlias(alias, org_id) {
  if (!alias) return null;
  const normalized = alias.toLowerCase().trim();

  // Direct hostname/name match first
  const direct = get(
    `SELECT hostname FROM devices WHERE (LOWER(hostname) = :a OR LOWER(name) = :a) AND org_id = :o LIMIT 1`,
    { ':a': normalized, ':o': org_id }
  );
  if (direct) return direct.hostname;

  // Alias table
  const aliasRow = get(
    `SELECT device_id FROM device_aliases WHERE LOWER(alias) = :a AND org_id = :o LIMIT 1`,
    { ':a': normalized, ':o': org_id }
  );
  return aliasRow?.device_id || null;
}

// ── REST API ──────────────────────────────────────────────────────────────────

// GET /api/v1/preferences — list all preferences for current user+org
router.get('/', (req, res) => {
  const user_id = req.user?.id || req.headers['x-user-id'] || 'default';
  const org_id = req.org_id || 'org_personal';
  const prefs = all(
    `SELECT * FROM action_preferences WHERE org_id = :o AND (user_id = :u OR user_id = 'default') ORDER BY action_type`,
    { ':o': org_id, ':u': user_id }
  );
  res.json({ preferences: prefs });
});

// POST /api/v1/preferences — set or update a preference
router.post('/', (req, res) => {
  const { action_type, device_id, device_type, app, args, scope = 'user' } = req.body;
  if (!action_type) return res.status(400).json({ error: 'action_type required' });

  const user_id = scope === 'org' ? 'default' : (req.user?.id || req.headers['x-user-id'] || 'default');
  const org_id = req.org_id || 'org_personal';

  try {
    const existing = get(
      `SELECT id FROM action_preferences WHERE action_type = :a AND user_id = :u AND org_id = :o`,
      { ':a': action_type, ':u': user_id, ':o': org_id }
    );
    if (existing) {
      run(
        `UPDATE action_preferences SET device_id=:d, device_type=:dt, app=:app, args=:args,
         use_count=use_count+1, last_used=datetime('now','localtime'), confidence=MIN(confidence+0.1, 1.0)
         WHERE id=:id`,
        { ':d': device_id || null, ':dt': device_type || null, ':app': app || null,
          ':args': args ? JSON.stringify(args) : null, ':id': existing.id }
      );
    } else {
      insert(
        `INSERT INTO action_preferences (action_type, user_id, org_id, device_id, device_type, app, args)
         VALUES (:a, :u, :o, :d, :dt, :app, :args)`,
        { ':a': action_type, ':u': user_id, ':o': org_id,
          ':d': device_id || null, ':dt': device_type || null, ':app': app || null,
          ':args': args ? JSON.stringify(args) : null }
      );
    }
    res.json({ ok: true, scope: user_id === 'default' ? 'org' : 'user' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/v1/preferences/:action_type — remove a preference
router.delete('/:action_type', (req, res) => {
  const user_id = req.user?.id || req.headers['x-user-id'] || 'default';
  const org_id = req.org_id || 'org_personal';
  run(
    `DELETE FROM action_preferences WHERE action_type = :a AND user_id = :u AND org_id = :o`,
    { ':a': req.params.action_type, ':u': user_id, ':o': org_id }
  );
  res.json({ ok: true });
});

// POST /api/v1/preferences/confirm — user confirmed an action, boost confidence
router.post('/confirm', (req, res) => {
  const { action_type, device_id, device_type, app } = req.body;
  const user_id = req.user?.id || req.headers['x-user-id'] || 'default';
  const org_id = req.org_id || 'org_personal';

  try {
    const existing = get(
      `SELECT id FROM action_preferences WHERE action_type=:a AND user_id=:u AND org_id=:o`,
      { ':a': action_type, ':u': user_id, ':o': org_id }
    );
    if (existing) {
      run(
        `UPDATE action_preferences SET use_count=use_count+1, confidence=MIN(confidence+0.2, 1.0),
         last_used=datetime('now','localtime') WHERE id=:id`,
        { ':id': existing.id }
      );
    } else {
      insert(
        `INSERT INTO action_preferences (action_type, user_id, org_id, device_id, device_type, app, confidence)
         VALUES (:a, :u, :o, :d, :dt, :app, 0.8)`,
        { ':a': action_type, ':u': user_id, ':o': org_id,
          ':d': device_id || null, ':dt': device_type || null, ':app': app || null }
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Device aliases ────────────────────────────────────────────────────────────

// GET /api/v1/preferences/aliases — list all aliases for current org
router.get('/aliases', (req, res) => {
  const org_id = req.org_id || 'org_personal';
  const aliases = all(
    `SELECT da.*, d.name as device_name, d.device_type FROM device_aliases da
     LEFT JOIN devices d ON d.hostname = da.device_id
     WHERE da.org_id = :o ORDER BY da.alias`,
    { ':o': org_id }
  );
  res.json({ aliases });
});

// POST /api/v1/preferences/aliases — add or update an alias
router.post('/aliases', (req, res) => {
  const { alias, device_id } = req.body;
  if (!alias || !device_id) return res.status(400).json({ error: 'alias and device_id required' });
  const org_id = req.org_id || 'org_personal';
  try {
    run(
      `INSERT INTO device_aliases (alias, device_id, org_id) VALUES (LOWER(:a), :d, :o)
       ON CONFLICT(org_id, alias) DO UPDATE SET device_id=excluded.device_id`,
      { ':a': alias.trim(), ':d': device_id, ':o': org_id }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/v1/preferences/aliases/:alias — remove an alias
router.delete('/aliases/:alias', (req, res) => {
  const org_id = req.org_id || 'org_personal';
  run(
    `DELETE FROM device_aliases WHERE LOWER(alias) = LOWER(:a) AND org_id = :o`,
    { ':a': req.params.alias, ':o': org_id }
  );
  res.json({ ok: true });
});

export default router;

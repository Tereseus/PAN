// PAN Messaging Preferences — "how should PAN reach this person?"
//
// Two scopes:
//   user: per-human preferences (Dad's phone vs Mom's phone — different defaults)
//   org:  per-organization preferences (work org routes to Slack, personal to Discord)
//
// Two layers:
//   default_prefs     — scope-wide default channel(s) by media type
//   contact_prefs     — per-contact override ("Mom is always SMS")
//   channel_usage     — learned log of what actually worked (for auto-ranking fallbacks)
//
// Resolution order when "send X to Bob":
//   1. contact_prefs[current_user, Bob]   → if set, use it
//   2. contact_prefs[current_org,  Bob]   → org default for Bob
//   3. default_prefs[current_user]        → user's default channel for this media type
//   4. default_prefs[current_org]         → org default
//   5. channel_usage                      → most-recent-successful channel for Bob
//   6. error: "no channel known for Bob"

import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

const VALID_SCOPES = new Set(['user', 'org']);
const VALID_MEDIA = new Set(['text', 'image', 'voice', 'video', 'file']);

export function ensureMessagingPrefsSchema(database) {
  const d = database || db;
  d.exec(`
    CREATE TABLE IF NOT EXISTS messaging_default_prefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL CHECK(scope IN ('user','org')),
      scope_id TEXT NOT NULL,
      media TEXT NOT NULL DEFAULT 'text',   -- text|image|voice|video|file
      channel TEXT NOT NULL,                -- discord|slack|email|sms|pan|whatsapp|signal|telegram|imessage
      fallback_channels TEXT,               -- JSON array of channel strings, tried in order
      updated_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      UNIQUE(scope, scope_id, media)
    );

    CREATE TABLE IF NOT EXISTS messaging_contact_prefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL CHECK(scope IN ('user','org')),
      scope_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      media TEXT NOT NULL DEFAULT 'text',
      channel TEXT NOT NULL,
      address TEXT,                         -- specific address within channel (e.g. DM id, email addr)
      reason TEXT,                          -- 'manual' | 'learned' | 'imported'
      updated_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
      UNIQUE(scope, scope_id, contact_id, media)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_lookup ON messaging_contact_prefs(scope, scope_id, contact_id, media);

    CREATE TABLE IF NOT EXISTS messaging_channel_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      org_id TEXT,
      contact_id TEXT,
      channel TEXT NOT NULL,
      media TEXT DEFAULT 'text',
      direction TEXT CHECK(direction IN ('sent','received')),
      success INTEGER DEFAULT 1,
      occurred_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_mcu_contact ON messaging_channel_usage(contact_id, channel, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mcu_user ON messaging_channel_usage(user_id, contact_id);
  `);
}

// ─── Read: resolve preferred channel for a (scope, scope_id, contact_id, media) ───
// GET /api/v1/messaging-prefs/resolve?user_id=X&org_id=Y&contact_id=Z&media=text
router.get('/resolve', (req, res) => {
  const { user_id, org_id, contact_id, media = 'text' } = req.query;
  if (!contact_id) return res.status(400).json({ ok: false, error: 'contact_id required' });
  if (!VALID_MEDIA.has(media)) return res.status(400).json({ ok: false, error: `invalid media: ${media}` });

  const steps = [];

  // 1. user-level contact override
  if (user_id) {
    const r = db.prepare(`
      SELECT channel, address, reason FROM messaging_contact_prefs
      WHERE scope='user' AND scope_id=? AND contact_id=? AND media=?
    `).get(user_id, contact_id, media);
    if (r) { steps.push({ source: 'user-contact', ...r }); return res.json({ ok: true, resolved: r, source: 'user-contact', steps }); }
    steps.push({ source: 'user-contact', hit: false });
  }

  // 2. org-level contact override
  if (org_id) {
    const r = db.prepare(`
      SELECT channel, address, reason FROM messaging_contact_prefs
      WHERE scope='org' AND scope_id=? AND contact_id=? AND media=?
    `).get(org_id, contact_id, media);
    if (r) { steps.push({ source: 'org-contact', ...r }); return res.json({ ok: true, resolved: r, source: 'org-contact', steps }); }
    steps.push({ source: 'org-contact', hit: false });
  }

  // 3. user default for this media
  if (user_id) {
    const r = db.prepare(`
      SELECT channel, fallback_channels FROM messaging_default_prefs
      WHERE scope='user' AND scope_id=? AND media=?
    `).get(user_id, media);
    if (r) { steps.push({ source: 'user-default', ...r }); return res.json({ ok: true, resolved: r, source: 'user-default', steps }); }
    steps.push({ source: 'user-default', hit: false });
  }

  // 4. org default
  if (org_id) {
    const r = db.prepare(`
      SELECT channel, fallback_channels FROM messaging_default_prefs
      WHERE scope='org' AND scope_id=? AND media=?
    `).get(org_id, media);
    if (r) { steps.push({ source: 'org-default', ...r }); return res.json({ ok: true, resolved: r, source: 'org-default', steps }); }
    steps.push({ source: 'org-default', hit: false });
  }

  // 5. learned fallback: most-recently-successful channel for this contact
  const r = db.prepare(`
    SELECT channel, COUNT(*) as n FROM messaging_channel_usage
    WHERE contact_id=? AND success=1 AND media=?
    GROUP BY channel ORDER BY MAX(occurred_at) DESC LIMIT 1
  `).get(contact_id, media);
  if (r) { steps.push({ source: 'learned', ...r }); return res.json({ ok: true, resolved: { channel: r.channel }, source: 'learned', steps }); }
  steps.push({ source: 'learned', hit: false });

  res.status(404).json({ ok: false, error: 'no channel known for this contact', steps });
});

// ─── Write: set default preference ───
// POST /api/v1/messaging-prefs/default  { scope, scope_id, media, channel, fallback_channels[] }
router.post('/default', (req, res) => {
  const { scope, scope_id, media = 'text', channel, fallback_channels } = req.body || {};
  if (!VALID_SCOPES.has(scope)) return res.status(400).json({ ok: false, error: 'scope must be user|org' });
  if (!scope_id || !channel) return res.status(400).json({ ok: false, error: 'scope_id and channel required' });
  if (!VALID_MEDIA.has(media)) return res.status(400).json({ ok: false, error: `invalid media: ${media}` });

  const fb = fallback_channels ? JSON.stringify(fallback_channels) : null;
  db.prepare(`
    INSERT INTO messaging_default_prefs (scope, scope_id, media, channel, fallback_channels, updated_at)
    VALUES (?, ?, ?, ?, ?, CAST(strftime('%s','now') AS INTEGER) * 1000)
    ON CONFLICT(scope, scope_id, media) DO UPDATE SET
      channel=excluded.channel,
      fallback_channels=excluded.fallback_channels,
      updated_at=excluded.updated_at
  `).run(scope, scope_id, media, channel, fb);
  res.json({ ok: true });
});

// ─── Write: set contact-specific preference ───
// POST /api/v1/messaging-prefs/contact  { scope, scope_id, contact_id, media, channel, address, reason }
router.post('/contact', (req, res) => {
  const { scope, scope_id, contact_id, media = 'text', channel, address, reason = 'manual' } = req.body || {};
  if (!VALID_SCOPES.has(scope)) return res.status(400).json({ ok: false, error: 'scope must be user|org' });
  if (!scope_id || !contact_id || !channel) return res.status(400).json({ ok: false, error: 'scope_id, contact_id, channel required' });
  if (!VALID_MEDIA.has(media)) return res.status(400).json({ ok: false, error: `invalid media: ${media}` });

  db.prepare(`
    INSERT INTO messaging_contact_prefs (scope, scope_id, contact_id, media, channel, address, reason, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CAST(strftime('%s','now') AS INTEGER) * 1000)
    ON CONFLICT(scope, scope_id, contact_id, media) DO UPDATE SET
      channel=excluded.channel,
      address=excluded.address,
      reason=excluded.reason,
      updated_at=excluded.updated_at
  `).run(scope, scope_id, contact_id, media, channel, address || null, reason);
  res.json({ ok: true });
});

// ─── Write: log a channel usage (success/failure) so we learn over time ───
// POST /api/v1/messaging-prefs/usage  { user_id, org_id, contact_id, channel, media, direction, success }
router.post('/usage', (req, res) => {
  const { user_id, org_id, contact_id, channel, media = 'text', direction = 'sent', success = 1 } = req.body || {};
  if (!contact_id || !channel) return res.status(400).json({ ok: false, error: 'contact_id and channel required' });
  db.prepare(`
    INSERT INTO messaging_channel_usage (user_id, org_id, contact_id, channel, media, direction, success)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(user_id || null, org_id || null, contact_id, channel, media, direction, success ? 1 : 0);
  res.json({ ok: true });
});

// ─── Read: list prefs (for settings UI) ───
router.get('/defaults', (req, res) => {
  const { scope, scope_id } = req.query;
  if (!VALID_SCOPES.has(scope) || !scope_id) return res.status(400).json({ ok: false, error: 'scope and scope_id required' });
  const rows = db.prepare(`SELECT * FROM messaging_default_prefs WHERE scope=? AND scope_id=?`).all(scope, scope_id);
  res.json({ ok: true, defaults: rows });
});

router.get('/contacts', (req, res) => {
  const { scope, scope_id } = req.query;
  if (!VALID_SCOPES.has(scope) || !scope_id) return res.status(400).json({ ok: false, error: 'scope and scope_id required' });
  const rows = db.prepare(`SELECT * FROM messaging_contact_prefs WHERE scope=? AND scope_id=? ORDER BY updated_at DESC`).all(scope, scope_id);
  res.json({ ok: true, contacts: rows });
});

export default router;

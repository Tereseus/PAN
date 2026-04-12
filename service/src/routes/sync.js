// Tier 0 Phase 8 — Personal Data Sync
//
// Allows a user who belongs to an org to sync their personal data slice
// back to their personal PAN server. When someone uses PAN at work (org mode)
// their personal device also gets a copy of their own data.
//
// Routes:
//   GET  /config     — get sync configuration for current user
//   PUT  /config     — set personal PAN server URL + sync preferences
//   GET  /status     — last sync time, next sync, items synced, errors
//   GET  /export     — export current user's personal data slice (anonymized JSON bundle)
//   POST /export     — same as GET, accepts { since } in body for org-exit export
//   POST /ingest     — accept synced data from an org PAN (the receiving side)
//   POST /trigger    — manually trigger a sync now
//   POST /push       — alias for /trigger (spec-compatible name)
//   PUT  /lock       — org admin locks/unlocks personal sync for a user
//
// Exported:
//   startPersonalSync(intervalMs)  — start the background sync timer
//   stopPersonalSync()             — stop the background sync timer

import { Router } from 'express';
import { db, run, get, all, insert } from '../db.js';
import { auditLog } from '../middleware/org-context.js';
import { anonymizeForExport } from '../anonymize.js';

const router = Router();

// ============================================================
// Device lock middleware — blocks sync if org has locked it
// ============================================================
function checkDeviceLock(req, res, next) {
  const userId = req.user?.id;
  if (!userId) return next();

  // Check if this device has personal_sync_locked = true
  // Stored as a per-user setting that org admins can set
  const locked = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_locked_${userId}` }
  );
  if (locked?.value === 'true') {
    return res.status(403).json({
      error: 'personal_sync_locked',
      message: 'Personal data sync has been locked by your organization administrator.',
    });
  }
  next();
}

// ============================================================
// Settings helpers
// ============================================================

const SYNC_TYPES_ALL = ['events', 'memories', 'sensor_data', 'ai_usage'];

function getSyncConfig(userId) {
  const url = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_pan_url_${userId}` }
  );
  const enabled = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_enabled_${userId}` }
  );
  const interval = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_interval_minutes_${userId}` }
  );
  const types = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_types_${userId}` }
  );

  let syncTypes = SYNC_TYPES_ALL;
  if (types?.value) {
    try { syncTypes = JSON.parse(types.value); } catch {}
  }

  return {
    personal_pan_url: url?.value || null,
    sync_enabled: enabled?.value === 'true',
    sync_interval_minutes: interval ? parseInt(interval.value, 10) : 60,
    sync_types: syncTypes,
  };
}

function setSyncSetting(key, value) {
  run(
    `INSERT OR REPLACE INTO settings (key, value, updated_at)
     VALUES (:key, :val, datetime('now','localtime'))`,
    { ':key': key, ':val': String(value) }
  );
}

// ============================================================
// Org export policy check
// ============================================================
function getOrgExportPolicy(orgId) {
  if (!orgId || orgId === 'org_personal') {
    // Personal org — no restrictions
    return { allowed: true, allowed_types: SYNC_TYPES_ALL, restricted_types: [] };
  }

  try {
    const org = get(`SELECT policy_export_rules FROM orgs WHERE id = :id`, { ':id': orgId });
    if (!org?.policy_export_rules) {
      // No export policy defined — default to allow all
      return { allowed: true, allowed_types: SYNC_TYPES_ALL, restricted_types: [] };
    }

    const policy = JSON.parse(org.policy_export_rules);

    // Policy format: { allow_export: boolean, allowed_types: string[], blocked_types: string[] }
    if (policy.allow_export === false) {
      return { allowed: false, allowed_types: [], restricted_types: SYNC_TYPES_ALL };
    }

    const allowedTypes = policy.allowed_types || SYNC_TYPES_ALL;
    const blockedTypes = policy.blocked_types || [];
    const finalAllowed = allowedTypes.filter(t => !blockedTypes.includes(t));

    return {
      allowed: finalAllowed.length > 0,
      allowed_types: finalAllowed,
      restricted_types: blockedTypes,
    };
  } catch {
    // Malformed policy — default allow
    return { allowed: true, allowed_types: SYNC_TYPES_ALL, restricted_types: [] };
  }
}

// ============================================================
// Anonymize org-specific context from data
// ============================================================
function anonymizeOrgData(dataStr) {
  if (!dataStr || typeof dataStr !== 'string') return dataStr;

  // First pass: PII anonymization via anonymizeForExport
  let cleaned = anonymizeForExport(dataStr);

  // Second pass: strip org names/slugs from the text
  // Get all org names to strip them
  try {
    const orgs = all(`SELECT id, slug, name FROM orgs WHERE id != 'org_personal'`);
    for (const org of orgs) {
      if (org.name && org.name.length > 2) {
        cleaned = cleaned.replace(new RegExp(escapeRegex(org.name), 'gi'), '[ORG]');
      }
      if (org.slug && org.slug.length > 2) {
        cleaned = cleaned.replace(new RegExp(escapeRegex(org.slug), 'gi'), '[ORG]');
      }
    }
  } catch {
    // orgs table might not exist yet
  }

  return cleaned;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// GET /config — get sync configuration for current user
// ============================================================
router.get('/config', checkDeviceLock, (req, res) => {
  const userId = req.user.id;
  const config = getSyncConfig(userId);
  const policy = getOrgExportPolicy(req.org_id);

  res.json({
    ...config,
    org_policy: policy,
  });
});

// ============================================================
// PUT /config — set personal PAN server URL + sync preferences
// ============================================================
router.put('/config', checkDeviceLock, (req, res) => {
  const userId = req.user.id;
  const { personal_pan_url, sync_enabled, sync_interval_minutes, sync_types } = req.body;

  if (personal_pan_url !== undefined) {
    if (personal_pan_url !== null && personal_pan_url !== '') {
      try {
        new URL(personal_pan_url);
      } catch {
        return res.status(400).json({ error: 'Invalid URL for personal_pan_url' });
      }
    }
    setSyncSetting(`personal_pan_url_${userId}`, personal_pan_url || '');
  }

  if (sync_enabled !== undefined) {
    setSyncSetting(`personal_sync_enabled_${userId}`, sync_enabled ? 'true' : 'false');
  }

  if (sync_interval_minutes !== undefined) {
    const mins = parseInt(sync_interval_minutes, 10);
    if (isNaN(mins) || mins < 1) {
      return res.status(400).json({ error: 'sync_interval_minutes must be a positive integer' });
    }
    setSyncSetting(`personal_sync_interval_minutes_${userId}`, mins);
  }

  if (sync_types !== undefined) {
    if (!Array.isArray(sync_types)) {
      return res.status(400).json({ error: 'sync_types must be an array' });
    }
    const validTypes = sync_types.filter(t => SYNC_TYPES_ALL.includes(t));
    setSyncSetting(`personal_sync_types_${userId}`, JSON.stringify(validTypes));
  }

  auditLog(req, 'sync.config_update', null, {
    personal_pan_url: personal_pan_url !== undefined ? '(updated)' : '(unchanged)',
    sync_enabled,
    sync_interval_minutes,
    sync_types,
  });

  const config = getSyncConfig(userId);
  res.json({ ok: true, config });
});

// ============================================================
// GET /status — sync status overview
// ============================================================
router.get('/status', (req, res) => {
  const userId = req.user.id;
  const config = getSyncConfig(userId);

  const lastExport = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_last_export_${userId}` }
  );
  const lastImport = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_last_import_${userId}` }
  );
  const lastSync = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_last_sync_${userId}` }
  );
  const lastError = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_last_error_${userId}` }
  );
  const itemsSynced = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_items_synced_${userId}` }
  );

  const lastSyncTs = lastSync ? parseInt(lastSync.value, 10) : null;
  const intervalMs = config.sync_interval_minutes * 60 * 1000;
  const nextSync = config.sync_enabled && lastSyncTs
    ? lastSyncTs + intervalMs
    : null;

  // Check device lock
  const locked = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_locked_${userId}` }
  );

  res.json({
    enabled: config.sync_enabled,
    locked: locked?.value === 'true',
    personal_pan_url: config.personal_pan_url,
    interval_minutes: config.sync_interval_minutes,
    sync_types: config.sync_types,
    last_export: lastExport ? parseInt(lastExport.value, 10) : null,
    last_import: lastImport ? parseInt(lastImport.value, 10) : null,
    last_sync: lastSyncTs,
    next_sync: nextSync,
    last_error: lastError?.value || null,
    items_synced: itemsSynced ? parseInt(itemsSynced.value, 10) : 0,
  });
});

// ============================================================
// GET/POST /export — export current user's personal data slice (anonymized)
// POST body can include { since } for on-org-exit full export.
// ============================================================
function handleExport(req, res) {
  const userId = req.user.id;
  const orgId = req.org_id;
  const since = (req.query.since ? parseInt(req.query.since, 10) : null)
    || (req.body?.since ? parseInt(req.body.since, 10) : null);

  // Check org export policy
  const policy = getOrgExportPolicy(orgId);
  if (!policy.allowed) {
    return res.status(403).json({
      error: 'export_blocked',
      message: 'Organization policy does not allow data export.',
    });
  }

  const config = getSyncConfig(userId);
  const requestedTypes = config.sync_types.filter(t => policy.allowed_types.includes(t));

  const params = { ':uid': userId, ':oid': orgId };
  if (since) params[':since'] = since;

  const sinceClause = since ? `AND created_at > :since` : '';

  const bundle = {
    version: 1,
    exported_at: Date.now(),
    user_id: userId,
    source_org_id: orgId,
    since: since || null,
    counts: {},
    events: [],
    memory_items: [],
    ai_usage: [],
    sensor_toggles: [],
  };

  // Events
  if (requestedTypes.includes('events')) {
    const events = all(
      `SELECT id, session_id, event_type, data, created_at, user_id, org_id
       FROM events WHERE user_id = :uid AND org_id = :oid ${sinceClause}
       ORDER BY id ASC`,
      params
    );
    // Anonymize org context from event data
    bundle.events = events.map(e => ({
      ...e,
      data: anonymizeOrgData(e.data),
      // Strip org_id — it'll be tagged with source_org on ingest
      org_id: undefined,
    }));
    bundle.counts.events = bundle.events.length;
  }

  // Memories
  if (requestedTypes.includes('memories')) {
    const memoryItems = all(
      `SELECT id, session_id, category, content, metadata, created_at, user_id, org_id
       FROM memory_items WHERE user_id = :uid AND org_id = :oid ${sinceClause}
       ORDER BY id ASC`,
      params
    );
    bundle.memory_items = memoryItems.map(m => ({
      ...m,
      content: anonymizeOrgData(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
      metadata: m.metadata ? anonymizeOrgData(m.metadata) : null,
      org_id: undefined,
    }));
    bundle.counts.memory_items = bundle.memory_items.length;
  }

  // AI usage
  if (requestedTypes.includes('ai_usage')) {
    try {
      const aiParams = { ':oid': orgId };
      const aiSinceClause = since ? `AND ts > :since` : '';
      if (since) aiParams[':since'] = since;

      const aiUsage = all(
        `SELECT id, caller, model, input_tokens, output_tokens, cost_usd, ts, org_id
         FROM ai_usage WHERE org_id = :oid ${aiSinceClause}
         ORDER BY id ASC`,
        aiParams
      );
      bundle.ai_usage = aiUsage.map(a => ({ ...a, org_id: undefined }));
      bundle.counts.ai_usage = bundle.ai_usage.length;
    } catch {
      bundle.counts.ai_usage = 0;
    }
  }

  // Sensor data (sensor_toggles)
  if (requestedTypes.includes('sensor_data')) {
    try {
      const sensorToggles = all(
        `SELECT id, user_id, device_id, org_id, sensor, enabled, cadence_seconds, forced_by_org, updated_at
         FROM sensor_toggles WHERE user_id = :uid AND org_id = :oid
         ORDER BY id ASC`,
        { ':uid': userId, ':oid': orgId }
      );
      bundle.sensor_toggles = sensorToggles.map(t => ({ ...t, org_id: undefined }));
      bundle.counts.sensor_toggles = bundle.sensor_toggles.length;
    } catch {
      bundle.counts.sensor_toggles = 0;
    }
  }

  // Record last export time
  setSyncSetting(`personal_sync_last_export_${userId}`, Date.now());

  auditLog(req, 'sync.export', null, {
    since,
    counts: bundle.counts,
    types: requestedTypes,
  });

  res.json(bundle);
}
router.get('/export', checkDeviceLock, handleExport);
router.post('/export', checkDeviceLock, handleExport);

// ============================================================
// POST /ingest — accept synced data from an org PAN (receiving side)
// Requires sender to be on Tailscale (100.x.x.x), localhost,
// or provide a valid shared secret via X-Pan-Sync-Secret header.
// ============================================================
function verifySyncSender(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1');
  const isTailscale = ip.startsWith('100.') || ip.startsWith('::ffff:100.');

  if (isLocalhost || isTailscale) return next();

  // Fallback: check shared secret header
  const secret = req.headers['x-pan-sync-secret'];
  if (secret) {
    const stored = get(
      `SELECT value FROM settings WHERE key = 'personal_sync_shared_secret'`
    );
    if (stored?.value && secret === stored.value) return next();
  }

  return res.status(403).json({
    error: 'sync_sender_denied',
    message: 'Sync ingest requires Tailscale VPN, localhost, or valid X-Pan-Sync-Secret header.',
  });
}

router.post('/ingest', verifySyncSender, (req, res) => {
  const userId = req.user.id;
  const bundle = req.body;

  if (!bundle || bundle.version !== 1) {
    return res.status(400).json({ error: 'Invalid sync bundle — expected version 1' });
  }

  // Only import data belonging to the authenticated user
  if (bundle.user_id && bundle.user_id !== userId) {
    return res.status(403).json({ error: 'Bundle user_id does not match authenticated user' });
  }

  const sourceOrg = bundle.source_org_id || 'unknown_org';
  const stats = { events: 0, memory_items: 0, ai_usage: 0, sensor_toggles: 0, skipped: 0 };

  const importTransaction = db.transaction(() => {
    // Import events — dedup by source_sync_id stored in data
    if (Array.isArray(bundle.events)) {
      for (const e of bundle.events) {
        if (!e.event_type || !e.data) continue;
        // Dedup: check for an existing event with same source ID
        // Store original source ID in event data for dedup
        const sourceId = e.id;
        const dataObj = typeof e.data === 'string' ? (() => { try { return JSON.parse(e.data); } catch { return {}; } })() : (e.data || {});
        dataObj._sync_source_id = sourceId;
        dataObj._sync_source_org = sourceOrg;
        const dataStr = JSON.stringify(dataObj);

        // Check for existing sync'd event with same source
        const existing = get(
          `SELECT id FROM events WHERE data LIKE :pattern AND user_id = :uid LIMIT 1`,
          { ':pattern': `%"_sync_source_id":${sourceId},"_sync_source_org":"${sourceOrg}"%`, ':uid': userId }
        );
        if (existing) {
          stats.skipped++;
          continue;
        }

        insert(
          `INSERT INTO events (session_id, event_type, data, user_id, org_id)
           VALUES (:sid, :type, :data, :uid, :oid)`,
          {
            ':sid': e.session_id || `sync-${sourceOrg}-${Date.now()}`,
            ':type': e.event_type,
            ':data': dataStr,
            ':uid': userId,
            ':oid': 'org_personal',
          }
        );
        stats.events++;
      }
    }

    // Import memory items — dedup by source sync metadata
    if (Array.isArray(bundle.memory_items)) {
      for (const m of bundle.memory_items) {
        if (!m.category || !m.content) continue;

        const sourceId = m.id;
        let metaObj = {};
        if (m.metadata) {
          try { metaObj = JSON.parse(m.metadata); } catch {}
        }
        metaObj._sync_source_id = sourceId;
        metaObj._sync_source_org = sourceOrg;
        const metaStr = JSON.stringify(metaObj);

        // Check for existing sync'd memory with same source
        const existing = get(
          `SELECT id FROM memory_items WHERE metadata LIKE :pattern AND user_id = :uid LIMIT 1`,
          { ':pattern': `%"_sync_source_id":${sourceId}%`, ':uid': userId }
        );
        if (existing) {
          stats.skipped++;
          continue;
        }

        insert(
          `INSERT INTO memory_items (session_id, category, content, metadata, user_id, org_id)
           VALUES (:sid, :cat, :content, :meta, :uid, :oid)`,
          {
            ':sid': m.session_id || `sync-${sourceOrg}-${Date.now()}`,
            ':cat': m.category,
            ':content': typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            ':meta': metaStr,
            ':uid': userId,
            ':oid': 'org_personal',
          }
        );
        stats.memory_items++;
      }
    }

    // Import AI usage
    if (Array.isArray(bundle.ai_usage)) {
      for (const a of bundle.ai_usage) {
        try {
          insert(
            `INSERT INTO ai_usage (caller, model, input_tokens, output_tokens, cost_usd, ts, org_id)
             VALUES (:caller, :model, :in, :out, :cost, :ts, :oid)`,
            {
              ':caller': a.caller ? `${a.caller}@${sourceOrg}` : `sync@${sourceOrg}`,
              ':model': a.model || 'unknown',
              ':in': a.input_tokens || 0,
              ':out': a.output_tokens || 0,
              ':cost': a.cost_usd || 0,
              ':ts': a.ts || Date.now(),
              ':oid': 'org_personal',
            }
          );
          stats.ai_usage++;
        } catch {
          stats.skipped++;
        }
      }
    }

    // Import sensor toggles — upsert by unique constraint
    if (Array.isArray(bundle.sensor_toggles)) {
      for (const t of bundle.sensor_toggles) {
        if (!t.sensor) continue;
        try {
          run(
            `INSERT INTO sensor_toggles (user_id, device_id, org_id, sensor, enabled, cadence_seconds, forced_by_org, updated_at)
             VALUES (:uid, :did, :oid, :sid, :en, :cad, :forced, :updated)
             ON CONFLICT(user_id, device_id, org_id, sensor)
             DO UPDATE SET enabled = :en, cadence_seconds = :cad, updated_at = :updated
             WHERE updated_at < :updated`,
            {
              ':uid': userId,
              ':did': t.device_id || 0,
              ':oid': 'org_personal',
              ':sid': t.sensor,
              ':en': t.enabled ? 1 : 0,
              ':cad': t.cadence_seconds || null,
              ':forced': 0, // Never import org-forced flags to personal
              ':updated': t.updated_at || Date.now(),
            }
          );
          stats.sensor_toggles++;
        } catch {
          stats.skipped++;
        }
      }
    }
  });

  importTransaction();

  // Record last import time
  setSyncSetting(`personal_sync_last_import_${userId}`, Date.now());

  auditLog(req, 'sync.ingest', null, { stats, source_org: sourceOrg });

  res.json({ ok: true, stats });
});

// ============================================================
// POST /trigger (alias: /push) — manually trigger a sync now
// ============================================================
async function handleSyncTrigger(req, res) {
  const userId = req.user.id;
  try {
    const result = await runSyncForUser(userId);
    auditLog(req, 'sync.push', null, { result_ok: result.ok });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
router.post('/trigger', checkDeviceLock, handleSyncTrigger);
router.post('/push', checkDeviceLock, handleSyncTrigger);

// ============================================================
// PUT /lock — org admin sets personal_sync_locked for a user
// ============================================================
router.put('/lock', (req, res) => {
  const { target_user_id, locked } = req.body;
  if (!target_user_id) {
    return res.status(400).json({ error: 'target_user_id is required' });
  }

  // Only org admins in non-personal orgs can lock sync
  const orgId = req.org_id;
  if (orgId === 'org_personal') {
    return res.status(403).json({ error: 'Cannot lock sync in personal org' });
  }

  setSyncSetting(`personal_sync_locked_${target_user_id}`, locked ? 'true' : 'false');

  auditLog(req, 'sync.lock_update', `user:${target_user_id}`, {
    locked: !!locked,
  });

  res.json({ ok: true, target_user_id, locked: !!locked });
});

// ============================================================
// Background sync logic
// ============================================================

async function runSyncForUser(userId) {
  const config = getSyncConfig(userId);

  if (!config.sync_enabled) {
    return { ok: false, reason: 'sync_disabled' };
  }

  if (!config.personal_pan_url) {
    return { ok: false, reason: 'no_server_url' };
  }

  // Check device lock
  const locked = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_locked_${userId}` }
  );
  if (locked?.value === 'true') {
    return { ok: false, reason: 'sync_locked' };
  }

  const serverUrl = config.personal_pan_url.replace(/\/+$/, '');

  // Get last sync timestamp for incremental sync
  const lastSync = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_last_sync_${userId}` }
  );
  const since = lastSync ? parseInt(lastSync.value, 10) : null;

  // Check org export policy
  const orgId = get(`SELECT last_active_org_id FROM users WHERE id = ?`, userId)?.last_active_org_id || 'org_personal';
  const policy = getOrgExportPolicy(orgId);
  if (!policy.allowed) {
    return { ok: false, reason: 'org_policy_blocks_export' };
  }

  const allowedTypes = config.sync_types.filter(t => policy.allowed_types.includes(t));

  try {
    // Step 1: Build export bundle (same logic as /export endpoint)
    const params = { ':uid': userId };
    if (since) params[':since'] = since;
    const sinceClause = since ? `AND created_at > :since` : '';

    const exportBundle = {
      version: 1,
      exported_at: Date.now(),
      user_id: userId,
      source_org_id: orgId,
      since,
      counts: {},
      events: [],
      memory_items: [],
      ai_usage: [],
      sensor_toggles: [],
    };

    if (allowedTypes.includes('events')) {
      const events = all(
        `SELECT id, session_id, event_type, data, created_at, user_id
         FROM events WHERE user_id = :uid ${sinceClause}
         ORDER BY id ASC`,
        params
      );
      exportBundle.events = events.map(e => ({
        ...e,
        data: anonymizeOrgData(e.data),
      }));
      exportBundle.counts.events = exportBundle.events.length;
    }

    if (allowedTypes.includes('memories')) {
      const memoryItems = all(
        `SELECT id, session_id, category, content, metadata, created_at, user_id
         FROM memory_items WHERE user_id = :uid ${sinceClause}
         ORDER BY id ASC`,
        params
      );
      exportBundle.memory_items = memoryItems.map(m => ({
        ...m,
        content: anonymizeOrgData(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
        metadata: m.metadata ? anonymizeOrgData(m.metadata) : null,
      }));
      exportBundle.counts.memory_items = exportBundle.memory_items.length;
    }

    // Step 2: Push to personal PAN server
    const pushResponse = await fetch(`${serverUrl}/api/v1/sync/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportBundle),
      signal: AbortSignal.timeout(30000),
    });

    if (!pushResponse.ok) {
      const errText = await pushResponse.text();
      throw new Error(`Push failed: ${pushResponse.status} ${errText}`);
    }

    const pushResult = await pushResponse.json();

    // Step 3: Pull from personal PAN server (bidirectional sync)
    const sinceParam = since ? `?since=${since}` : '';
    const pullResponse = await fetch(`${serverUrl}/api/v1/sync/export${sinceParam}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    let pullStats = { events: 0, memory_items: 0, skipped: 0 };
    if (pullResponse.ok) {
      const pullBundle = await pullResponse.json();
      if (pullBundle?.version === 1) {
        const importTx = db.transaction(() => {
          if (Array.isArray(pullBundle.events)) {
            for (const e of pullBundle.events) {
              if (!e.event_type || !e.data) continue;
              const existing = e.id ? get(`SELECT id FROM events WHERE id = :id`, { ':id': e.id }) : null;
              if (existing) { pullStats.skipped++; continue; }
              insert(
                `INSERT INTO events (session_id, event_type, data, user_id, org_id)
                 VALUES (:sid, :type, :data, :uid, :oid)`,
                {
                  ':sid': e.session_id || `sync-pull-${Date.now()}`,
                  ':type': e.event_type,
                  ':data': typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
                  ':uid': userId,
                  ':oid': e.org_id || 'org_personal',
                }
              );
              pullStats.events++;
            }
          }
          if (Array.isArray(pullBundle.memory_items)) {
            for (const m of pullBundle.memory_items) {
              if (!m.category || !m.content) continue;
              const existing = m.id ? get(`SELECT id FROM memory_items WHERE id = :id`, { ':id': m.id }) : null;
              if (existing) { pullStats.skipped++; continue; }
              insert(
                `INSERT INTO memory_items (session_id, category, content, metadata, user_id, org_id)
                 VALUES (:sid, :cat, :content, :meta, :uid, :oid)`,
                {
                  ':sid': m.session_id || `sync-pull-${Date.now()}`,
                  ':cat': m.category,
                  ':content': typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                  ':meta': m.metadata || null,
                  ':uid': userId,
                  ':oid': m.org_id || 'org_personal',
                }
              );
              pullStats.memory_items++;
            }
          }
        });
        importTx();
      }
    }

    // Record successful sync
    const now = Date.now();
    const totalSynced = (exportBundle.counts.events || 0) + (exportBundle.counts.memory_items || 0) + pullStats.events + pullStats.memory_items;
    setSyncSetting(`personal_sync_last_sync_${userId}`, now);
    setSyncSetting(`personal_sync_last_error_${userId}`, '');

    // Accumulate items synced
    const prevSynced = get(`SELECT value FROM settings WHERE key = :key`, { ':key': `personal_sync_items_synced_${userId}` });
    const prevCount = prevSynced ? parseInt(prevSynced.value, 10) : 0;
    setSyncSetting(`personal_sync_items_synced_${userId}`, prevCount + totalSynced);

    console.log(`[PersonalSync] User ${userId} synced: pushed ${exportBundle.counts.events || 0} events, pulled ${pullStats.events} events`);

    return {
      ok: true,
      pushed: pushResult.stats || {},
      pulled: pullStats,
      synced_at: now,
    };
  } catch (err) {
    const errorMsg = err.message || String(err);
    setSyncSetting(`personal_sync_last_error_${userId}`, errorMsg);
    console.error(`[PersonalSync] Sync failed for user ${userId}: ${errorMsg}`);
    return { ok: false, reason: 'sync_error', error: errorMsg };
  }
}

// ============================================================
// Background sync timer management
// ============================================================

let _syncTimer = null;
let _syncIntervalMs = 60 * 60 * 1000; // default 1 hour

/**
 * Start the background personal sync timer.
 * Runs for all users that have sync enabled.
 * @param {number} intervalMs — how often to run (default: 1 hour)
 */
export function startPersonalSync(intervalMs = 60 * 60 * 1000) {
  stopPersonalSync();
  _syncIntervalMs = intervalMs;

  console.log(`[PersonalSync] Background sync started (interval: ${Math.round(intervalMs / 60000)}min)`);

  _syncTimer = setInterval(async () => {
    try {
      // Find all users with sync enabled
      const enabledUsers = all(
        `SELECT key, value FROM settings WHERE key LIKE 'personal_sync_enabled_%' AND value = 'true'`
      );

      for (const row of enabledUsers) {
        const userId = parseInt(row.key.replace('personal_sync_enabled_', ''), 10);
        if (isNaN(userId)) continue;

        try {
          await runSyncForUser(userId);
        } catch (err) {
          console.error(`[PersonalSync] Background sync failed for user ${userId}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[PersonalSync] Background sync cycle error: ${err.message}`);
    }
  }, intervalMs);
}

/**
 * Stop the background personal sync timer.
 */
export function stopPersonalSync() {
  if (_syncTimer) {
    clearInterval(_syncTimer);
    _syncTimer = null;
    console.log('[PersonalSync] Background sync stopped');
  }
}

export default router;

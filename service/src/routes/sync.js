// Tier 0 Phase 8 — Personal Data Sync
//
// Allows a user who belongs to an org to sync their personal data slice
// back to their personal PAN server. When someone uses PAN at work (org mode)
// their personal device also gets a copy of their own data.
//
// Routes:
//   GET  /export    — export current user's personal data slice (JSON bundle)
//   POST /import    — import a JSON bundle, dedup by ID, user-scoped
//   GET  /status    — last sync time, items synced, next scheduled, connection
//   GET  /settings  — get personal sync settings
//   PUT  /settings  — update personal sync settings
//
// Exported:
//   startPersonalSync(userId)  — callable by Steward for background sync

import { Router } from 'express';
import { db, run, get, all, insert } from '../db.js';
import { auditLog } from '../middleware/org-context.js';

const router = Router();

// ============================================================
// Settings helpers
// ============================================================

function getSyncSettings(userId) {
  const url = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_pan_server_url_${userId}` }
  );
  const enabled = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_enabled_${userId}` }
  );
  const interval = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_interval_minutes_${userId}` }
  );

  return {
    personal_pan_server_url: url?.value || null,
    personal_sync_enabled: enabled?.value === 'true',
    personal_sync_interval_minutes: interval ? parseInt(interval.value, 10) : 60,
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
// GET /settings — get personal sync settings
// ============================================================
router.get('/settings', (req, res) => {
  const userId = req.user.id;
  const settings = getSyncSettings(userId);
  res.json(settings);
});

// ============================================================
// PUT /settings — update personal sync settings
// ============================================================
router.put('/settings', (req, res) => {
  const userId = req.user.id;
  const { personal_pan_server_url, personal_sync_enabled, personal_sync_interval_minutes } = req.body;

  if (personal_pan_server_url !== undefined) {
    // Basic URL validation
    if (personal_pan_server_url !== null && personal_pan_server_url !== '') {
      try {
        new URL(personal_pan_server_url);
      } catch {
        return res.status(400).json({ error: 'Invalid URL for personal_pan_server_url' });
      }
    }
    setSyncSetting(`personal_pan_server_url_${userId}`, personal_pan_server_url || '');
  }

  if (personal_sync_enabled !== undefined) {
    setSyncSetting(`personal_sync_enabled_${userId}`, personal_sync_enabled ? 'true' : 'false');
  }

  if (personal_sync_interval_minutes !== undefined) {
    const mins = parseInt(personal_sync_interval_minutes, 10);
    if (isNaN(mins) || mins < 1) {
      return res.status(400).json({ error: 'personal_sync_interval_minutes must be a positive integer' });
    }
    setSyncSetting(`personal_sync_interval_minutes_${userId}`, mins);
  }

  auditLog(req, 'sync.settings_update', null, {
    personal_pan_server_url: personal_pan_server_url !== undefined ? '(updated)' : '(unchanged)',
    personal_sync_enabled,
    personal_sync_interval_minutes,
  });

  const settings = getSyncSettings(userId);
  res.json({ ok: true, settings });
});

// ============================================================
// GET /export — export current user's personal data slice
// ============================================================
router.get('/export', (req, res) => {
  const userId = req.user.id;
  const orgId = req.org_id;
  const since = req.query.since ? parseInt(req.query.since, 10) : null;

  const sinceClause = since
    ? `AND created_at > :since`
    : '';
  const sinceTimestampClause = since
    ? `AND timestamp > :since`
    : '';

  const params = { ':uid': userId, ':oid': orgId };
  if (since) params[':since'] = since;

  // Events — user's events in this org
  const events = all(
    `SELECT id, session_id, event_type, data, created_at, user_id, org_id
     FROM events WHERE user_id = :uid AND org_id = :oid ${sinceClause}
     ORDER BY id ASC`,
    params
  );

  // Memory items — user's memory items in this org
  const memoryItems = all(
    `SELECT id, session_id, category, content, metadata, created_at, user_id, org_id
     FROM memory_items WHERE user_id = :uid AND org_id = :oid ${sinceClause}
     ORDER BY id ASC`,
    params
  );

  // AI usage — scoped to org (ai_usage may not have user_id, so scope by org only)
  let aiUsage = [];
  try {
    // ai_usage has org_id but may not have user_id — export all for this org
    // since it tracks the user's AI calls within this org context
    const aiParams = { ':oid': orgId };
    const aiSinceClause = since ? `AND ts > :since` : '';
    if (since) aiParams[':since'] = since;

    aiUsage = all(
      `SELECT id, caller, model, input_tokens, output_tokens, cost_usd, ts, org_id
       FROM ai_usage WHERE org_id = :oid ${aiSinceClause}
       ORDER BY id ASC`,
      aiParams
    );
  } catch {
    // ai_usage table might have different columns — skip gracefully
  }

  // Sensor toggles — user's sensor preferences
  let sensorToggles = [];
  try {
    sensorToggles = all(
      `SELECT id, user_id, device_id, org_id, sensor, enabled, cadence_seconds, forced_by_org, updated_at
       FROM sensor_toggles WHERE user_id = :uid AND org_id = :oid
       ORDER BY id ASC`,
      { ':uid': userId, ':oid': orgId }
    );
  } catch {
    // sensor_toggles may not exist — skip gracefully
  }

  const bundle = {
    version: 1,
    exported_at: Date.now(),
    user_id: userId,
    org_id: orgId,
    since: since || null,
    counts: {
      events: events.length,
      memory_items: memoryItems.length,
      ai_usage: aiUsage.length,
      sensor_toggles: sensorToggles.length,
    },
    events,
    memory_items: memoryItems,
    ai_usage: aiUsage,
    sensor_toggles: sensorToggles,
  };

  // Record last export time
  setSyncSetting(`personal_sync_last_export_${userId}`, Date.now());

  auditLog(req, 'sync.export', null, {
    since,
    counts: bundle.counts,
  });

  res.json(bundle);
});

// ============================================================
// POST /import — import a JSON bundle, dedup, user-scoped
// ============================================================
router.post('/import', (req, res) => {
  const userId = req.user.id;
  const bundle = req.body;

  if (!bundle || bundle.version !== 1) {
    return res.status(400).json({ error: 'Invalid sync bundle — expected version 1' });
  }

  // Only import data belonging to the authenticated user
  if (bundle.user_id && bundle.user_id !== userId) {
    return res.status(403).json({ error: 'Bundle user_id does not match authenticated user' });
  }

  const stats = { events: 0, memory_items: 0, ai_usage: 0, sensor_toggles: 0, skipped: 0 };

  const importTransaction = db.transaction(() => {
    // Import events — dedup by checking existing IDs
    if (Array.isArray(bundle.events)) {
      for (const e of bundle.events) {
        if (!e.event_type || !e.data) continue;
        // Check for duplicate by original source ID stored in data
        const existing = e.id ? get(
          `SELECT id FROM events WHERE id = :id`,
          { ':id': e.id }
        ) : null;
        if (existing) {
          stats.skipped++;
          continue;
        }
        insert(
          `INSERT INTO events (session_id, event_type, data, user_id, org_id)
           VALUES (:sid, :type, :data, :uid, :oid)`,
          {
            ':sid': e.session_id || `sync-${Date.now()}`,
            ':type': e.event_type,
            ':data': typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
            ':uid': userId,
            ':oid': e.org_id || 'org_personal',
          }
        );
        stats.events++;
      }
    }

    // Import memory items — dedup by ID
    if (Array.isArray(bundle.memory_items)) {
      for (const m of bundle.memory_items) {
        if (!m.category || !m.content) continue;
        const existing = m.id ? get(
          `SELECT id FROM memory_items WHERE id = :id`,
          { ':id': m.id }
        ) : null;
        if (existing) {
          stats.skipped++;
          continue;
        }
        insert(
          `INSERT INTO memory_items (session_id, category, content, metadata, user_id, org_id)
           VALUES (:sid, :cat, :content, :meta, :uid, :oid)`,
          {
            ':sid': m.session_id || `sync-${Date.now()}`,
            ':cat': m.category,
            ':content': typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            ':meta': m.metadata || null,
            ':uid': userId,
            ':oid': m.org_id || 'org_personal',
          }
        );
        stats.memory_items++;
      }
    }

    // Import AI usage — dedup by ID
    if (Array.isArray(bundle.ai_usage)) {
      for (const a of bundle.ai_usage) {
        const existing = a.id ? get(
          `SELECT id FROM ai_usage WHERE id = :id`,
          { ':id': a.id }
        ) : null;
        if (existing) {
          stats.skipped++;
          continue;
        }
        try {
          insert(
            `INSERT INTO ai_usage (caller, model, input_tokens, output_tokens, cost_usd, ts, org_id)
             VALUES (:caller, :model, :in, :out, :cost, :ts, :oid)`,
            {
              ':caller': a.caller || 'sync',
              ':model': a.model || 'unknown',
              ':in': a.input_tokens || 0,
              ':out': a.output_tokens || 0,
              ':cost': a.cost_usd || 0,
              ':ts': a.ts || Date.now(),
              ':oid': a.org_id || 'org_personal',
            }
          );
          stats.ai_usage++;
        } catch {
          stats.skipped++;
        }
      }
    }

    // Import sensor toggles — dedup by unique constraint
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
              ':oid': t.org_id || 'org_personal',
              ':sid': t.sensor,
              ':en': t.enabled ? 1 : 0,
              ':cad': t.cadence_seconds || null,
              ':forced': t.forced_by_org ? 1 : 0,
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

  auditLog(req, 'sync.import', null, { stats });

  res.json({ ok: true, stats });
});

// ============================================================
// GET /status — sync status overview
// ============================================================
router.get('/status', (req, res) => {
  const userId = req.user.id;
  const settings = getSyncSettings(userId);

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

  const lastSyncTs = lastSync ? parseInt(lastSync.value, 10) : null;
  const intervalMs = settings.personal_sync_interval_minutes * 60 * 1000;
  const nextSync = settings.personal_sync_enabled && lastSyncTs
    ? lastSyncTs + intervalMs
    : null;

  // Check connection to personal server
  let connectionStatus = 'unknown';
  if (!settings.personal_pan_server_url) {
    connectionStatus = 'not_configured';
  } else if (!settings.personal_sync_enabled) {
    connectionStatus = 'disabled';
  } else {
    connectionStatus = 'enabled';
  }

  res.json({
    enabled: settings.personal_sync_enabled,
    personal_pan_server_url: settings.personal_pan_server_url,
    interval_minutes: settings.personal_sync_interval_minutes,
    last_export: lastExport ? parseInt(lastExport.value, 10) : null,
    last_import: lastImport ? parseInt(lastImport.value, 10) : null,
    last_sync: lastSyncTs,
    next_sync: nextSync,
    last_error: lastError?.value || null,
    connection_status: connectionStatus,
  });
});

// ============================================================
// startPersonalSync — callable by Steward for background sync
// ============================================================
export async function startPersonalSync(userId) {
  const settings = getSyncSettings(userId);

  if (!settings.personal_sync_enabled) {
    return { ok: false, reason: 'sync_disabled' };
  }

  if (!settings.personal_pan_server_url) {
    return { ok: false, reason: 'no_server_url' };
  }

  const serverUrl = settings.personal_pan_server_url.replace(/\/+$/, '');

  // Get the last sync timestamp for incremental sync
  const lastSync = get(
    `SELECT value FROM settings WHERE key = :key`,
    { ':key': `personal_sync_last_sync_${userId}` }
  );
  const since = lastSync ? parseInt(lastSync.value, 10) : null;

  try {
    // Step 1: Export local data and push to personal server
    const sinceParam = since ? `?since=${since}` : '';

    // Build a minimal request object for the export query
    const events = all(
      `SELECT id, session_id, event_type, data, created_at, user_id, org_id
       FROM events WHERE user_id = :uid ${since ? 'AND created_at > :since' : ''}
       ORDER BY id ASC`,
      since ? { ':uid': userId, ':since': since } : { ':uid': userId }
    );

    const memoryItems = all(
      `SELECT id, session_id, category, content, metadata, created_at, user_id, org_id
       FROM memory_items WHERE user_id = :uid ${since ? 'AND created_at > :since' : ''}
       ORDER BY id ASC`,
      since ? { ':uid': userId, ':since': since } : { ':uid': userId }
    );

    const exportBundle = {
      version: 1,
      exported_at: Date.now(),
      user_id: userId,
      org_id: 'org_personal',
      since,
      counts: {
        events: events.length,
        memory_items: memoryItems.length,
        ai_usage: 0,
        sensor_toggles: 0,
      },
      events,
      memory_items: memoryItems,
      ai_usage: [],
      sensor_toggles: [],
    };

    // Push to personal server
    const pushResponse = await fetch(`${serverUrl}/api/v1/sync/import`, {
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

    // Step 2: Pull from personal server
    const pullResponse = await fetch(`${serverUrl}/api/v1/sync/export${sinceParam}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!pullResponse.ok) {
      const errText = await pullResponse.text();
      throw new Error(`Pull failed: ${pullResponse.status} ${errText}`);
    }

    const pullBundle = await pullResponse.json();

    // Import pulled data locally
    let importStats = { events: 0, memory_items: 0, skipped: 0 };
    if (pullBundle && pullBundle.version === 1) {
      const importTx = db.transaction(() => {
        if (Array.isArray(pullBundle.events)) {
          for (const e of pullBundle.events) {
            if (!e.event_type || !e.data) continue;
            const existing = e.id ? get(`SELECT id FROM events WHERE id = :id`, { ':id': e.id }) : null;
            if (existing) { importStats.skipped++; continue; }
            insert(
              `INSERT INTO events (session_id, event_type, data, user_id, org_id)
               VALUES (:sid, :type, :data, :uid, :oid)`,
              {
                ':sid': e.session_id || `sync-${Date.now()}`,
                ':type': e.event_type,
                ':data': typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
                ':uid': userId,
                ':oid': e.org_id || 'org_personal',
              }
            );
            importStats.events++;
          }
        }
        if (Array.isArray(pullBundle.memory_items)) {
          for (const m of pullBundle.memory_items) {
            if (!m.category || !m.content) continue;
            const existing = m.id ? get(`SELECT id FROM memory_items WHERE id = :id`, { ':id': m.id }) : null;
            if (existing) { importStats.skipped++; continue; }
            insert(
              `INSERT INTO memory_items (session_id, category, content, metadata, user_id, org_id)
               VALUES (:sid, :cat, :content, :meta, :uid, :oid)`,
              {
                ':sid': m.session_id || `sync-${Date.now()}`,
                ':cat': m.category,
                ':content': typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                ':meta': m.metadata || null,
                ':uid': userId,
                ':oid': m.org_id || 'org_personal',
              }
            );
            importStats.memory_items++;
          }
        }
      });
      importTx();
    }

    // Record successful sync
    const now = Date.now();
    setSyncSetting(`personal_sync_last_sync_${userId}`, now);
    setSyncSetting(`personal_sync_last_error_${userId}`, '');

    console.log(`[PersonalSync] User ${userId} synced: pushed ${exportBundle.counts.events} events, pulled ${importStats.events} events`);

    return {
      ok: true,
      pushed: pushResult.stats || {},
      pulled: importStats,
      synced_at: now,
    };
  } catch (err) {
    const errorMsg = err.message || String(err);
    setSyncSetting(`personal_sync_last_error_${userId}`, errorMsg);
    console.error(`[PersonalSync] Sync failed for user ${userId}: ${errorMsg}`);
    return { ok: false, reason: 'sync_error', error: errorMsg };
  }
}

export default router;

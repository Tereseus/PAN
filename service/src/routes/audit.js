// Tier 0 Phase 6 — Audit Log API
//
// Routes:
//   GET /api/v1/audit/log     — paginated audit log for current org
//   GET /api/v1/audit/verify  — verify HMAC chain integrity
//   GET /api/v1/audit/export  — export full audit log as JSON (compliance)
//   GET /api/v1/audit/stats   — summary: actions by type, by user, by day

import { Router } from 'express';
import { db } from '../db.js';
import { verifyAuditChain } from '../middleware/org-context.js';

const router = Router();

// GET /log — paginated audit log for current org
// Query params: limit (default 50), offset (default 0), action, user_id, since, until
router.get('/log', (req, res) => {
  try {
    const orgId = req.org_id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const action = req.query.action || null;
    const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
    const since = req.query.since ? parseInt(req.query.since) : null;
    const until = req.query.until ? parseInt(req.query.until) : null;

    // Build dynamic WHERE clause
    const conditions = ['org_id = ?'];
    const params = [orgId];

    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }
    if (userId !== null) {
      conditions.push('user_id = ?');
      params.push(userId);
    }
    if (since !== null) {
      conditions.push('ts >= ?');
      params.push(since);
    }
    if (until !== null) {
      conditions.push('ts <= ?');
      params.push(until);
    }

    const where = conditions.join(' AND ');

    const rows = db.prepare(`
      SELECT id, org_id, user_id, action, target, metadata_json, ts, signature, prev_hash
      FROM audit_log WHERE ${where}
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const total = db.prepare(
      `SELECT COUNT(*) as c FROM audit_log WHERE ${where}`
    ).get(...params)?.c || 0;

    // Parse metadata_json for convenience
    const entries = rows.map(r => ({
      ...r,
      metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return null; } })() : null,
    }));

    res.json({ entries, total, limit, offset, action: action || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /verify — verify the HMAC chain integrity for current org
router.get('/verify', (req, res) => {
  try {
    const orgId = req.org_id;
    const result = verifyAuditChain(orgId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /export — export full audit log as JSON for compliance
router.get('/export', (req, res) => {
  try {
    const orgId = req.org_id;
    const since = req.query.since ? parseInt(req.query.since) : null;
    const until = req.query.until ? parseInt(req.query.until) : null;

    const conditions = ['org_id = ?'];
    const params = [orgId];
    if (since !== null) {
      conditions.push('ts >= ?');
      params.push(since);
    }
    if (until !== null) {
      conditions.push('ts <= ?');
      params.push(until);
    }
    const where = conditions.join(' AND ');

    const rows = db.prepare(`
      SELECT id, org_id, user_id, action, target, metadata_json, ts, signature, prev_hash
      FROM audit_log WHERE ${where}
      ORDER BY id ASC
    `).all(...params);

    // Parse metadata_json
    const entries = rows.map(r => ({
      ...r,
      metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return null; } })() : null,
    }));

    // Verify chain integrity for the export
    const chain = verifyAuditChain(orgId);

    const exportData = {
      org_id: orgId,
      exported_at: Date.now(),
      chain_valid: chain.ok,
      chain_detail: chain,
      total_entries: entries.length,
      entries,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${orgId}-${Date.now()}.json"`);
    res.json(exportData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /stats — summary: actions by type, by user, by day
router.get('/stats', (req, res) => {
  try {
    const orgId = req.org_id;

    const total = db.prepare(
      `SELECT COUNT(*) as c FROM audit_log WHERE org_id = ?`
    ).get(orgId)?.c || 0;

    let firstTs = null, lastTs = null;
    if (total > 0) {
      firstTs = db.prepare(
        `SELECT ts FROM audit_log WHERE org_id = ? ORDER BY id ASC LIMIT 1`
      ).get(orgId)?.ts || null;
      lastTs = db.prepare(
        `SELECT ts FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT 1`
      ).get(orgId)?.ts || null;
    }

    // Actions by type
    const byAction = db.prepare(
      `SELECT action, COUNT(*) as count FROM audit_log WHERE org_id = ? GROUP BY action ORDER BY count DESC`
    ).all(orgId);

    // Actions by user
    const byUser = db.prepare(
      `SELECT user_id, COUNT(*) as count FROM audit_log WHERE org_id = ? GROUP BY user_id ORDER BY count DESC`
    ).all(orgId);

    // Actions by day (last 30 days, using ts as epoch ms)
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const byDay = db.prepare(`
      SELECT date(ts / 1000, 'unixepoch', 'localtime') as day, COUNT(*) as count
      FROM audit_log WHERE org_id = ? AND ts >= ?
      GROUP BY day ORDER BY day DESC
    `).all(orgId, thirtyDaysAgo);

    // Chain verification
    const chain = verifyAuditChain(orgId);

    res.json({
      total,
      first_entry: firstTs,
      last_entry: lastTs,
      by_action: byAction,
      by_user: byUser,
      by_day: byDay,
      chain,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

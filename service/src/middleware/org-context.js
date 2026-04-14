// Tier 0 — Org context middleware (REVISED 2026-04-08 against real schema).
//
// Three exports + one helper:
//   - requireOrg(req, res, next)         attaches req.org_id + req.membership
//   - enforcePermission(action)          checks role/permission, audits on success
//   - auditLog(req, action, target, md)  manual audit hook (HMAC chained)
//   - verifyAuditChain(orgId)            walks the audit log and re-checks signatures
//
// Notes on real schema:
//   - users.id is INTEGER (not TEXT)
//   - roles.permissions is the existing TEXT JSON column (not permissions_json)
//   - memberships.permissions_json is our new per-membership override
//   - Personal org allows everything by default (you own it)

import { db } from '../db.js';
import { getDataDir } from '../platform.js';
import { createHmac, randomBytes } from 'crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Single-user fallback: assume user_id = 1 (Owner) if no auth attached.
// Lets the middleware be enabled before refactoring every route.
const FALLBACK_USER_ID = 1;
const PERSONAL_ORG_ID = 'org_personal';

// ============================================================
// Audit signing key — stored alongside DB in the data directory,
// NOT in the source tree. Respects PAN_DATA_DIR for dev isolation.
// ============================================================
const KEY_DIR = getDataDir();
const KEY_PATH = join(KEY_DIR, 'audit.key');

function getOrCreateAuditKey() {
  if (existsSync(KEY_PATH)) return readFileSync(KEY_PATH, 'utf-8').trim();
  if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(KEY_PATH, key, { mode: 0o600 });
  console.log(`[org-context] Generated audit signing key at ${KEY_PATH}`);
  return key;
}

let SIGNING_KEY = null;
function signingKey() {
  if (!SIGNING_KEY) SIGNING_KEY = getOrCreateAuditKey();
  return SIGNING_KEY;
}

function hmac(payload) {
  return createHmac('sha256', signingKey()).update(payload).digest('hex');
}

// ============================================================
// requireOrg
// ============================================================
export function requireOrg(req, res, next) {
  if (!req.user) req.user = { id: FALLBACK_USER_ID };

  let lastActive = null;
  try {
    const row = db.prepare(`SELECT last_active_org_id FROM users WHERE id = ?`).get(req.user.id);
    lastActive = row?.last_active_org_id || null;
  } catch {
    // Column may not exist yet if migration hasn't run — ignore
  }

  const orgId = req.headers['x-pan-org']
    || req.token?.org_id
    || lastActive
    || PERSONAL_ORG_ID;

  let membership = null;
  try {
    membership = db.prepare(`
      SELECT * FROM memberships
      WHERE user_id = ? AND org_id = ? AND left_at IS NULL
    `).get(req.user.id, orgId);
  } catch {
    // memberships table may not exist yet — fall through
  }

  // Fail open for personal org — user always owns their personal org
  if (!membership && orgId === PERSONAL_ORG_ID) {
    req.org_id = PERSONAL_ORG_ID;
    req.membership = { id: 0, user_id: req.user.id, org_id: PERSONAL_ORG_ID, role_id: null };
    return next();
  }

  if (!membership) {
    return res.status(403).json({ error: 'not a member of this org', org_id: orgId });
  }

  req.org_id = orgId;
  req.membership = membership;
  next();
}

// ============================================================
// enforcePermission
// ============================================================
export function enforcePermission(action) {
  return (req, res, next) => {
    if (!req.membership) {
      return res.status(500).json({ error: 'enforcePermission requires requireOrg first' });
    }

    // Personal org: allowed by default. The user owns it.
    const isPersonal = req.org_id === PERSONAL_ORG_ID;

    let perms = {};
    if (req.membership.role_id) {
      try {
        const role = db.prepare(`SELECT permissions FROM roles WHERE id = ?`).get(req.membership.role_id);
        if (role?.permissions) {
          const parsed = JSON.parse(role.permissions);
          // permissions can be either an array of action strings or an object
          if (Array.isArray(parsed)) {
            for (const a of parsed) perms[a] = true;
          } else if (parsed && typeof parsed === 'object') {
            perms = parsed;
          }
        }
      } catch {}
    }

    let overrides = {};
    if (req.membership.permissions_json) {
      try { overrides = JSON.parse(req.membership.permissions_json); } catch {}
    }

    const allowed = overrides[action] ?? perms[action] ?? isPersonal;
    if (!allowed) {
      return res.status(403).json({ error: `permission denied: ${action}` });
    }

    auditLog(req, action, req.body?.target || null);
    next();
  };
}

// ============================================================
// auditLog (HMAC-chained, append-only)
// ============================================================
export function auditLog(req, action, target, metadata = {}) {
  let prev = null;
  try {
    prev = db.prepare(
      `SELECT signature FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT 1`
    ).get(req.org_id);
  } catch {
    // audit_log may not exist yet — silently no-op
    return;
  }

  const row = {
    org_id: req.org_id,
    user_id: req.user?.id || null,
    action,
    target,
    metadata_json: JSON.stringify(metadata),
    ts: Date.now(),
    prev_hash: prev?.signature || null,
  };
  const signature = hmac(JSON.stringify(row));

  db.prepare(`
    INSERT INTO audit_log (org_id, user_id, action, target, metadata_json, ts, signature, prev_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.org_id, row.user_id, row.action, row.target, row.metadata_json, row.ts, signature, row.prev_hash);
}

// ============================================================
// verifyAuditChain — walks the audit log and verifies the chain
// ============================================================
export function verifyAuditChain(orgId) {
  const rows = db.prepare(`
    SELECT * FROM audit_log WHERE org_id = ? ORDER BY id ASC
  `).all(orgId);
  let prevSig = null;
  for (const r of rows) {
    if (r.prev_hash !== prevSig) {
      return { ok: false, broken_at: r.id, reason: 'prev_hash mismatch' };
    }
    const recomputed = hmac(JSON.stringify({
      org_id: r.org_id,
      user_id: r.user_id,
      action: r.action,
      target: r.target,
      metadata_json: r.metadata_json,
      ts: r.ts,
      prev_hash: r.prev_hash,
    }));
    if (recomputed !== r.signature) {
      return { ok: false, broken_at: r.id, reason: 'signature mismatch' };
    }
    prevSig = r.signature;
  }
  return { ok: true, broken_at: null, count: rows.length };
}

// ============================================================
// verifyAllAuditChains — verifies every org's chain in one call
// ============================================================
export function verifyAllAuditChains() {
  let orgIds;
  try {
    orgIds = db.prepare(`SELECT DISTINCT org_id FROM audit_log`).all().map(r => r.org_id);
  } catch {
    return { valid: true, entries_checked: 0, orgs_checked: 0 };
  }
  let totalEntries = 0;
  for (const orgId of orgIds) {
    const result = verifyAuditChain(orgId);
    totalEntries += result.count || 0;
    if (!result.ok) {
      return { valid: false, broken_at: result.broken_at, reason: result.reason, org_id: orgId, entries_checked: totalEntries };
    }
  }
  return { valid: true, entries_checked: totalEntries, orgs_checked: orgIds.length };
}

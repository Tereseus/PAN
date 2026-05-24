// PAN Trust Ladder — gates PAN↔PAN federated communication.
//
// Composes three axes into an action decision:
//   1. Org relationship  — same / partner / stranger (via memberships + org_shares)
//   2. Sender power_lvl  — users.power_lvl override, falls back to role.level
//   3. Scope sensitivity — per-message scopeTag tested against sensitive set
//
// Returns one of:
//   'auto'           — proceed without prompting
//   'approve-once'   — prompt user, remember per (counterparty_org, scope)
//   'approve-always' — prompt user every time
//   'deny'           — block outright
//
// Pure module: no side effects. The caller (chat.js send route) is responsible
// for writing the decision to audit_log via middleware/org-context.js#auditLog,
// since that helper needs the express request context.

import { db } from './db.js';

// Sensitive scopes always require explicit approval, regardless of org tier.
// Override via settings row: key='scope_sensitivity', value=JSON array.
const DEFAULT_SENSITIVE_SCOPES = ['health', 'finance', 'family', 'location-precise', 'private-notes', 'credentials'];

function loadSensitiveScopes() {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('scope_sensitivity');
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed)) return new Set(parsed);
    }
  } catch {}
  return new Set(DEFAULT_SENSITIVE_SCOPES);
}

/**
 * Determine the org-level relationship between sender and recipient orgs.
 *   - 'same'     — identical org_id
 *   - 'partner'  — active (non-revoked) row in org_shares between them
 *   - 'stranger' — no relationship, or missing org context
 */
export function orgRelationship(senderOrgId, recipientOrgId) {
  if (!senderOrgId || !recipientOrgId) return 'stranger';
  if (senderOrgId === recipientOrgId) return 'same';
  try {
    const partner = db.prepare(`
      SELECT 1 FROM org_shares
      WHERE ((source_org_id = ? AND target_org_id = ?)
          OR (source_org_id = ? AND target_org_id = ?))
        AND revoked_at IS NULL
      LIMIT 1
    `).get(senderOrgId, recipientOrgId, recipientOrgId, senderOrgId);
    return partner ? 'partner' : 'stranger';
  } catch {
    // org_shares table missing in unit test envs — fail closed.
    return 'stranger';
  }
}

/**
 * Effective power level for a user (0–100).
 * users.power_lvl override wins; else derive from active role.level; else 0.
 */
export function effectivePower(userId) {
  if (!userId) return 0;
  try {
    const row = db.prepare(`
      SELECT u.power_lvl AS override, r.level AS role_level
      FROM users u
      LEFT JOIN memberships m ON m.user_id = u.id AND m.left_at IS NULL
      LEFT JOIN roles r ON r.id = m.role_id
      WHERE u.id = ?
      ORDER BY r.level DESC
      LIMIT 1
    `).get(userId);
    if (!row) return 0;
    if (row.override != null) return row.override;
    return row.role_level ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Evaluate whether a sender may send a message in this scope to a thread
 * involving a recipient org.
 *
 * @param {object}  ctx
 * @param {number}  ctx.senderUserId      — users.id
 * @param {string}  ctx.senderOrgId       — orgs.id of sender's active org
 * @param {string}  ctx.recipientOrgId    — orgs.id of recipient (or this thread's owning org)
 * @param {string} [ctx.scopeTag]         — 'calendar' | 'health' | 'general' | … defaults to 'general'
 * @param {object} [ctx.threadAllowlist]  — parsed chat_threads.scope_allowlist (e.g. { allowed: [...], denied: [...] })
 * @returns {{ action: 'auto'|'approve-once'|'approve-always'|'deny', reason: string, relationship: string, power: number }}
 */
export function evaluateTrust({
  senderUserId,
  senderOrgId,
  recipientOrgId,
  scopeTag = 'general',
  threadAllowlist = null,
} = {}) {
  const relationship = orgRelationship(senderOrgId, recipientOrgId);
  const power = effectivePower(senderUserId);
  const sensitiveSet = loadSensitiveScopes();
  const isSensitive = sensitiveSet.has(scopeTag);

  // 1. Per-thread denylist (hard block before anything else).
  if (threadAllowlist && Array.isArray(threadAllowlist.denied) && threadAllowlist.denied.includes(scopeTag)) {
    return { action: 'deny', reason: `scope '${scopeTag}' explicitly denied on this thread`, relationship, power };
  }

  // 2. Stranger org + sensitive scope = hard deny. Too risky regardless of power.
  if (relationship === 'stranger' && isSensitive) {
    return { action: 'deny', reason: `sensitive scope '${scopeTag}' to stranger org`, relationship, power };
  }

  // 3. Per-thread allowlist enforcement (only when explicitly set).
  if (threadAllowlist && Array.isArray(threadAllowlist.allowed) && threadAllowlist.allowed.length > 0) {
    if (!threadAllowlist.allowed.includes(scopeTag)) {
      return { action: 'approve-always', reason: `scope '${scopeTag}' not in thread allowlist`, relationship, power };
    }
  }

  // 4. Sensitive scopes — admin+ in same org get auto; everyone else approves.
  if (isSensitive) {
    if (relationship === 'same' && power >= 75) {
      return { action: 'auto', reason: 'admin+ in same org, sensitive scope auto-ok', relationship, power };
    }
    return { action: 'approve-always', reason: `sensitive scope '${scopeTag}'`, relationship, power };
  }

  // 5. Non-sensitive — gate purely by relationship.
  switch (relationship) {
    case 'same':
      return { action: 'auto', reason: 'same org', relationship, power };
    case 'partner':
      return { action: 'approve-once', reason: 'partner org, remember per scope', relationship, power };
    case 'stranger':
    default:
      return { action: 'approve-always', reason: 'unknown counterparty', relationship, power };
  }
}

/**
 * Convenience: parse the JSON column safely. Returns null on any issue.
 */
export function parseThreadAllowlist(jsonText) {
  if (!jsonText) return null;
  try {
    const obj = JSON.parse(jsonText);
    if (obj && typeof obj === 'object') return obj;
  } catch {}
  return null;
}

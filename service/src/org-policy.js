// Tier 0 — Org policy resolver.
//
// Reads the active org policies for a request. Used by the scope middleware
// (to deny incognito if the org disallows it) and by the /api/v1/org/policy
// endpoint (so the phone can grey out toggles).
//
// Single-server-per-org (federated) means we mostly serve one org. The
// resolver still respects req.user.last_active_org_id so the same code
// works in multi-tenant deployments later.

import { db } from './db.js';

// Hardcoded fallback for the personal org when the migration hasn't run
// or no row exists. Permissive defaults — personal users own their data.
const PERSONAL_FALLBACK = {
  id: 'org_personal',
  slug: 'personal',
  name: 'Personal',
  policy_blackout_allowed: 1,
  policy_incognito_allowed: 1,
  policy_data_retention_days: null,
};

/**
 * Resolve the active org for a request and return its policy fields.
 * Falls back to the personal org if anything is missing.
 */
export function getActiveOrg(req) {
  // Default to user 1 (Owner) if auth isn't wired yet
  const userId = req?.user?.id || 1;

  let orgId = 'org_personal';
  try {
    const u = db.prepare(`SELECT last_active_org_id FROM users WHERE id = ?`).get(userId);
    if (u?.last_active_org_id) orgId = u.last_active_org_id;
  } catch {
    // last_active_org_id column missing — migration hasn't run
    return PERSONAL_FALLBACK;
  }

  let org = null;
  try {
    org = db.prepare(`
      SELECT id, slug, name,
             COALESCE(policy_blackout_allowed, 1)  AS policy_blackout_allowed,
             COALESCE(policy_incognito_allowed, 1) AS policy_incognito_allowed,
             policy_data_retention_days
      FROM orgs WHERE id = ?
    `).get(orgId);
  } catch {
    return PERSONAL_FALLBACK;
  }

  return org || PERSONAL_FALLBACK;
}

/**
 * True if the active org allows incognito mode for this request.
 */
export function isIncognitoAllowed(req) {
  const org = getActiveOrg(req);
  return org.policy_incognito_allowed !== 0;
}

/**
 * True if the active org allows the Hard Off / blackout button for this request.
 */
export function isBlackoutAllowed(req) {
  const org = getActiveOrg(req);
  return org.policy_blackout_allowed !== 0;
}

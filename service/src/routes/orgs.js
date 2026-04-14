// Phase 2 — Org Management APIs
//
// Routes:
//   GET    /                        — list orgs for current user
//   POST   /                        — create a new org
//   POST   /switch                  — switch active org
//   GET    /:id                     — get org details
//   PUT    /:id                     — update org (name, logo, policies)
//   DELETE /:id                     — delete org (owner only, not personal)
//   POST   /:id/invites            — generate invite token
//   GET    /:id/invites            — list active invites
//   DELETE /:id/invites/:inviteId  — revoke invite
//   POST   /join/:token            — join org via invite token
//   GET    /:id/members            — list members
//   PUT    /:id/members/:userId/role — change member role
//   DELETE /:id/members/:userId    — remove member

import { Router } from 'express';
import { all, get, run, insert, db } from '../db.js';
import { auditLog } from '../middleware/org-context.js';
import { randomBytes } from 'crypto';
import { getOrgScope, getOrgDb, migrateOrgToSeparateDb, crossOrgQuery, getOrgStorageInfo } from '../org-db.js';

const router = Router();

const PERSONAL_ORG_ID = 'org_personal';

// Helper: check if user has at least `minLevel` permission in org
function getMembershipLevel(userId, orgId) {
  const membership = get(
    `SELECT m.*, r.level FROM memberships m
     LEFT JOIN roles r ON r.id = m.role_id
     WHERE m.user_id = :uid AND m.org_id = :oid AND m.left_at IS NULL`,
    { ':uid': userId, ':oid': orgId }
  );
  if (!membership) return null;
  return { ...membership, level: membership.level ?? 100 }; // null role_id = owner (personal)
}

function requireLevel(userId, orgId, minLevel, res) {
  const m = getMembershipLevel(userId, orgId);
  if (!m) {
    res.status(403).json({ error: 'not a member of this org' });
    return null;
  }
  if (m.level < minLevel) {
    res.status(403).json({ error: `requires permission level ${minLevel}, you have ${m.level}` });
    return null;
  }
  return m;
}

// ── GET / — list orgs for current user ──
router.get('/', (req, res) => {
  const userId = req.user?.id || 1;
  try {
    const rows = all(
      `SELECT o.*, m.role_id, m.permissions_json, r.name as role_name, r.level as role_level
       FROM memberships m
       JOIN orgs o ON o.id = m.org_id
       LEFT JOIN roles r ON r.id = m.role_id
       WHERE m.user_id = :uid AND m.left_at IS NULL`,
      { ':uid': userId }
    );
    res.json({ orgs: rows, active: req.org_id });
  } catch (e) {
    res.json({ orgs: [{ id: PERSONAL_ORG_ID, slug: 'personal', name: 'Personal' }], active: PERSONAL_ORG_ID });
  }
});

// ── POST / — create a new org ──
router.post('/', (req, res) => {
  const userId = req.user?.id || 1;
  const { name, slug, color_primary, color_secondary, logo_url } = req.body;

  if (!name) return res.status(400).json({ error: 'name required' });

  // Generate slug from name if not provided
  let orgSlug = (slug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  // If name is entirely non-ASCII (e.g. Greek "ΠΑΝ"), generate a slug from a hash
  if (!orgSlug) {
    orgSlug = 'org-' + randomBytes(4).toString('hex');
  }

  // Generate org_id
  const orgId = `org_${orgSlug}`;

  // Check for duplicate
  const existing = get(`SELECT id FROM orgs WHERE id = :id OR slug = :slug`, { ':id': orgId, ':slug': orgSlug });
  if (existing) {
    return res.status(409).json({ error: 'org with this name/slug already exists' });
  }

  // Get the 'owner' role id
  const ownerRole = get(`SELECT id FROM roles WHERE name = 'owner'`);

  try {
    const tx = db.transaction(() => {
      // Create the org
      run(
        `INSERT INTO orgs (id, slug, name, color_primary, color_secondary, logo_url, created_at)
         VALUES (:id, :slug, :name, :cp, :cs, :logo, :ca)`,
        {
          ':id': orgId, ':slug': orgSlug, ':name': name,
          ':cp': color_primary || '#89b4fa',
          ':cs': color_secondary || null,
          ':logo': logo_url || null,
          ':ca': new Date().toISOString(),
        }
      );

      // Add creator as owner
      insert(
        `INSERT INTO memberships (user_id, org_id, role_id, joined_at)
         VALUES (:uid, :oid, :rid, :ja)`,
        { ':uid': userId, ':oid': orgId, ':rid': ownerRole?.id || null, ':ja': new Date().toISOString() }
      );
    });
    tx();

    auditLog(req, 'org.create', orgId, { name, slug: orgSlug });

    const org = get(`SELECT * FROM orgs WHERE id = :id`, { ':id': orgId });
    res.json({ ok: true, org });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /switch — switch active org ──
router.post('/switch', (req, res) => {
  const { org_id } = req.body;
  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  const userId = req.user?.id || 1;

  const membership = get(
    `SELECT * FROM memberships WHERE user_id = :uid AND org_id = :oid AND left_at IS NULL`,
    { ':uid': userId, ':oid': org_id }
  );
  if (!membership) return res.status(403).json({ error: 'not a member of this org' });

  run(`UPDATE users SET last_active_org_id = :oid WHERE id = :uid`, { ':uid': userId, ':oid': org_id });
  const org = get(`SELECT * FROM orgs WHERE id = :oid`, { ':oid': org_id });
  res.json({ ok: true, org });
});

// ── GET /:id — org details ──
router.get('/:id', (req, res) => {
  const orgId = req.params.id;
  const userId = req.user?.id || 1;

  const m = getMembershipLevel(userId, orgId);
  if (!m) return res.status(403).json({ error: 'not a member' });

  const org = get(`SELECT * FROM orgs WHERE id = :id`, { ':id': orgId });
  if (!org) return res.status(404).json({ error: 'org not found' });

  const memberCount = get(`SELECT COUNT(*) as c FROM memberships WHERE org_id = :oid AND left_at IS NULL`, { ':oid': orgId });

  res.json({ ...org, member_count: memberCount?.c || 0, your_role_level: m.level });
});

// ── PUT /:id — update org settings ──
router.put('/:id', (req, res) => {
  const orgId = req.params.id;
  const userId = req.user?.id || 1;

  if (orgId === PERSONAL_ORG_ID) return res.status(403).json({ error: 'cannot modify personal org' });

  const m = requireLevel(userId, orgId, 75, res); // admin+
  if (!m) return;

  const { name, logo_url, color_primary, color_secondary,
          policy_blackout_allowed, policy_incognito_allowed,
          policy_sensor_rules, policy_export_rules, policy_data_retention_days } = req.body;

  const updates = [];
  const params = { ':id': orgId };

  if (name !== undefined) { updates.push('name = :name'); params[':name'] = name; }
  if (logo_url !== undefined) { updates.push('logo_url = :logo'); params[':logo'] = logo_url; }
  if (color_primary !== undefined) { updates.push('color_primary = :cp'); params[':cp'] = color_primary; }
  if (color_secondary !== undefined) { updates.push('color_secondary = :cs'); params[':cs'] = color_secondary; }
  if (policy_blackout_allowed !== undefined) { updates.push('policy_blackout_allowed = :pba'); params[':pba'] = policy_blackout_allowed ? 1 : 0; }
  if (policy_incognito_allowed !== undefined) { updates.push('policy_incognito_allowed = :pia'); params[':pia'] = policy_incognito_allowed ? 1 : 0; }
  if (policy_sensor_rules !== undefined) { updates.push('policy_sensor_rules = :psr'); params[':psr'] = typeof policy_sensor_rules === 'string' ? policy_sensor_rules : JSON.stringify(policy_sensor_rules); }
  if (policy_export_rules !== undefined) { updates.push('policy_export_rules = :per'); params[':per'] = typeof policy_export_rules === 'string' ? policy_export_rules : JSON.stringify(policy_export_rules); }
  if (policy_data_retention_days !== undefined) { updates.push('policy_data_retention_days = :pdr'); params[':pdr'] = policy_data_retention_days; }

  if (updates.length === 0) return res.json({ ok: true, unchanged: true });

  run(`UPDATE orgs SET ${updates.join(', ')} WHERE id = :id`, params);
  auditLog(req, 'org.update', orgId, { fields: updates.map(u => u.split(' = ')[0]) });

  const org = get(`SELECT * FROM orgs WHERE id = :id`, { ':id': orgId });
  res.json({ ok: true, org });
});

// ── DELETE /:id — delete org ──
router.delete('/:id', (req, res) => {
  const orgId = req.params.id;
  const userId = req.user?.id || 1;

  if (orgId === PERSONAL_ORG_ID) return res.status(403).json({ error: 'cannot delete personal org' });

  const m = requireLevel(userId, orgId, 100, res); // owner only
  if (!m) return;

  try {
    const tx = db.transaction(() => {
      // Remove all memberships
      run(`UPDATE memberships SET left_at = :now WHERE org_id = :oid AND left_at IS NULL`,
        { ':now': Date.now(), ':oid': orgId });
      // Remove invites
      run(`DELETE FROM org_invites WHERE org_id = :oid`, { ':oid': orgId });
      // Remove the org
      run(`DELETE FROM orgs WHERE id = :id`, { ':id': orgId });
      // Switch all users who had this as active to personal
      run(`UPDATE users SET last_active_org_id = :personal WHERE last_active_org_id = :oid`,
        { ':personal': PERSONAL_ORG_ID, ':oid': orgId });
    });
    tx();

    res.json({ ok: true, deleted: orgId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/invites — generate invite token ──
router.post('/:id/invites', (req, res) => {
  const orgId = req.params.id;
  const userId = req.user?.id || 1;

  if (orgId === PERSONAL_ORG_ID) return res.status(403).json({ error: 'cannot invite to personal org' });

  const m = requireLevel(userId, orgId, 50, res); // manager+
  if (!m) return;

  const { email, role_name, max_uses, expires_in_hours } = req.body;

  // Resolve role
  let roleId = null;
  if (role_name) {
    const role = get(`SELECT id FROM roles WHERE name = :name`, { ':name': role_name });
    if (role) roleId = role.id;
  }

  // Generate token
  const token = randomBytes(24).toString('base64url');
  const expiresAt = expires_in_hours
    ? Date.now() + (expires_in_hours * 60 * 60 * 1000)
    : null;

  const inviteId = insert(
    `INSERT INTO org_invites (org_id, token, role_id, created_by, email, max_uses, expires_at)
     VALUES (:oid, :token, :rid, :uid, :email, :max, :exp)`,
    {
      ':oid': orgId, ':token': token, ':rid': roleId,
      ':uid': userId, ':email': email || null,
      ':max': max_uses || 1, ':exp': expiresAt,
    }
  );

  auditLog(req, 'org.invite.create', orgId, { invite_id: inviteId, email, max_uses: max_uses || 1 });

  res.json({
    ok: true,
    invite: {
      id: inviteId,
      token,
      join_url: `/api/v1/orgs/join/${token}`,
      email: email || null,
      max_uses: max_uses || 1,
      expires_at: expiresAt,
    }
  });
});

// ── GET /:id/invites — list active invites ──
router.get('/:id/invites', (req, res) => {
  const orgId = req.params.id;
  const userId = req.user?.id || 1;

  const m = requireLevel(userId, orgId, 50, res); // manager+
  if (!m) return;

  const invites = all(
    `SELECT i.*, u.display_name as created_by_name, r.name as role_name
     FROM org_invites i
     LEFT JOIN users u ON u.id = i.created_by
     LEFT JOIN roles r ON r.id = i.role_id
     WHERE i.org_id = :oid
       AND (i.expires_at IS NULL OR i.expires_at > :now)
       AND (i.max_uses = 0 OR i.use_count < i.max_uses)
     ORDER BY i.created_at DESC`,
    { ':oid': orgId, ':now': Date.now() }
  );

  res.json({ invites });
});

// ── DELETE /:id/invites/:inviteId — revoke invite ──
router.delete('/:id/invites/:inviteId', (req, res) => {
  const orgId = req.params.id;
  const userId = req.user?.id || 1;

  const m = requireLevel(userId, orgId, 50, res); // manager+
  if (!m) return;

  run(`DELETE FROM org_invites WHERE id = :iid AND org_id = :oid`,
    { ':iid': parseInt(req.params.inviteId), ':oid': orgId });

  auditLog(req, 'org.invite.revoke', orgId, { invite_id: req.params.inviteId });
  res.json({ ok: true });
});

// ── POST /join/:token — join org via invite ──
router.post('/join/:token', (req, res) => {
  const token = req.params.token;
  const userId = req.user?.id || 1;

  const invite = get(
    `SELECT * FROM org_invites WHERE token = :token`,
    { ':token': token }
  );

  if (!invite) {
    return res.status(404).json({ error: 'invalid invite token' });
  }

  // Check expiry
  if (invite.expires_at && invite.expires_at < Date.now()) {
    return res.status(410).json({ error: 'invite has expired' });
  }

  // Check uses
  if (invite.max_uses > 0 && invite.use_count >= invite.max_uses) {
    return res.status(410).json({ error: 'invite has been fully used' });
  }

  // Check email restriction
  if (invite.email) {
    const user = get(`SELECT email FROM users WHERE id = :uid`, { ':uid': userId });
    if (user?.email !== invite.email) {
      return res.status(403).json({ error: 'this invite is restricted to a specific email address' });
    }
  }

  // Check if already a member
  const existingMembership = get(
    `SELECT id, left_at FROM memberships WHERE user_id = :uid AND org_id = :oid`,
    { ':uid': userId, ':oid': invite.org_id }
  );

  if (existingMembership && !existingMembership.left_at) {
    return res.status(409).json({ error: 'already a member of this org' });
  }

  try {
    const tx = db.transaction(() => {
      if (existingMembership) {
        // Rejoin — clear left_at, update role
        run(
          `UPDATE memberships SET left_at = NULL, role_id = :rid, joined_at = :now
           WHERE id = :id`,
          { ':id': existingMembership.id, ':rid': invite.role_id, ':now': Date.now() }
        );
      } else {
        // New membership
        insert(
          `INSERT INTO memberships (user_id, org_id, role_id, joined_at)
           VALUES (:uid, :oid, :rid, :now)`,
          { ':uid': userId, ':oid': invite.org_id, ':rid': invite.role_id, ':now': Date.now() }
        );
      }

      // Increment use count
      run(`UPDATE org_invites SET use_count = use_count + 1 WHERE id = :id`,
        { ':id': invite.id });
    });
    tx();

    // Audit both sides
    const joinReq = { user: { id: userId }, org_id: invite.org_id };
    auditLog(joinReq, 'org.member.join', invite.org_id, { via_invite: invite.id });

    const org = get(`SELECT * FROM orgs WHERE id = :id`, { ':id': invite.org_id });
    res.json({ ok: true, org, message: `Joined ${org?.name || invite.org_id}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id/members — list members ──
router.get('/:id/members', (req, res) => {
  const orgId = req.params.id;
  const userId = req.user?.id || 1;

  const m = getMembershipLevel(userId, orgId);
  if (!m) return res.status(403).json({ error: 'not a member' });

  const members = all(
    `SELECT u.id, u.email, u.display_name, u.avatar_url, u.last_login,
            m.role_id, m.joined_at, m.permissions_json,
            r.name as role_name, r.level as role_level, r.color as role_color
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN roles r ON r.id = m.role_id
     WHERE m.org_id = :oid AND m.left_at IS NULL
     ORDER BY r.level DESC, u.display_name`,
    { ':oid': orgId }
  );

  res.json({ members, your_level: m.level });
});

// ── PUT /:id/members/:userId/role — change member role ──
router.put('/:id/members/:userId/role', (req, res) => {
  const orgId = req.params.id;
  const targetUserId = parseInt(req.params.userId);
  const userId = req.user?.id || 1;
  const { role_name } = req.body;

  if (orgId === PERSONAL_ORG_ID) return res.status(403).json({ error: 'cannot change roles in personal org' });

  const m = requireLevel(userId, orgId, 75, res); // admin+
  if (!m) return;

  // Resolve role
  const role = get(`SELECT * FROM roles WHERE name = :name`, { ':name': role_name });
  if (!role) return res.status(400).json({ error: `unknown role: ${role_name}` });

  // Cannot assign a role higher than your own
  if (role.level > m.level) {
    return res.status(403).json({ error: 'cannot assign a role higher than your own' });
  }

  // Cannot change the role of someone at or above your level (unless you're owner)
  const target = getMembershipLevel(targetUserId, orgId);
  if (!target) return res.status(404).json({ error: 'user is not a member' });
  if (target.level >= m.level && m.level < 100) {
    return res.status(403).json({ error: 'cannot change role of someone at or above your level' });
  }

  run(
    `UPDATE memberships SET role_id = :rid WHERE user_id = :uid AND org_id = :oid AND left_at IS NULL`,
    { ':rid': role.id, ':uid': targetUserId, ':oid': orgId }
  );

  auditLog(req, 'org.member.role_change', orgId, { target_user_id: targetUserId, new_role: role_name });
  res.json({ ok: true, user_id: targetUserId, new_role: role_name, new_level: role.level });
});

// ── DELETE /:id/members/:userId — remove member ──
router.delete('/:id/members/:userId', (req, res) => {
  const orgId = req.params.id;
  const targetUserId = parseInt(req.params.userId);
  const userId = req.user?.id || 1;

  if (orgId === PERSONAL_ORG_ID) return res.status(403).json({ error: 'cannot remove from personal org' });

  // Self-removal is always allowed
  const isSelf = targetUserId === userId;

  if (!isSelf) {
    const m = requireLevel(userId, orgId, 75, res); // admin+ to remove others
    if (!m) return;

    // Cannot remove someone at or above your level (unless owner)
    const target = getMembershipLevel(targetUserId, orgId);
    if (!target) return res.status(404).json({ error: 'user is not a member' });
    if (target.level >= m.level && m.level < 100) {
      return res.status(403).json({ error: 'cannot remove someone at or above your level' });
    }
  }

  // Don't allow removing the last owner
  if (!isSelf) {
    const ownerRole = get(`SELECT id FROM roles WHERE name = 'owner'`);
    const target = getMembershipLevel(targetUserId, orgId);
    if (ownerRole && target?.role_id === ownerRole.id) {
      const ownerCount = get(
        `SELECT COUNT(*) as c FROM memberships WHERE org_id = :oid AND role_id = :rid AND left_at IS NULL`,
        { ':oid': orgId, ':rid': ownerRole.id }
      );
      if (ownerCount?.c <= 1) {
        return res.status(403).json({ error: 'cannot remove the last owner — transfer ownership first' });
      }
    }
  }

  run(
    `UPDATE memberships SET left_at = :now WHERE user_id = :uid AND org_id = :oid AND left_at IS NULL`,
    { ':uid': targetUserId, ':oid': orgId, ':now': Date.now() }
  );

  // If removed user had this as active org, switch to personal
  run(
    `UPDATE users SET last_active_org_id = :personal WHERE id = :uid AND last_active_org_id = :oid`,
    { ':uid': targetUserId, ':oid': orgId, ':personal': PERSONAL_ORG_ID }
  );

  const action = isSelf ? 'org.member.leave' : 'org.member.remove';
  auditLog(req, action, orgId, { target_user_id: targetUserId });
  res.json({ ok: true, removed: targetUserId });
});

// ── POST /:id/isolate — migrate org data to separate DB (owner only) ──
router.post('/:id/isolate', (req, res) => {
  const orgId = req.params.id;
  const userId = req.user?.id || 1;

  if (orgId === PERSONAL_ORG_ID) {
    return res.status(400).json({ error: 'personal org always uses the main database' });
  }

  const m = requireLevel(userId, orgId, 100, res); // owner only
  if (!m) return;

  try {
    const result = migrateOrgToSeparateDb(orgId);
    auditLog(req, 'org.isolate', orgId, { rowsMoved: result.rowsMoved, scope: result.scope });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id/storage — get DB size and scope info for org ──
router.get('/:id/storage', (req, res) => {
  const orgId = req.params.id;
  const userId = req.user?.id || 1;

  const m = getMembershipLevel(userId, orgId);
  if (!m) return res.status(403).json({ error: 'not a member' });

  try {
    const info = getOrgStorageInfo(orgId);
    const scope = getOrgScope(orgId);

    // Count events in the org's DB
    let eventCount = 0;
    let sessionCount = 0;
    try {
      const orgDb = getOrgDb(orgId);
      const ec = orgDb.prepare(`SELECT COUNT(*) as c FROM events`).get();
      eventCount = ec?.c || 0;
      const sc = orgDb.prepare(`SELECT COUNT(*) as c FROM sessions`).get();
      sessionCount = sc?.c || 0;
    } catch { /* table may not exist yet */ }

    res.json({
      org_id: orgId,
      scope,
      ...info,
      eventCount,
      sessionCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/share — create a data sharing link between orgs ──
router.post('/:id/share', (req, res) => {
  const sourceOrgId = req.params.id;
  const userId = req.user?.id || 1;

  const m = requireLevel(userId, sourceOrgId, 75, res); // admin+
  if (!m) return;

  const { target_org_id, share_type, tables } = req.body;

  if (!target_org_id) return res.status(400).json({ error: 'target_org_id required' });
  if (target_org_id === sourceOrgId) return res.status(400).json({ error: 'cannot share with self' });

  // Verify target org exists
  const targetOrg = get(`SELECT id FROM orgs WHERE id = :id`, { ':id': target_org_id });
  if (!targetOrg) return res.status(404).json({ error: 'target org not found' });

  // Verify user is also a member of target org (or owner of source)
  const validShareType = (share_type === 'readwrite') ? 'readwrite' : 'readonly';
  const tablesJson = JSON.stringify(Array.isArray(tables) ? tables : []);

  try {
    // Check for existing active share
    const existing = get(
      `SELECT id, revoked_at FROM org_shares WHERE source_org_id = :src AND target_org_id = :tgt`,
      { ':src': sourceOrgId, ':tgt': target_org_id }
    );

    if (existing && !existing.revoked_at) {
      // Update existing share
      run(
        `UPDATE org_shares SET share_type = :type, tables = :tables WHERE id = :id`,
        { ':type': validShareType, ':tables': tablesJson, ':id': existing.id }
      );
      auditLog(req, 'org.share.update', sourceOrgId, { target: target_org_id, type: validShareType });
      const share = get(`SELECT * FROM org_shares WHERE id = :id`, { ':id': existing.id });
      return res.json({ ok: true, share, updated: true });
    }

    if (existing && existing.revoked_at) {
      // Reactivate revoked share
      run(
        `UPDATE org_shares SET share_type = :type, tables = :tables, revoked_at = NULL,
         created_by = :uid, created_at = :now WHERE id = :id`,
        {
          ':type': validShareType, ':tables': tablesJson,
          ':uid': userId, ':now': Date.now(), ':id': existing.id
        }
      );
      auditLog(req, 'org.share.reactivate', sourceOrgId, { target: target_org_id, type: validShareType });
      const share = get(`SELECT * FROM org_shares WHERE id = :id`, { ':id': existing.id });
      return res.json({ ok: true, share, reactivated: true });
    }

    // Create new share
    const shareId = insert(
      `INSERT INTO org_shares (source_org_id, target_org_id, share_type, tables, created_by)
       VALUES (:src, :tgt, :type, :tables, :uid)`,
      {
        ':src': sourceOrgId, ':tgt': target_org_id,
        ':type': validShareType, ':tables': tablesJson,
        ':uid': userId,
      }
    );

    auditLog(req, 'org.share.create', sourceOrgId, {
      share_id: shareId, target: target_org_id, type: validShareType
    });

    const share = get(`SELECT * FROM org_shares WHERE id = :id`, { ':id': shareId });
    res.json({ ok: true, share });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id/shares — list active shares for an org ──
router.get('/:id/shares', (req, res) => {
  const orgId = req.params.id;
  const userId = req.user?.id || 1;

  const m = getMembershipLevel(userId, orgId);
  if (!m) return res.status(403).json({ error: 'not a member' });

  try {
    // Shares where this org is the source (outgoing)
    const outgoing = all(
      `SELECT s.*, o.name as target_org_name, o.slug as target_org_slug, o.color_primary as target_color
       FROM org_shares s
       JOIN orgs o ON o.id = s.target_org_id
       WHERE s.source_org_id = :oid AND s.revoked_at IS NULL`,
      { ':oid': orgId }
    );

    // Shares where this org is the target (incoming)
    const incoming = all(
      `SELECT s.*, o.name as source_org_name, o.slug as source_org_slug, o.color_primary as source_color
       FROM org_shares s
       JOIN orgs o ON o.id = s.source_org_id
       WHERE s.target_org_id = :oid AND s.revoked_at IS NULL`,
      { ':oid': orgId }
    );

    res.json({ outgoing, incoming });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id/shares/:shareId — revoke a share ──
router.delete('/:id/shares/:shareId', (req, res) => {
  const orgId = req.params.id;
  const shareId = parseInt(req.params.shareId);
  const userId = req.user?.id || 1;

  const m = requireLevel(userId, orgId, 75, res); // admin+
  if (!m) return;

  // Verify the share belongs to this org (as source)
  const share = get(
    `SELECT * FROM org_shares WHERE id = :sid AND source_org_id = :oid`,
    { ':sid': shareId, ':oid': orgId }
  );
  if (!share) return res.status(404).json({ error: 'share not found' });
  if (share.revoked_at) return res.json({ ok: true, already_revoked: true });

  run(
    `UPDATE org_shares SET revoked_at = :now WHERE id = :id`,
    { ':now': Date.now(), ':id': shareId }
  );

  auditLog(req, 'org.share.revoke', orgId, { share_id: shareId, target: share.target_org_id });
  res.json({ ok: true, revoked: shareId });
});

export default router;

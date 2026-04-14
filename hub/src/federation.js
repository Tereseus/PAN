// Org federation — register orgs on the Hub, manage cross-server membership

import { getDb } from './db.js';

/**
 * Register an org on the Hub (called by the authority instance)
 */
export function registerOrg(orgId, authorityInstanceId, nameEncrypted) {
  const db = getDb();

  // Verify authority instance exists
  const instance = db.prepare('SELECT id FROM instances WHERE id = ?').get(authorityInstanceId);
  if (!instance) return { ok: false, error: 'Authority instance not registered' };

  // Check if org already exists
  const existing = db.prepare('SELECT org_id, authority_instance_id FROM hub_orgs WHERE org_id = ?').get(orgId);
  if (existing) {
    if (existing.authority_instance_id !== authorityInstanceId) {
      return { ok: false, error: 'Org already registered by a different instance' };
    }
    // Update name
    db.prepare('UPDATE hub_orgs SET name_encrypted = ? WHERE org_id = ?').run(nameEncrypted || null, orgId);
    return { ok: true, updated: true };
  }

  db.prepare(`
    INSERT INTO hub_orgs (org_id, authority_instance_id, name_encrypted, created_at)
    VALUES (?, ?, ?, ?)
  `).run(orgId, authorityInstanceId, nameEncrypted || null, Date.now());

  // Auto-add authority as a member
  db.prepare(`
    INSERT OR IGNORE INTO hub_org_members (org_id, instance_id, joined_at)
    VALUES (?, ?, ?)
  `).run(orgId, authorityInstanceId, Date.now());

  console.log(`[hub-federation] Org ${orgId} registered, authority: ${authorityInstanceId}`);
  return { ok: true };
}

/**
 * Add a member to a federated org (only authority can do this)
 */
export function addOrgMember(orgId, memberInstanceId, requestingInstanceId) {
  const db = getDb();

  const org = db.prepare('SELECT authority_instance_id FROM hub_orgs WHERE org_id = ?').get(orgId);
  if (!org) return { ok: false, error: 'Org not registered' };
  if (org.authority_instance_id !== requestingInstanceId) {
    return { ok: false, error: 'Only the authority instance can add members' };
  }

  // Verify member instance exists
  const member = db.prepare('SELECT id FROM instances WHERE id = ?').get(memberInstanceId);
  if (!member) return { ok: false, error: 'Member instance not registered on this Hub' };

  db.prepare(`
    INSERT INTO hub_org_members (org_id, instance_id, joined_at)
    VALUES (?, ?, ?)
    ON CONFLICT(org_id, instance_id) DO UPDATE SET left_at = NULL, joined_at = ?
  `).run(orgId, memberInstanceId, Date.now(), Date.now());

  console.log(`[hub-federation] ${memberInstanceId} joined org ${orgId}`);
  return { ok: true };
}

/**
 * Remove a member from a federated org
 */
export function removeOrgMember(orgId, memberInstanceId, requestingInstanceId) {
  const db = getDb();

  const org = db.prepare('SELECT authority_instance_id FROM hub_orgs WHERE org_id = ?').get(orgId);
  if (!org) return { ok: false, error: 'Org not registered' };

  // Authority can remove anyone, members can remove themselves
  if (org.authority_instance_id !== requestingInstanceId && memberInstanceId !== requestingInstanceId) {
    return { ok: false, error: 'Not authorized to remove this member' };
  }

  db.prepare(`
    UPDATE hub_org_members SET left_at = ? WHERE org_id = ? AND instance_id = ?
  `).run(Date.now(), orgId, memberInstanceId);

  return { ok: true };
}

/**
 * List org members (only members can see the list)
 */
export function listOrgMembers(orgId, requestingInstanceId) {
  const db = getDb();

  // Check requester is a member
  const membership = db.prepare(
    'SELECT instance_id FROM hub_org_members WHERE org_id = ? AND instance_id = ? AND left_at IS NULL'
  ).get(orgId, requestingInstanceId);

  if (!membership) return { ok: false, error: 'Not a member of this org' };

  const members = db.prepare(`
    SELECT instance_id, joined_at FROM hub_org_members
    WHERE org_id = ? AND left_at IS NULL
  `).all(orgId);

  const org = db.prepare('SELECT authority_instance_id FROM hub_orgs WHERE org_id = ?').get(orgId);

  return {
    ok: true,
    members: members.map(m => ({
      instanceId: m.instance_id,
      joinedAt: m.joined_at,
      isAuthority: m.instance_id === org?.authority_instance_id
    }))
  };
}

/**
 * List orgs an instance belongs to
 */
export function listInstanceOrgs(instanceId) {
  const db = getDb();
  const orgs = db.prepare(`
    SELECT ho.org_id, ho.authority_instance_id, ho.name_encrypted, hom.joined_at
    FROM hub_org_members hom
    JOIN hub_orgs ho ON ho.org_id = hom.org_id
    WHERE hom.instance_id = ? AND hom.left_at IS NULL
  `).all(instanceId);

  return {
    ok: true,
    orgs: orgs.map(o => ({
      orgId: o.org_id,
      authorityInstanceId: o.authority_instance_id,
      nameEncrypted: o.name_encrypted,
      joinedAt: o.joined_at,
      isAuthority: o.authority_instance_id === instanceId
    }))
  };
}

/**
 * Unregister an org (authority only)
 */
export function unregisterOrg(orgId, requestingInstanceId) {
  const db = getDb();
  const org = db.prepare('SELECT authority_instance_id FROM hub_orgs WHERE org_id = ?').get(orgId);
  if (!org) return { ok: false, error: 'Org not registered' };
  if (org.authority_instance_id !== requestingInstanceId) {
    return { ok: false, error: 'Only the authority can unregister an org' };
  }

  db.prepare('DELETE FROM hub_org_members WHERE org_id = ?').run(orgId);
  db.prepare('DELETE FROM hub_orgs WHERE org_id = ?').run(orgId);

  console.log(`[hub-federation] Org ${orgId} unregistered by ${requestingInstanceId}`);
  return { ok: true };
}

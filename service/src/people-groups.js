// people-groups.js — groups inside the organization on this ΠAN ("Kids", "Night shift").
//
// The owner, 2026-11-18: People has two parts, the organization and Others. Inside the
// organization there are groups or teams, with any name, that anybody can be put in and
// that can be deleted. The app shows them as one drop down: the whole organization, each
// group, everyone else.
//
// The rules:
//   - A group is a name the owner gives. Nothing else hangs on it yet: it is a way to look at
//     some of the people. What a group may do (an announcement to it, a call with it) is not
//     built; it comes with the plan for rooms (docs/PEOPLE-PLAN.md).
//   - A person can be in any number of groups, or in none (the owner, 2026-11-18).
//   - Deleting a group deletes the name. Its people stay on the hub.
//   - Only the owner makes, names, deletes and fills. Everyone on the hub sees the groups.
//
// Kept in the hub's own database: people_groups, people_group_people.

import { get, all, run } from './db.js';

const MAX_GROUPS = 30;
const MAX_NAME = 30;

let schemaReady = false;
export function ensureGroupsSchema() {
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS people_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS people_group_people (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  )`);
  // The first form (one group per person, a few hours on 2026-11-18): carried over once.
  try {
    if (get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'people_group_members'`)) {
      run(`INSERT OR IGNORE INTO people_group_people (group_id, user_id) SELECT group_id, user_id FROM people_group_members`);
      run(`DROP TABLE people_group_members`);
    }
  } catch (e) { console.warn('[people-groups] old table not carried over:', e.message); }
  schemaReady = true;
}

const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().replace(/\s+/g, ' ');
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** The groups, oldest first: [{ id, name, members: [user id] }]. Only people still on the hub. */
export function groupsHere() {
  ensureGroupsSchema();
  const members = new Map();
  for (const r of all(`SELECT m.user_id, m.group_id FROM people_group_people m JOIN users u ON u.id = m.user_id AND u.is_active = 1 ORDER BY m.user_id`)) {
    const g = Number(r.group_id);
    members.set(g, [...(members.get(g) || []), Number(r.user_id)]);
  }
  return all(`SELECT id, name FROM people_groups ORDER BY id`).map((r) => ({ id: Number(r.id), name: String(r.name), members: members.get(Number(r.id)) || [] }));
}

/** The groups this person is in: [group id], oldest group first. */
export function groupsOf(userId) {
  ensureGroupsSchema();
  return all(`SELECT m.group_id FROM people_group_people m JOIN people_groups g ON g.id = m.group_id WHERE m.user_id = :u ORDER BY m.group_id`, { ':u': Number(userId) })
    .map((r) => Number(r.group_id));
}

/** A new group. -> { ok, group: { id, name, members } } | { ok: false, reason } */
export function addGroup(name, now = Date.now()) {
  const n = cleanName(name);
  if (!n || n.length > MAX_NAME) return { ok: false, reason: 'name' };
  const have = groupsHere();
  if (have.some((g) => same(g.name, n))) return { ok: false, reason: 'taken' };
  if (have.length >= MAX_GROUPS) return { ok: false, reason: 'too_many' };
  const id = Number(run(`INSERT INTO people_groups (name, created_at) VALUES (:n, :at)`, { ':n': n, ':at': now }).lastInsertRowid);
  return { ok: true, group: { id, name: n, members: [] } };
}

/** Another name for a group. -> { ok, group } | { ok: false, reason } */
export function renameGroup(id, name) {
  const n = cleanName(name);
  if (!n || n.length > MAX_NAME) return { ok: false, reason: 'name' };
  const have = groupsHere();
  const g = have.find((x) => x.id === Number(id));
  if (!g) return { ok: false, reason: 'group' };
  if (have.some((x) => x.id !== g.id && same(x.name, n))) return { ok: false, reason: 'taken' };
  run(`UPDATE people_groups SET name = :n WHERE id = :i`, { ':n': n, ':i': g.id });
  return { ok: true, group: { ...g, name: n } };
}

/** Delete a group. Its people stay on the hub. -> { ok } | { ok: false, reason } */
export function removeGroup(id) {
  const g = groupsHere().find((x) => x.id === Number(id));
  if (!g) return { ok: false, reason: 'group' };
  run(`DELETE FROM people_group_people WHERE group_id = :i`, { ':i': g.id });
  run(`DELETE FROM people_groups WHERE id = :i`, { ':i': g.id });
  return { ok: true };
}

/**
 * Put a person in a group or take them out of it. groupId null: out of every group.
 * -> { ok, groups: [the groups they are in now] } | { ok: false, reason }
 */
export function setInGroup(userId, groupId, inIt = true) {
  ensureGroupsSchema();
  const uid = Number(userId);
  if (!get(`SELECT id FROM users WHERE id = :u AND is_active = 1`, { ':u': uid })) return { ok: false, reason: 'nobody' };
  if (groupId === null || groupId === undefined || groupId === '') {
    run(`DELETE FROM people_group_people WHERE user_id = :u`, { ':u': uid });
    return { ok: true, groups: [] };
  }
  const g = groupsHere().find((x) => x.id === Number(groupId));
  if (!g) return { ok: false, reason: 'group' };
  if (inIt) run(`INSERT OR IGNORE INTO people_group_people (group_id, user_id) VALUES (:g, :u)`, { ':g': g.id, ':u': uid });
  else run(`DELETE FROM people_group_people WHERE group_id = :g AND user_id = :u`, { ':g': g.id, ':u': uid });
  return { ok: true, groups: groupsOf(uid) };
}

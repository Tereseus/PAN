// Groups inside the organization on one ΠAN (people-groups.js): a name the owner gives, a
// person in any number of them. Runs standalone on a fresh database in a temp folder.
// Usage: node service/src/__tests__/people-groups.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-people-groups-'));
process.env.PAN_DEV = '1';

const { run, get } = await import('../db.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
const J = (v) => JSON.stringify(v);

run(`INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (1, 'owner@localhost', 'owner', 'owner')`);
const addUser = (name) => Number(run(
  `INSERT INTO users (email, display_name, role, power_lvl, is_active) VALUES (:e, :n, 'user', 25, 1)`,
  { ':e': `${name}@local`, ':n': name }).lastInsertRowid);
const mia = addUser('Mia Test');
const kit = addUser('Kit Test');

// What a hub that ran the first form for a few hours has: one group per person. It is carried over.
run(`CREATE TABLE people_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
run(`CREATE TABLE people_group_members (user_id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL)`);
run(`INSERT INTO people_groups (name, created_at) VALUES ('Old team', 1)`);
run(`INSERT INTO people_group_members (user_id, group_id) VALUES (:u, 1)`, { ':u': kit });

const g = await import('../people-groups.js');

console.log('groups inside the organization');

test('the first form is carried over once', () => {
  ok(J(g.groupsHere()) === J([{ id: 1, name: 'Old team', members: [kit] }]), J(g.groupsHere()));
  ok(!get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'people_group_members'`), 'the old table is still there');
  ok(g.removeGroup(1).ok && g.groupsHere().length === 0 && g.groupsOf(kit).length === 0, 'removing it');
});

test('a group is a name', () => {
  const made = g.addGroup('  Night   shift ');
  ok(made.ok && made.group.name === 'Night shift' && made.group.members.length === 0, J(made));
  ok(g.addGroup('night SHIFT').reason === 'taken' && g.addGroup('').reason === 'name' && g.addGroup('x'.repeat(31)).reason === 'name', 'a name twice, no name, a name too long');
  ok(g.groupsHere().length === 1, J(g.groupsHere()));
});

test('a person can be in more than one group, and taken out of one', () => {
  const night = g.groupsHere()[0].id;
  const kids = g.addGroup('Kids').group.id;
  ok(J(g.setInGroup(mia, night).groups) === J([night]) && g.setInGroup(kit, kids).ok && g.setInGroup(1, night).ok, 'putting people in');
  ok(J(g.setInGroup(mia, kids).groups) === J([night, kids]) && J(g.groupsOf(mia)) === J([night, kids]), J(g.groupsOf(mia)));
  ok(J(g.groupsHere().map((x) => x.members)) === J([[1, mia], [mia, kit]]), J(g.groupsHere()));
  ok(g.setInGroup(mia, kids).ok && g.groupsHere()[1].members.length === 2, 'put in twice is once');
  ok(J(g.setInGroup(mia, night, false).groups) === J([kids]) && g.setInGroup(mia, night, false).ok, 'taken out of one, and again');
  ok(J(g.setInGroup(mia, null).groups) === J([]) && g.groupsOf(mia).length === 0, 'out of every group');
  ok(g.setInGroup(9999, kids).reason === 'nobody' && g.setInGroup(mia, 9999).reason === 'group', 'nobody, and no such group');
});

test('another name; deleting leaves the people on the hub', () => {
  const [night, kids] = g.groupsHere();
  ok(g.renameGroup(kids.id, 'Children').group.name === 'Children' && g.renameGroup(kids.id, 'Night Shift').reason === 'taken'
    && g.renameGroup(kids.id, 'children').ok && g.renameGroup(9999, 'X').reason === 'group' && g.renameGroup(kids.id, ' ').reason === 'name', 'renaming');
  ok(J(g.groupsOf(kit)) === J([kids.id]), 'renaming moved someone');
  ok(g.removeGroup(kids.id).ok && g.groupsOf(kit).length === 0 && g.groupsHere().length === 1 && g.removeGroup(kids.id).reason === 'group', 'deleting');
  // Someone taken off the hub is no longer listed in a group.
  g.setInGroup(kit, night.id);
  run(`UPDATE users SET is_active = 0 WHERE id = :i`, { ':i': kit });
  ok(J(g.groupsHere()[0].members) === J([1]), J(g.groupsHere()));
});

test('thirty groups, then no more', () => {
  let made = 0;
  for (let i = 0; i < 40; i++) if (g.addGroup(`Team ${i}`).ok) made++;
  ok(made === 29 && g.addGroup('One more').reason === 'too_many', `${made} more made`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

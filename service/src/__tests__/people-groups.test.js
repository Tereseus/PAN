// Groups inside the organization on one ΠAN (people-groups.js): a name the owner gives, a
// person in one group or none. Runs standalone on a fresh database in a temp folder.
// Usage: node service/src/__tests__/people-groups.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-people-groups-'));
process.env.PAN_DEV = '1';

const { run } = await import('../db.js');
const g = await import('../people-groups.js');

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

console.log('groups inside the organization');

test('none to start with; a group is a name', () => {
  ok(g.groupsHere().length === 0 && g.groupOf(mia) === null, 'something before anything was made');
  const made = g.addGroup('  Night   shift ');
  ok(made.ok && made.group.name === 'Night shift' && made.group.members.length === 0, J(made));
  ok(g.addGroup('night SHIFT').reason === 'taken' && g.addGroup('').reason === 'name' && g.addGroup('x'.repeat(31)).reason === 'name', 'a name twice, no name, a name too long');
  ok(g.groupsHere().length === 1, J(g.groupsHere()));
});

test('a person is in one group or none; moving takes them out of the other', () => {
  const night = g.groupsHere()[0].id;
  const kids = g.addGroup('Kids').group.id;
  ok(g.moveToGroup(mia, night).group === night && g.moveToGroup(kit, kids).ok && g.moveToGroup(1, night).ok, 'moving');
  ok(J(g.groupsHere().map((x) => x.members)) === J([[1, mia], [kit]]), J(g.groupsHere()));
  g.moveToGroup(mia, kids);
  ok(g.groupOf(mia) === kids && J(g.groupsHere().map((x) => x.members)) === J([[1], [mia, kit]]), J(g.groupsHere()));
  ok(g.moveToGroup(mia, null).group === null && g.groupOf(mia) === null, 'out of every group');
  ok(g.moveToGroup(9999, kids).reason === 'nobody' && g.moveToGroup(mia, 9999).reason === 'group', 'nobody, and no such group');
});

test('another name; deleting leaves the people, in no group', () => {
  const [night, kids] = g.groupsHere();
  ok(g.renameGroup(kids.id, 'Children').group.name === 'Children' && g.renameGroup(kids.id, 'Night Shift').reason === 'taken'
    && g.renameGroup(kids.id, 'children').ok && g.renameGroup(9999, 'X').reason === 'group' && g.renameGroup(kids.id, ' ').reason === 'name', 'renaming');
  ok(g.groupOf(kit) === kids.id, 'renaming moved someone');
  ok(g.removeGroup(kids.id).ok && g.groupOf(kit) === null && g.groupsHere().length === 1 && g.removeGroup(kids.id).reason === 'group', 'deleting');
  // Someone taken off the hub is no longer listed in a group.
  g.moveToGroup(kit, night.id);
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

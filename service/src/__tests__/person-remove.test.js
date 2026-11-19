// Removing a person removes what was theirs (person-remove.js), and a device whose person is
// gone is refused (people.js personGone). Runs standalone on a fresh database in a temp folder.
// Usage: node service/src/__tests__/person-remove.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-person-remove-'));
process.env.PAN_DEV = '1';

const { run, get, all } = await import('../db.js');
const people = await import('../people.js');
const pm = await import('../person-messages.js');
const groups = await import('../people-groups.js');
const { removePerson } = await import('../person-remove.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
const J = (v) => JSON.stringify(v);

run(`INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (1, 'owner@localhost', 'owner', 'owner')`);
const addUser = (name, role = 'user', power = 25) => Number(run(
  `INSERT INTO users (email, display_name, role, power_lvl, is_active) VALUES (:e, :n, :r, :p, 1)`,
  { ':e': `${name}@local`, ':n': name, ':r': role, ':p': power }).lastInsertRowid);
const mia = addUser('Mia Test');
const kit = addUser('Kit Test');
const count = (sql, params = {}) => Number(get(sql, params)?.n || 0);

console.log('removing a person');

people.ensurePeopleSchema();
people.setDevicePerson('devmia1', mia);
people.setDevicePerson('devmia2', mia);
people.setDevicePerson('devkit1', kit);
pm.sendMessage({ from: { id: mia }, to: { id: kit }, kind: 'says', body: 'hello Kit', how: 'typed' });
pm.sendMessage({ from: { id: kit }, to: { id: mia }, kind: 'says', body: 'hello Mia', how: 'typed' });
pm.sendMessage({ from: null, to: { id: kit }, kind: 'says', body: 'for Kit only', how: 'typed' });
groups.ensureGroupsSchema();
const team = groups.addGroup('Team');
groups.setInGroup(mia, team.id ?? team.group?.id ?? 1, true);
groups.setInGroup(kit, team.id ?? team.group?.id ?? 1, true);
run(`INSERT INTO settings (key, value) VALUES ('people_call_block', :v) ON CONFLICT(key) DO UPDATE SET value = :v`,
  { ':v': J({ [mia]: [kit], [kit]: [mia, 1] }) });
run(`INSERT INTO settings (key, value) VALUES ('people_nicknames', :v) ON CONFLICT(key) DO UPDATE SET value = :v`,
  { ':v': J({ [mia]: ['Mimi'], [kit]: ['Kitty'] }) });

await test('the owner and a number that is nobody are refused', async () => {
  ok((await removePerson(1)).ok === false && (await removePerson(0)).ok === false && (await removePerson('x')).ok === false, 'took a bad id');
  ok(count('SELECT COUNT(*) AS n FROM users WHERE id = 1') === 1, 'the owner is gone');
});

const asked = [];
let done;
await test('her devices are unpaired, the one PAN Link would not drop is reported', async () => {
  done = await removePerson(mia, {
    unpair: async (d) => { asked.push(d); return d === 'devmia1'; },
    forgetVoice: (id) => asked.push(`voice ${id}`),
  });
  ok(done.ok && done.devices === 2 && done.unpaired === 1 && J(done.still_paired) === J(['devmia2']), J(done));
  ok(asked.includes('devmia1') && asked.includes('devmia2') && !asked.includes('devkit1') && asked.includes(`voice ${mia}`), J(asked));
});

await test('what was hers is gone, what was not is kept', async () => {
  ok(count('SELECT COUNT(*) AS n FROM users WHERE id = :u', { ':u': mia }) === 0, 'still a user');
  ok(count('SELECT COUNT(*) AS n FROM person_messages WHERE from_user = :u OR to_user = :u', { ':u': mia }) === 0, 'her messages stayed');
  ok(count('SELECT COUNT(*) AS n FROM person_messages WHERE to_user = :u', { ':u': kit }) === 1, 'a message between two others went too');
  ok(count('SELECT COUNT(*) AS n FROM people_group_people WHERE user_id = :u', { ':u': mia }) === 0, 'still in a group');
  const blocks = JSON.parse(get(`SELECT value FROM settings WHERE key = 'people_call_block'`).value);
  ok(blocks[mia] === undefined && J(blocks[kit]) === J([1]), J(blocks));
  const names = JSON.parse(get(`SELECT value FROM settings WHERE key = 'people_nicknames'`).value);
  ok(names[mia] === undefined && J(names[kit]) === J(['Kitty']), J(names));
});

await test('a device of hers that shows up again is nobody\'s and is refused, never the owner\'s', async () => {
  people.resetPeopleCache();
  for (const d of ['devmia1', 'devmia2']) {
    const p = people.personOfDevice(d);
    ok(p && p.role !== 'owner' && Number(p.id) === 0, `${d}: ${J(p)}`);
    ok(people.personGone(p) === true, `${d} is not seen as gone`);
  }
  const k = people.personOfDevice('devkit1');
  ok(k && Number(k.id) === kit && people.personGone(k) === false, J(k));
  ok(people.personGone(null) === false && people.personGone({ id: 1, role: 'owner' }) === false, 'the owner is seen as gone');
});

await test('removing someone twice changes nothing more', async () => {
  const again = await removePerson(mia, { unpair: async () => true });
  ok(again.ok && count('SELECT COUNT(*) AS n FROM users WHERE id = :u', { ':u': kit }) === 1, J(again));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

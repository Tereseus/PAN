// Who a paired device is and what that person may do (people.js). Runs standalone on a fresh
// database in a temp folder, no PAN server needed.
// Usage: node service/src/__tests__/people.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-people-'));
process.env.PAN_DEV = '1';

const { run, get } = await import('../db.js');
const people = await import('../people.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { people.resetPeopleCache(); fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

run(`INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (1, 'owner@localhost', 'owner', 'owner')`);
const addUser = (name, role, power) => run(
  `INSERT INTO users (email, display_name, role, power_lvl, is_active) VALUES (:e, :n, :r, :p, 1)`,
  { ':e': `${name}@local`, ':n': name, ':r': role, ':p': power }).lastInsertRowid;
const child = Number(addUser('Mia', 'child', 5));
const adult = Number(addUser('Sam', 'user', 25));

console.log('people');

test('a device nobody was named for has no person (the caller makes it the owner)', () => {
  eq(people.personOfDevice('d000000000001'), null, 'unbound');
  eq(people.may(null, 'pair_device'), true, 'no person is the owner');
});

test('a code made for a person binds the device that uses it, once', () => {
  eq(people.notePairingFor('10.77.0.9', child), true, 'noted');
  eq(people.pairingsWaiting(), true, 'waiting');
  eq(people.claimPairings([{ id: 'd00000000000a', tunnel_ip: '10.77.0.8' }]), 0, 'another address binds nothing');
  eq(people.claimPairings([{ id: 'd00000000000b', tunnel_ip: '10.77.0.9' }]), 1, 'bound');
  const p = people.personOfDevice('d00000000000b');
  eq(p.display_name, 'Mia', 'who');
  eq(p.role, 'child', 'role');
  eq(p.power, 5, 'power');
  eq(people.pairingsWaiting(), false, 'nothing left waiting');
  eq(people.claimPairings([{ id: 'd00000000000c', tunnel_ip: '10.77.0.9' }]), 0, 'the same address later binds nobody');
});

test('a code for someone who does not exist is not kept', () => {
  eq(people.notePairingFor('10.77.0.20', 9999), false, 'refused');
  eq(people.pairingsWaiting(), false, 'not waiting');
});

test('a code that ran out is still honoured for a day, then forgotten', () => {
  const now = Date.now();
  people.notePairingFor('10.77.0.30', child, { expires: now - 3600_000 });
  eq(people.pairingsWaiting(now), true, 'an hour late still counts');
  eq(people.pairingsWaiting(now + 25 * 3600_000), false, 'a day late does not');
});

test('what a child, an adult and the owner may do', () => {
  const mia = people.personOfDevice('d00000000000b');
  for (const a of ['talk', 'camera', 'own_memory', 'messages']) eq(people.may(mia, a), true, `child ${a}`);
  for (const a of ['home', 'computer', 'thread', 'lend_device', 'others_memory', 'pair_device', 'set_limits']) eq(people.may(mia, a), false, `child ${a}`);
  people.setDevicePerson('d00000000000d', adult);
  const sam = people.personOfDevice('d00000000000d');
  for (const a of ['talk', 'home', 'messages']) eq(people.may(sam, a), true, `adult ${a}`);
  // The computers and the Claude threads on them are the owner's until he opens them.
  for (const a of ['computer', 'thread', 'lend_device', 'approve_device', 'others_memory', 'pair_device']) eq(people.may(sam, a), false, `adult ${a}`);
  eq(people.may(mia, 'fly_the_house'), false, 'an action nobody named');
  eq(people.may(null, 'fly_the_house'), false, 'not even for the owner');
});

test('every role by every action: allowed exactly when the role\'s power reaches the limit', () => {
  const powers = { removed: 0, child: 5, guest: 15, user: 25, manager: 50, admin: 75 };
  const need = { talk: 0, camera: 5, own_memory: 5, home: 15, messages: 5, meet: 25, lend_device: 50, approve_device: 75,
    computer: 100, thread: 100, own_thread: 25, others_memory: 100, pair_device: 100, set_limits: 100 };
  eq(Object.keys(people.LIMITS).sort().join(), Object.keys(need).sort().join(), 'the list of actions changed: add the new one here');
  let n = 0;
  for (const [role, power] of Object.entries(powers)) for (const [action, least] of Object.entries(need)) {
    eq(people.LIMITS[action], least, `the starting limit of ${action}`);
    eq(people.may({ id: 9, role, power }, action), power >= least, `${role} ${action}`);
    n++;
  }
  eq(n, 84, 'pairs checked');
  // Nothing but the owner reaches what is the owner's alone, whatever the role is called.
  for (const action of ['computer', 'thread', 'others_memory', 'pair_device', 'set_limits']) {
    for (const power of [0, 5, 15, 25, 50, 75, 99]) eq(people.may({ power }, action), false, `power ${power} ${action}`);
    eq(people.may(null, action), true, `the owner ${action}`);
  }
  // A power that is not a number is no power.
  for (const power of [undefined, 'owner', NaN, {}]) eq(people.may({ power }, 'camera'), false, `power ${String(power)}`);
});

test('the owner changes a limit, and nonsense in the setting changes nothing', () => {
  run(`INSERT INTO settings (key, value) VALUES ('people_limits', :v) ON CONFLICT(key) DO UPDATE SET value = :v`,
    { ':v': JSON.stringify({ home: 5, computer: 'yes', made_up: 0, messages: 101, thread: 25 }) });
  people.resetPeopleCache();
  const mia = people.personOfDevice('d00000000000b');
  eq(people.may(mia, 'home'), true, 'home opened to a child');
  eq(people.may(mia, 'computer'), false, 'a word is not a power');
  eq(people.may(mia, 'made_up'), false, 'an action that does not exist');
  eq(people.limits().messages, 5, 'a power over 100 is ignored');
  eq(people.may({ power: 25 }, 'thread'), true, 'the owner opened threads to an adult');
  run(`DELETE FROM settings WHERE key = 'people_limits'`);
});

test('a shared device: only listen to me, and open again', () => {
  people.setDevicePerson('d00000000000e', 1, { shared: true });
  eq(people.personOfDevice('d00000000000e').shared, true, 'shared');
  eq(people.setOnlyListenTo('d00000000000e', 1), true, 'set');
  people.resetPeopleCache();
  eq(people.personOfDevice('d00000000000e').only_user_id, 1, 'only him');
  eq(people.setOnlyListenTo('d00000000000b', 1), false, 'not on a personal device');
  eq(people.setOnlyListenTo('d00000000000e', null), true, 'open again');
});

test('a person who was removed leaves a device that is nobody', () => {
  run('UPDATE users SET is_active = 0 WHERE id = :id', { ':id': adult });
  people.resetPeopleCache();
  const p = people.personOfDevice('d00000000000d');
  eq(p.power, 0, 'no power');
  eq(people.may(p, 'home'), false, 'cannot act');
  eq(people.may(p, 'talk'), true, 'can still be told so');
});

test('what a person\'s device may send: the listed paths and nothing shaped like them', () => {
  eq(people.personMaySend('GET', '/health'), true, 'health');
  eq(people.personMaySend('POST', '/api/v1/logs'), true, 'logs');
  eq(people.personMaySend('GET', '/api/v1/logs'), false, 'the other method');
  eq(people.personMaySend('GET', '/api/v1/auth/me?x=1'), true, 'a query string');
  eq(people.personMaySend('POST', '/api/v1/query/stream'), true, 'talking');
  eq(people.personMaySend('GET', '/api/v1/query/stream'), false, 'talking, the other method');
  for (const p of ['/api/v1/query', '/api/v1/query/stream/x', '/api/v1/capture', '/api/v1/recall', '/dashboard/api/mem', '/api/v1/link/pair', '/api/v1/settings', '/api/v1/auth/users',
    '/health/../api/v1/settings', '/health//x', '/health%2f..', 'health', '']) {
    eq(people.personMaySend('POST', p), false, p);
    eq(people.personMaySend('GET', p), false, 'GET ' + p);
  }
  eq(people.allowFor(null).length, 0, 'the owner has no limit');
  eq(people.allowFor({ role: 'owner' }).length, 0, 'an owner by role has none');
  eq(people.allowFor({ role: 'child' }).join(), people.PERSON_ALLOW.join(), 'a child gets the list');
});

test('a person\'s memory is a database of their own', () => {
  eq(people.scopeFor(null), null, 'the owner');
  eq(people.scopeFor({ id: 1, role: 'owner' }), null, 'an owner by role');
  eq(people.scopeFor({ id: 7, role: 'child' }), 'person-7', 'a child');
  eq(people.scopeFor({ id: 0, role: 'guest' }), 'person-0', 'nobody never writes to the owner');
});

test('taking a device back, and a removed device', () => {
  people.setDevicePerson('d00000000000b', null);
  eq(people.personOfDevice('d00000000000b'), null, 'the owner\'s again');
  people.forgetDevice('d00000000000e');
  eq(people.personOfDevice('d00000000000e'), null, 'gone');
  eq(get('SELECT COUNT(*) AS n FROM device_people WHERE link_device_id = :d', { ':d': 'd00000000000e' }).n, 0, 'row gone');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

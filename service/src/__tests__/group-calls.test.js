// A call with a whole group on one ΠAN (group-calls.js): who may start it, who is rung, that
// nothing is passed on before a person comes on by their own act, who hears a line and who can
// read it later, and how it ends. Runs standalone on a fresh database, no PAN server needed.
// Usage: node service/src/__tests__/group-calls.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-group-calls-'));
process.env.PAN_DEV = '1';

const { run } = await import('../db.js');
const people = await import('../people.js');
const notes = await import('../phone-notes.js');
const pm = await import('../person-messages.js');
const groups = await import('../people-groups.js');
const gc = await import('../group-calls.js');
const share = await import('../call-share.js');

let passed = 0;
let failed = 0;
const take = (dev, now) => [...notes.takeNotesFor(dev, now), ...pm.takeMessagesFor(dev, now)];
function clear() {
  notes.resetNotes();
  pm.resetAsked();
  pm.resetTalks();
  gc.resetRooms();
  people.resetPeopleCache();
  for (const k of ['people_message_mode', 'people_call_block', 'people_limits', 'people_group_name']) run(`DELETE FROM settings WHERE key = :k`, { ':k': k });
  pm.ensureMessagesSchema();
  gc.ensureGroupCallsSchema();
  run(`DELETE FROM person_messages`);
  run(`DELETE FROM group_lines`);
}
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    clear();
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
  });
}
function ok(cond, what) { if (!cond) throw new Error(what); }
const J = (v) => JSON.stringify(v);

run(`INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (1, 'owner@localhost', 'owner', 'owner')`);
run(`INSERT INTO settings (key, value) VALUES ('display_name', 'Alex') ON CONFLICT(key) DO UPDATE SET value = 'Alex'`);
const addUser = (name, role, power) => Number(run(
  `INSERT INTO users (email, display_name, role, power_lvl, is_active) VALUES (:e, :n, :r, :p, 1)`,
  { ':e': `${name}@local`, ':n': name, ':r': role, ':p': power }).lastInsertRowid);
const mia = { id: addUser('Mia Test', 'user', 25), role: 'user', power: 25, person: true };
const kit = { id: addUser('Kit Test', 'child', 5), role: 'child', power: 5, person: true };
const sam = { id: addUser('Sam Test', 'user', 25), role: 'user', power: 25, person: true };
const T0 = 2_000_000_000_000;
const OWNER_PHONE = { key: 'owner-phone', linkDevice: 'd0000000000a1', person: null };
const MIA_PHONE = { key: '', linkDevice: 'd0000000000c1', person: mia };
const KIT_PHONE = { key: '', linkDevice: 'd0000000000c2', person: kit };
const SAM_PHONE = { key: '', linkDevice: 'd0000000000c3', person: sam };
people.setDevicePerson('d0000000000c1', mia.id);
people.setDevicePerson('d0000000000c2', kit.id);
people.setDevicePerson('d0000000000c3', sam.id);
// Two groups: Kids (Mia, Kit) and Crew (Mia, Sam). The owner is in neither.
const kids = groups.addGroup('Kids').group.id;
const crew = groups.addGroup('Night crew').group.id;
groups.setInGroup(mia.id, kids); groups.setInGroup(kit.id, kids);
groups.setInGroup(mia.id, crew); groups.setInGroup(sam.id, crew);
const KIDS = `g${kids}`, CREW = `g${crew}`;
const p = (text, from = null) => pm.parseMessage(text, { from, addressed: true });
const bodies = (list) => list.map((n) => n.body).join(' | ');
const turn = (text, person = null) => pm.messageTurn(text, { person, addressed: true });

console.log('a call with a whole group');

test('what is said: a group by its name, everyone, join; a person still wins', () => {
  ok(J(p('Pan, call the Kids')) === J({ talk: 'room', room: KIDS, name: 'Kids' }), J(p('Pan, call the Kids')));
  ok(p('hey pan talk to the night crew').room === CREW, 'two words');
  ok(p('Pan, call the kids group.').room === KIDS, 'with "group"');
  ok(p('Pan, call everyone').room === 'all' && p('Pan, call everybody now').room === 'all', 'everyone');
  ok(p('Pan, join the Kids').room === KIDS, 'join by name');
  ok(J(p('Pan, join the call')) === J({ talk: 'join' }) && J(p('Pan, join')) === J({ talk: 'join' }), 'join');
  ok(p('Pan, call Mia').talk === 'start' && p('Pan, call Mia').to.id === mia.id, 'a person by name is a call with that person');
  ok(p('Pan, call the kids about dinner') === null || p('Pan, call the kids about dinner').talk !== 'room', 'a longer line is not a group call');
  ok(pm.parseMessage('call the Kids', { addressed: false }) === null, 'not said to PAN');
  run(`INSERT INTO settings (key, value) VALUES ('people_group_name', 'Family')`);
  ok(p('Pan, call the whole family').room === 'all' && p('Pan, call Family').name === 'Family', 'the organization by its name');
});

test('starting rings the others, and only them; nothing of theirs is passed on before they come on', () => {
  const got = gc.startRoom(mia, KIDS, T0);
  ok(got.ok && got.started && J(got.room.ringing) === J([kit.id]) && got.room.on.length === 1, J(got));
  const rung = take(KIT_PHONE, T0 + 1000);
  ok(rung.length === 1 && rung[0].data.call === 'ring' && rung[0].data.room === KIDS && /Mia is calling Kids/.test(rung[0].body), J(rung));
  ok(take(SAM_PHONE, T0 + 1000).length === 0 && take(OWNER_PHONE, T0 + 1000).length === 0, 'someone outside the group was told');
  ok(gc.roomFast(kit.id, T0 + 1000) && gc.roomFast(mia.id, T0 + 1000) && !gc.roomFast(sam.id, T0 + 1000), 'who asks every second');
  // Kit has not answered: what Kit says is Kit's own talk with PAN, not words for the call.
  ok(gc.roomLine('I do not want to talk', { person: kit }, T0 + 2000) === null, 'a line of someone not on was taken');
  // Mia talks before anyone is on: kept, heard by nobody.
  const alone = gc.roomLine('anyone there', { person: mia }, T0 + 3000);
  ok(alone.sent && take(KIT_PHONE, T0 + 3500).length === 0, 'a line reached someone who is not on');
});

test('coming on, lines both ways, who said it with three on, and leaving', () => {
  ok(gc.startRoom(null, 'all', T0).started, 'the owner calls everyone');
  ok(take(MIA_PHONE, T0 + 500).length === 1 && take(KIT_PHONE, T0 + 500).length === 1 && take(SAM_PHONE, T0 + 500).length === 1, 'everyone is rung');
  const j = gc.startRoom(mia, 'all', T0 + 1000);
  ok(j.ok && !j.started && j.room.on.length === 2, J(j));
  ok(/Mia is on/.test(bodies(take(OWNER_PHONE, T0 + 1500))), 'the one waiting is told');
  // Two on: the words alone, as in a call between two.
  ok(gc.roomLine('dinner is ready', { person: null }, T0 + 2000).sent, 'the line');
  const heard = take(MIA_PHONE, T0 + 2500);
  ok(heard.length === 1 && heard[0].body === 'dinner is ready.' && heard[0].title === 'Alex' && heard[0].data.talk === true, J(heard));
  // Mia's loudspeaker says it and her microphone hears it: not sent back.
  ok(gc.roomLine('Dinner is ready.', { person: mia }, T0 + 3000).reason === 'echo', 'the echo went back');
  gc.startRoom(sam, 'all', T0 + 4000);
  take(OWNER_PHONE, T0 + 4500); take(MIA_PHONE, T0 + 4500);
  ok(gc.roomLine('coming in five', { person: mia }, T0 + 5000).sent, 'with three');
  ok(take(OWNER_PHONE, T0 + 5500)[0].body === 'Mia: coming in five.' && take(SAM_PHONE, T0 + 5500)[0].body === 'Mia: coming in five.', 'who said it comes first');
  ok(take(KIT_PHONE, T0 + 5500).length === 0, 'someone still being rung heard a line');
  // A line that names PAN is PAN's, and "hang up" leaves.
  ok(gc.roomLine('Pan, what time is it', { person: sam }, T0 + 6000) === null, 'a line for PAN was passed on');
  const left = gc.roomLine('hang up', { person: sam }, T0 + 7000);
  ok(left.ended && left.name === 'Everyone' && !gc.roomOf(sam.id, T0 + 7000), J(left));
  ok(/Sam left the call/.test(bodies(take(MIA_PHONE, T0 + 7500))), 'the others are told');
  // The lines: each person sees what they said or heard, nothing else.
  ok(J(gc.roomLines(sam.id, 'all').lines.map((l) => l.body)) === J(['coming in five']), J(gc.roomLines(sam.id, 'all')));
  ok(gc.roomLines(1, 'all').lines.length === 2 && gc.roomLines(kit.id, 'all').lines.length === 0, 'who can read what');
  ok(gc.roomLines(sam.id, KIDS) === null && gc.roomLines(1, KIDS).lines.length === 0, 'a group one is not in');
});

test('how it ends: the last two, everyone saying no, five quiet minutes', () => {
  gc.startRoom(mia, KIDS, T0);
  gc.startRoom(kit, KIDS, T0 + 1000);
  take(MIA_PHONE, T0 + 1500); take(KIT_PHONE, T0 + 1500);
  ok(gc.leaveRoom(kit, T0 + 2000) === 'Kids' && !gc.roomOf(mia.id, T0 + 2000), 'one left alone stays on');
  const told = take(MIA_PHONE, T0 + 2500);
  ok(told.length === 1 && told[0].data.call === 'ended' && /Kit left/.test(told[0].body), J(told));
  // Nobody comes: the one who is rung says no.
  gc.startRoom(mia, KIDS, T0 + 10_000);
  take(KIT_PHONE, T0 + 10_500);
  ok(gc.declineRoom(kit, KIDS, T0 + 11_000) === 'Kids' && !gc.roomOf(mia.id, T0 + 11_000), 'the call stayed open');
  ok(/Nobody in Kids can talk/.test(bodies(take(MIA_PHONE, T0 + 11_500))), 'the caller is told');
  ok(gc.declineRoom(kit, KIDS, T0 + 12_000) === null, 'a second no');
  // Quiet for five minutes: over, and whoever was still rung is shown a missed call.
  gc.startRoom(mia, KIDS, T0 + 20_000);
  take(KIT_PHONE, T0 + 20_500);
  ok(!gc.roomOf(mia.id, T0 + 20_000 + 301_000), 'still open');
  const missed = take(KIT_PHONE, T0 + 20_000 + 302_000);
  ok(missed.length === 1 && missed[0].data.call === 'gone' && missed[0].type === 'message', J(missed));
  // The caller hangs up before anyone answers.
  gc.startRoom(mia, KIDS, T0 + 400_000);
  take(KIT_PHONE, T0 + 400_500);
  gc.leaveRoom(mia, T0 + 401_000);
  ok(take(KIT_PHONE, T0 + 401_500)[0]?.data.call === 'gone', 'the ringing stops');
});

test('who may: a group one is in, the owner any, a limit the owner sets, nobody who blocks', () => {
  ok(J(gc.startRoom(sam, KIDS, T0)) === J({ ok: false, reason: 'not_in', name: 'Kids' }), 'someone outside the group');
  ok(gc.startRoom(sam, 'g999', T0).reason === 'group', 'no such group');
  ok(gc.startRoom(null, KIDS, T0).started, 'the owner, in no group');
  gc.resetRooms(); notes.resetNotes();
  ok(gc.startRoom(kit, KIDS, T0).started, 'a child may by default');
  gc.resetRooms(); notes.resetNotes();
  run(`INSERT INTO settings (key, value) VALUES ('people_limits', '{"group_calls":25}')`);
  people.resetPeopleCache();
  ok(gc.startRoom(kit, KIDS, T0).reason === 'limit' && gc.startRoom(mia, KIDS, T0).started, 'the owner raised the limit');
  ok(gc.startRoom(kit, KIDS, T0 + 100).ok && gc.roomOf(kit.id, T0 + 100)?.key === KIDS, 'coming on to one that is going needs no such limit');
  ok(gc.roomState(kit.id, T0 + 100, { start: false }).can.length === 0, 'what the app is told she may start');
  gc.resetRooms(); notes.resetNotes();
  ok(/call a whole group/.test(turn('Pan, call the Kids', kit).response), turn('Pan, call the Kids', kit).response);
  gc.resetRooms(); notes.resetNotes();
  // Kit takes no calls from Mia: not rung, and with nobody else the call is not opened.
  pm.setCallsBlocked(kit.id, mia.id, true);
  ok(gc.startRoom(mia, KIDS, T0).reason === 'not_taking' && take(KIT_PHONE, T0 + 500).length === 0, 'someone who blocks was rung');
  const all_ = gc.startRoom(mia, 'all', T0);
  ok(all_.started && !all_.room.ringing.includes(kit.id) && all_.room.ringing.length === 2, J(all_));
  const one = groups.addGroup('Solo').group.id;
  groups.setInGroup(sam.id, one);
  ok(gc.startRoom(sam, `g${one}`, T0).reason === 'alone', 'a group of one');
  groups.removeGroup(one);
});

test('by voice: call, answer, join, hang up; one call at a time', () => {
  const started = turn('Pan, call the Kids', mia);
  ok(started.intent === 'talk' && started.talk_room === KIDS && /^Calling Kids\./.test(started.response), J(started));
  take(KIT_PHONE, T0);
  const ans = turn('Pan, answer', kit);
  ok(ans.talk_room === KIDS && ans.response === `You're on with Kids: Mia.`, J(ans));
  ok(turn('Pan, hang up', kit).response === 'You left the call with Kids.', 'hang up by voice');
  ok(turn('Pan, hang up', kit).response === `You're not in a call.`, 'nothing to hang up');
  ok(turn('Pan, join', sam).response === `There's no call going on to join.`, 'nothing to join');
  ok(turn('Pan, call the Kids', sam).response === `You're not in Kids.`, 'not in it');
  // One call at a time, both ways.
  gc.resetRooms(); pm.resetTalks(); notes.resetNotes();
  pm.startTalk(mia, sam.id); pm.startTalk(sam, mia.id);
  turn('Pan, call the Kids', mia);
  ok(!pm.talkOf(mia.id) && !pm.talkOf(sam.id) && gc.roomOf(mia.id)?.key === KIDS, 'the call with one person is over');
  turn('Pan, call Sam', mia);
  ok(!gc.roomOf(mia.id) && pm.talkOf(mia.id)?.with === sam.id, 'the group call is left');
  // "Answer" with one person calling is that person's call, not the group's.
  gc.resetRooms(); pm.resetTalks(); notes.resetNotes();
  gc.startRoom(mia, KIDS); pm.startTalk(sam, kit.id);
  ok(turn('Pan, answer', kit).talk_with === sam.id, 'answer went to the group');
  // A test turn starts nothing.
  gc.resetRooms(); pm.resetTalks();
  ok(pm.messageTurn('Pan, call everyone', { addressed: true, test: true }).talk_parse.room === 'all' && !gc.roomOf(1), 'a test turn opened a call');
});

test('what the app is told, and a typed line', () => {
  gc.startRoom(mia, KIDS, T0);
  const kitSees = gc.roomState(kit.id, T0 + 100);
  ok(kitSees.on === null && kitSees.ringing.length === 1 && kitSees.ringing[0].key === KIDS && kitSees.ringing[0].by === mia.id, J(kitSees));
  ok(J(kitSees.can.sort()) === J(['all', KIDS].sort()), J(kitSees.can));
  ok(gc.roomState(sam.id, T0 + 100).ringing.length === 0 && gc.roomState(sam.id, T0 + 100).open.length === 0, 'someone outside sees it');
  ok(gc.roomState(1, T0 + 100).open.length === 1, 'the owner can come on to any group');
  gc.startRoom(kit, KIDS, T0 + 200);
  const miaSees = gc.roomState(mia.id, T0 + 300);
  ok(miaSees.on.key === KIDS && J(miaSees.on.on.map((x) => x.first)) === J(['Mia', 'Kit']) && miaSees.on.ringing.length === 0, J(miaSees));
  take(MIA_PHONE, T0 + 400); take(KIT_PHONE, T0 + 400);
  ok(gc.sayInRoom(kit, 'typed this', T0 + 500).ok && take(MIA_PHONE, T0 + 900)[0].body === 'typed this.', 'a typed line');
  ok(gc.sayInRoom(sam, 'not on', T0 + 500).reason === 'no_call', 'typed by someone not on');
  ok(gc.roomLines(mia.id, KIDS).lines[0].how === 'typed' && gc.roomLines(mia.id, KIDS).lines[0].name === 'Kit', J(gc.roomLines(mia.id, KIDS)));
  // Shown only: Mia chose not to have things read out.
  pm.setMessageMode(mia.id, { mode: 'show' }, mia);
  gc.roomLine('can you see this', { person: kit }, T0 + 2000);
  ok(take(MIA_PHONE, T0 + 2500)[0].type === 'message', 'read out to someone who chose shown only');
});

test('PAN\'s answer to one is read out to all who are on, when it is not personal', async () => {
  gc.startRoom(mia, CREW, T0); gc.startRoom(sam, CREW, T0);
  take(MIA_PHONE, Date.now()); take(SAM_PHONE, Date.now());
  const yes = await share.shareAnswerInCall({ person: mia, question: 'what is the capital of France', answer: 'Paris.', intent: 'query' }, { judge: async () => true });
  ok(yes.shared && yes.room === CREW, J(yes));
  ok(/Asked PAN: what is the capital of France PAN said: Paris/.test(bodies(take(SAM_PHONE, Date.now()))), 'the other one did not hear it');
  const no = await share.shareAnswerInCall({ person: mia, question: 'what did my doctor say', answer: 'Rest.', intent: 'query' }, { judge: async () => false });
  ok(!no.shared && no.reason === 'personal', J(no));
});

for (const t of pending) await t();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// The voice itself in a call (call-voice.js): who hears whose sound, that ringing sends none,
// one device per person, and that a line is only shown to someone the voice is reaching.
// Runs standalone on a fresh database, no PAN server needed.
// Usage: node service/src/__tests__/call-voice.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

process.env.PAN_DATA_DIR = mkdtempSync(join(tmpdir(), 'pan-call-voice-'));
process.env.PAN_DEV = '1';

const { run } = await import('../db.js');
const people = await import('../people.js');
const notes = await import('../phone-notes.js');
const pm = await import('../person-messages.js');
const groups = await import('../people-groups.js');
const gc = await import('../group-calls.js');
const cv = await import('../call-voice.js');
const share = await import('../call-share.js');

let passed = 0;
let failed = 0;
const take = (dev, now) => [...notes.takeNotesFor(dev, now), ...pm.takeMessagesFor(dev, now)];
function clear() {
  notes.resetNotes(); pm.resetAsked(); pm.resetTalks(); gc.resetRooms(); cv.resetVoice(); people.resetPeopleCache();
  for (const k of ['people_message_mode', 'people_call_block', 'people_limits']) run(`DELETE FROM settings WHERE key = :k`, { ':k': k });
  pm.ensureMessagesSchema(); gc.ensureGroupCallsSchema();
  run(`DELETE FROM person_messages`); run(`DELETE FROM group_lines`);
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
const OWNER_PAD = { key: 'owner-pad', linkDevice: 'd0000000000a2', person: null };
const MIA_PHONE = { key: '', linkDevice: 'd0000000000c1', person: mia };
const KIT_PHONE = { key: '', linkDevice: 'd0000000000c2', person: kit };
const SAM_PHONE = { key: '', linkDevice: 'd0000000000c3', person: sam };
people.setDevicePerson('d0000000000c1', mia.id);
people.setDevicePerson('d0000000000c2', kit.id);
people.setDevicePerson('d0000000000c3', sam.id);
const kids = groups.addGroup('Kids').group.id;
for (const p of [mia, kit, sam]) groups.setInGroup(p.id, kids);
const KIDS = `g${kids}`;

// A stand-in for a device's open stream: it keeps what was written to it.
function stream() {
  const res = new EventEmitter();
  res.got = []; res.ended = false; res.writableLength = 0;
  res.write = (b) => { res.got.push(Buffer.from(b)); return true; };
  res.end = () => { res.ended = true; res.emit('close'); };
  return res;
}
// The pieces of sound on a stream, without the ones that only keep it open: [[from, bytes]].
function heard(res) {
  const out = [];
  for (const b of res.got) {
    const from = b.readUInt32LE(0), n = b.readUInt16LE(4);
    if (n) out.push([from, b.subarray(6, 6 + n).toString('hex')]);
  }
  return out;
}
const sound = (hex) => Buffer.from(hex, 'hex');

console.log('the voice itself in a call');

test('sound goes to the other one only once both have joined; ringing sends none', () => {
  pm.startTalk(null, mia.id, T0);
  const hers = stream();
  ok(J(cv.openVoiceStream(mia, hers, MIA_PHONE, T0)) === J({ ok: false, reason: 'no_call' }), 'a stream opened for someone who has not answered');
  ok(cv.pushVoice(null, sound('aabb'), OWNER_PHONE, T0).reason === 'no_call' && !cv.voiceFor(1, OWNER_PHONE, T0) && !cv.voiceFor(mia.id, MIA_PHONE, T0), 'sound before she answered');
  pm.startTalk(mia, 1, T0 + 1000);
  ok(cv.voiceFor(1, OWNER_PHONE, T0 + 1000) && cv.voiceFor(mia.id, MIA_PHONE, T0 + 1000) && !cv.voiceFor(kit.id, KIT_PHONE, T0 + 1000), 'who is told to send and play');
  const his = stream();
  ok(cv.openVoiceStream(mia, hers, MIA_PHONE, T0 + 1000).ok && cv.openVoiceStream(null, his, OWNER_PHONE, T0 + 1000).ok, 'both listen');
  ok(J(cv.pushVoice(null, sound('0102'), OWNER_PHONE, T0 + 1100)) === J({ ok: true, to: 1, opus: false }), 'his sound');
  ok(J(cv.pushVoice(mia, sound('0304'), MIA_PHONE, T0 + 1200)) === J({ ok: true, to: 1, opus: false }), 'her sound');
  ok(J(heard(hers)) === J([[1, '0102']]) && J(heard(his)) === J([[mia.id, '0304']]), J([heard(hers), heard(his)]));
  // Someone not on the call: nothing in, nothing out.
  const kits = stream();
  ok(!cv.openVoiceStream(kit, kits, KIT_PHONE, T0 + 1300).ok && cv.pushVoice(kit, sound('ff'), KIT_PHONE, T0 + 1300).reason === 'no_call', 'someone outside the call');
  ok(cv.pushVoice(null, Buffer.alloc(0), OWNER_PHONE, T0 + 1400).reason === 'empty' && cv.pushVoice(null, Buffer.alloc(20_000), OWNER_PHONE, T0 + 1400).reason === 'too_long', 'what is not sound');
  // Hanging up: no more sound either way.
  pm.endTalk(null, T0 + 2000);
  ok(cv.pushVoice(mia, sound('05'), MIA_PHONE, T0 + 2100).reason === 'no_call' && !cv.voiceFor(mia.id, MIA_PHONE, T0 + 2100), 'sound after the call');
});

test('one device per person: the one that opened or answered the call', () => {
  pm.startTalk(null, mia.id, T0); pm.startTalk(mia, 1, T0);
  // No device on record (a call opened without one): any of his devices may carry it.
  ok(cv.voiceFor(1, OWNER_PHONE, T0) && cv.voiceFor(1, OWNER_PAD, T0), 'no device on record');
  cv.setCallDevice(1, OWNER_PHONE);
  ok(cv.voiceFor(1, OWNER_PHONE, T0) && !cv.voiceFor(1, OWNER_PAD, T0), 'his other device was told to play');
  ok(cv.pushVoice(null, sound('01'), OWNER_PAD, T0).reason === 'not_this_device' && !cv.openVoiceStream(null, stream(), OWNER_PAD, T0).ok, 'his other device sent or listened');
  // A second stream from the same device replaces the first.
  const a = stream(), b = stream();
  cv.openVoiceStream(null, a, OWNER_PHONE, T0); cv.openVoiceStream(null, b, OWNER_PHONE, T0);
  cv.pushVoice(mia, sound('07'), MIA_PHONE, T0);
  ok(a.ended && heard(a).length === 0 && J(heard(b)) === J([[mia.id, '07']]), 'the old stream still got sound');
  // After the call the next one can be on another device.
  pm.endTalk(null, T0 + 1000);
  cv.voiceFor(1, OWNER_PHONE, T0 + 1000);
  pm.startTalk(null, mia.id, T0 + 2000); pm.startTalk(mia, 1, T0 + 2000);
  ok(cv.voiceFor(1, OWNER_PAD, T0 + 2000), 'the device of the last call still holds this one');
});

test('a group call: sound goes to everyone who is on, and to nobody who is only rung', () => {
  gc.startRoom(mia, KIDS, T0); gc.startRoom(kit, KIDS, T0);
  const m = stream(), k = stream(), s = stream();
  ok(cv.openVoiceStream(mia, m, MIA_PHONE, T0).ok && cv.openVoiceStream(kit, k, KIT_PHONE, T0).ok && !cv.openVoiceStream(sam, s, SAM_PHONE, T0).ok, 'who may listen');
  ok(cv.pushVoice(mia, sound('0a'), MIA_PHONE, T0).to === 1 && J(heard(k)) === J([[mia.id, '0a']]) && heard(m).length === 0, 'two on');
  gc.startRoom(sam, KIDS, T0 + 1000);
  cv.openVoiceStream(sam, s, SAM_PHONE, T0 + 1000);
  ok(cv.pushVoice(kit, sound('0b'), KIT_PHONE, T0 + 1100).to === 2 && J(heard(s)) === J([[kit.id, '0b']]) && J(heard(m)) === J([[kit.id, '0b']]), 'three on');
  gc.leaveRoom(sam, T0 + 2000);
  cv.pushVoice(mia, sound('0c'), MIA_PHONE, T0 + 2100);
  ok(heard(s).length === 1, 'someone who left still hears');
});

test('a line is only shown to someone the voice is reaching, and read out when it is not', () => {
  pm.startTalk(null, mia.id, T0); pm.startTalk(mia, 1, T0);
  take(OWNER_PHONE, T0); take(MIA_PHONE, T0);
  // No sound yet: her device reads his line out, as before.
  pm.talkLine('are you home yet', { person: null }, T0 + 1000);
  let got = take(MIA_PHONE, T0 + 1500);
  ok(got.length === 1 && got[0].type === 'speak' && !got[0].data.live, J(got));
  // His sound is reaching her: the same kind of line is only shown.
  cv.openVoiceStream(mia, stream(), MIA_PHONE, T0 + 2000);
  cv.pushVoice(null, sound('01'), OWNER_PHONE, T0 + 2000);
  ok(cv.voiceLive(1, mia.id, T0 + 2500) && !cv.voiceLive(mia.id, 1, T0 + 2500), 'whose voice is reaching whom');
  pm.talkLine('dinner is at eight', { person: null }, T0 + 3000);
  got = take(MIA_PHONE, T0 + 3500);
  ok(got.length === 1 && got[0].type === 'message' && got[0].data.live === true && got[0].body === 'dinner is at eight.', J(got));
  // Her microphone hears his words from her loudspeaker before the written line arrives: not sent back.
  pm.talkLine('see you soon then', { person: null }, T0 + 4000);
  ok(pm.talkLine('See you soon then.', { person: mia }, T0 + 4200).reason === 'echo', 'his own words came back as hers');
  take(MIA_PHONE, T0 + 4500);
  // His sound stopped a while ago (the microphone is off, or it cannot get through): read out again.
  pm.talkLine('can you hear me', { person: null }, T0 + 20_000);
  got = take(MIA_PHONE, T0 + 20_500);
  ok(got.length === 1 && got[0].type === 'speak', J(got));
});

test('PAN\'s answer is read out by the other\'s own PAN even while voices flow, and without the question they heard', async () => {
  pm.startTalk(null, mia.id); pm.startTalk(mia, 1);
  take(OWNER_PHONE, Date.now()); take(MIA_PHONE, Date.now());
  cv.openVoiceStream(mia, stream(), MIA_PHONE);
  cv.pushVoice(null, sound('01'), OWNER_PHONE);
  const yes = await share.shareAnswerInCall({ person: null, question: 'what is the capital of France', answer: 'Paris.', intent: 'query' }, { judge: async () => true });
  const got = take(MIA_PHONE, Date.now());
  ok(yes.shared && got.length === 1 && got[0].type === 'speak' && got[0].body === 'PAN: Paris.', J([yes, got]));
  // The other way her sound is not flowing, so he gets the question too.
  await share.shareAnswerInCall({ person: mia, question: 'how far is the moon', answer: 'About 384,000 km.', intent: 'query' }, { judge: async () => true });
  const his = take(OWNER_PHONE, Date.now());
  ok(his.length === 1 && his[0].type === 'speak' && /^Asked PAN: how far is the moon PAN said:/.test(his[0].body), J(his));
});

test('the smaller codec goes only to devices that can play it, and the sender is told when one cannot', () => {
  gc.startRoom(mia, KIDS, T0); gc.startRoom(kit, KIDS, T0); gc.startRoom(sam, KIDS, T0);
  // Kit's app plays both kinds (listen=2); Sam's is the older one (listen=1).
  const k = stream(), s = stream();
  cv.openVoiceStream(kit, k, KIT_PHONE, T0, true); cv.openVoiceStream(sam, s, SAM_PHONE, T0);
  // A piece for a device that plays both: [who: 4][kind: 1][length: 2][sound].
  const both = (res) => res.got.filter((b) => b.length > 7).map((b) => [b.readUInt32LE(0), b.readUInt8(4), b.subarray(7, 7 + b.readUInt16LE(5)).toString('hex')]);
  let got = cv.pushVoice(mia, sound('0a0b'), MIA_PHONE, T0 + 100, cv.OPUS);
  ok(got.ok && got.to === 1 && got.opus === false, J(got));
  ok(J(both(k)) === J([[mia.id, 1, '0a0b']]) && heard(s).length === 0, 'Opus reached the old app, or not the new one');
  // Told so, her device sends mu-law: both hear it, each in the shape it reads.
  got = cv.pushVoice(mia, sound('0c'), MIA_PHONE, T0 + 200, cv.MULAW);
  ok(got.to === 2 && got.opus === false && J(both(k)[1]) === J([mia.id, 0, '0c']) && J(heard(s)) === J([[mia.id, '0c']]), J([got, both(k), heard(s)]));
  // The old app leaves: everyone listening plays Opus.
  s.end();
  got = cv.pushVoice(mia, sound('0d'), MIA_PHONE, T0 + 300, cv.OPUS);
  ok(got.to === 1 && got.opus === true, J(got));
  // The piece that only keeps a stream open has the shape its device reads.
  ok(k.got.every((b) => b.length >= 7), 'a short piece on the new stream');
});

test('in a group call, those the voice reaches are shown the line and the others have it read out', () => {
  gc.startRoom(mia, KIDS, T0); gc.startRoom(kit, KIDS, T0); gc.startRoom(sam, KIDS, T0);
  for (const d of [MIA_PHONE, KIT_PHONE, SAM_PHONE]) take(d, T0);
  // Kit's device has the stream open; Sam's does not (an older app, or the sound cannot get through).
  cv.openVoiceStream(kit, stream(), KIT_PHONE, T0);
  cv.pushVoice(mia, sound('01'), MIA_PHONE, T0);
  gc.roomLine('who wants pizza', { person: mia }, T0 + 500);
  const k = take(KIT_PHONE, T0 + 900), s = take(SAM_PHONE, T0 + 900);
  ok(k[0].type === 'message' && k[0].data.live === true && s[0].type === 'speak' && !s[0].data.live, J([k, s]));
  // A typed line was heard by nobody: read out to all.
  gc.sayInRoom(mia, 'typed this', T0 + 1000);
  ok(take(KIT_PHONE, T0 + 1400)[0].type === 'speak', 'a typed line was only shown');
});

for (const t of pending) await t();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

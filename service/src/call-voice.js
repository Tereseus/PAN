// call-voice.js — the voice itself in a call between people on this ΠAN.
//
// The owner, 2026-11-19: a call should be a call. Both hear each other's voice, and ΠAN is in
// it too. Until now a call passed words: each device wrote down what its person said and the
// other device read them out (person-messages.js, group-calls.js). That stays, as the written
// record of the call and as what happens when the sound cannot flow. This carries the sound.
//
// How:
//   - A device on a call sends its microphone's sound to the hub in short pieces
//     (POST /api/v1/people/voice) and holds one stream open for what the others say
//     (the same path with ?listen=1). The hub passes each piece on to the people this
//     person is on a call with, at once, and keeps none of it: nothing is written to disk,
//     nothing goes through a model, nothing is transcribed here.
//   - Only people who have come on by their own act hear anything, and only they are heard:
//     the same rule as the words. Ringing someone sends them no sound.
//   - One device per person. A person can have more than one device; the one that opened or
//     answered the call is the one that sends and plays. The others stay quiet.
//   - ΠAN is still listening on each device for its own name. Its answer is said on the
//     asker's device, and read out by the other's own ΠAN when it is not personal
//     (call-share.js): each person hears their own ΠAN.
//   - While the sound is reaching someone, the words of that line are only shown to them,
//     not read out: they heard it (voiceLive).
//
// The sound: 16 kHz, one channel, 8-bit mu-law, as the phone made it. A piece on the stream is
// [who said it: 4 bytes][how long: 2 bytes][the sound]. A piece with nobody and no length is
// only to keep the stream open.

import { talkOf } from './person-messages.js';
import { roomOf } from './group-calls.js';

const OWNER_ID = 1;
const MAX_PIECE = 16_000;        // one second of sound; a device sends about a tenth of that
const LIVE_MS = 10_000;          // sound came from them this lately: they are being heard (a line is written a few seconds after it is said)
const KEEP_OPEN_MS = 5000;

// user id -> Set of open streams ({ res, device })
const streams = new Map();
// user id -> when their sound last came in
const lastSound = new Map();
// user id -> the device that opened or answered their call ('' until one did)
const callDevice = new Map();

const idOf = (person) => (person ? Number(person.id) : OWNER_ID);
/** What a device is called here: PAN Link's id for it, else the name it sends. */
export const deviceKey = ({ key = '', linkDevice = '' } = {}) => String(linkDevice || key || '').toLowerCase();

/** The people who hear this person right now: the other one in a call both have joined, or the others on their group call. */
export function voicePeers(userId, now = Date.now()) {
  const me = Number(userId);
  const t = talkOf(me, now);
  if (t && talkOf(t.with, now)?.with === me) return [t.with];
  const r = roomOf(me, now);
  if (r) return [...r.on.keys()].filter((id) => id !== me);
  return [];
}

/** Is this person on a call where sound can flow (someone else has come on)? */
export function onVoiceCall(userId, now = Date.now()) {
  return voicePeers(userId, now).length > 0;
}

/** This device opened or answered the person's call: it is the one that sends and plays. */
export function setCallDevice(userId, dev) {
  const k = deviceKey(dev);
  if (k) callDevice.set(Number(userId), k);
}

/** Is this the device that carries this person's call? Any device, when none is on record. */
export function carriesCall(userId, dev) {
  const want = callDevice.get(Number(userId));
  return !want || want === deviceKey(dev);
}

/** For /slack/pending: should this device send and play sound now? */
export function voiceFor(userId, dev, now = Date.now()) {
  const me = Number(userId);
  if (!onVoiceCall(me, now)) {
    // The call is over: the next one may be taken on another device.
    if (!talkOf(me, now) && !roomOf(me, now)) callDevice.delete(me);
    return false;
  }
  return carriesCall(me, dev);
}

function frame(from, sound) {
  const head = Buffer.alloc(6);
  head.writeUInt32LE(from >>> 0, 0);
  head.writeUInt16LE(sound.length, 4);
  return sound.length ? Buffer.concat([head, sound]) : head;
}

/**
 * A piece of sound from a person's device. -> { ok, to: how many people it went to }
 * | { ok: false, reason: 'no_call' | 'not_this_device' | 'empty' | 'too_long' }
 */
export function pushVoice(person, sound, dev = {}, now = Date.now()) {
  const me = idOf(person);
  if (!Buffer.isBuffer(sound) || !sound.length) return { ok: false, reason: 'empty' };
  if (sound.length > MAX_PIECE) return { ok: false, reason: 'too_long' };
  const peers = voicePeers(me, now);
  if (!peers.length) return { ok: false, reason: 'no_call' };
  if (!carriesCall(me, dev)) return { ok: false, reason: 'not_this_device' };
  lastSound.set(me, now);
  const piece = frame(me, sound);
  let to = 0;
  for (const id of peers) {
    const open = streams.get(id);
    if (!open || !open.size) continue;
    let reached = false;
    for (const s of open) {
      // A stream whose device has fallen behind is skipped, not queued: late sound is worse than none.
      if (s.res.writableLength > 64_000) continue;
      try { s.res.write(piece); reached = true; } catch {}
    }
    if (reached) to++;
  }
  return { ok: true, to };
}

/**
 * Hold a stream open for what the others on this person's call say. -> { ok } | { ok: false, reason }
 * The caller has already set the response's headers; this writes to it until it closes.
 */
export function openVoiceStream(person, res, dev = {}, now = Date.now()) {
  const me = idOf(person);
  if (!onVoiceCall(me, now)) return { ok: false, reason: 'no_call' };
  if (!carriesCall(me, dev)) return { ok: false, reason: 'not_this_device' };
  const s = { res, device: deviceKey(dev) };
  if (!streams.has(me)) streams.set(me, new Set());
  const mine = streams.get(me);
  // One stream per device: a new one from the same device replaces the old.
  const old = [...mine].filter((x) => x.device === s.device);
  mine.add(s);
  for (const x of old) { mine.delete(x); try { x.res.end(); } catch {} }
  const beat = setInterval(() => {
    // The call ended: the stream ends with it. Otherwise an empty piece keeps it open.
    if (!onVoiceCall(me) || !carriesCall(me, dev)) { try { res.end(); } catch {} return; }
    try { res.write(frame(0, Buffer.alloc(0))); } catch {}
  }, KEEP_OPEN_MS);
  beat.unref?.();
  const done = () => { clearInterval(beat); mine.delete(s); if (!mine.size && streams.get(me) === mine) streams.delete(me); };
  res.on('close', done);
  res.on('error', done);
  console.log(`[call-voice] person ${me} is listening`);
  return { ok: true };
}

/**
 * Is [fromId]'s voice reaching [toId] right now? Their sound came in a moment ago and the
 * other has a stream open. Then a line of theirs is only shown to the other, not read out.
 */
export function voiceLive(fromId, toId, now = Date.now()) {
  const at = lastSound.get(Number(fromId));
  return !!at && now - at < LIVE_MS && !!streams.get(Number(toId))?.size && voicePeers(Number(fromId), now).includes(Number(toId));
}

/** For the tests: nothing open, nothing remembered. */
export function resetVoice() {
  for (const set of streams.values()) for (const s of set) { try { s.res.end(); } catch {} }
  streams.clear(); lastSound.clear(); callDevice.clear();
}

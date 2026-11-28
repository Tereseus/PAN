// Whose voice a turn is in: his, someone else's, or can't tell (2026-11-12).
//
// Why: right after PAN answers him, the words alone cannot tell his follow-up from the next
// person talking. On convbench's addressed test (evals/convbench/addressed_bench.py) PAN stayed
// quiet on only 47% of other people's lines there; told whose voice it was, 100%, with nothing
// else lost. The phone already sends every turn's audio (app 0.4.43+, for hub-asr.js), so the
// check runs here and needs no phone update.
//
// Model: 3D-Speaker CAM++ zh_en (Apache 2.0, 27 MB), the winner of the hub's speaker bench
// (2026-11-06): about 30 ms for a 2 s line, the right one of two voices 99 to 100% on 2 s clean
// lines. The owner against his own profile scored about 0.79, people against his profile at most 0.25.
//
// His profile builds itself, with nothing for him to say or do (the owner, 2026-11-13: "it should figure
// it out by itself"). The phone is his and sits on him, so the voice that keeps coming back turn
// after turn is his. Every real turn's print goes in a pool (the last POOL_MAX); the biggest group
// of prints that sound alike (>= SAME to its centre) becomes his profile once it holds at least
// MIN_GROUP lines and MIN_SHARE of the pool. A named line ("PAN, ...") is not needed and gets no
// extra weight. Kept in the data dir (voice-profile.json), never sent anywhere.
// DELETE /api/v1/voice/profile starts it again (?device= for one device).
//
// One profile per device (Nov 28, task 1104). One shared pool let the device that talks most take
// it over: on Nov 21, 136 car lines in an hour made the profile his voice through the car's mic, and
// none of his Pixel lines counted as him after that (0 of 28, median 0.35). The same voice through
// two mics matched only 0.59. Now every device keeps its own pool (the last DEVICE_POOL_MAX) and its
// own profile, and a device with no profile yet (under MIN_GROUP alike lines) is checked against the
// best match among his other devices. The old shared file's lines carry no device, so its pool
// became the frozen 'unlabelled' profile (a fallback only, it never learns); the old file is kept
// as voice-profile.v1-backup.json.
//
// The setting voice_id_gate decides what the router gets: 'observe' (default) logs the score
// and sends nothing, 'on' sends wearer true/false. Unsure scores and short lines send nothing.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { getDataDir } from './platform.js';
import { get } from './db.js';

const require = createRequire(import.meta.url);
const MODEL = process.env.PAN_SPK_MODEL || join(dirname(getDataDir()), 'models', 'campplus', '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx');
const PROFILE = process.env.PAN_VOICE_PROFILE || join(getDataDir(), 'voice-profile.json');   // env: tests only
const MIN_SAMPLES = 16000;      // 1 s: shorter lines tell too little (bench: 1 s 98.5%, 2 s 100%)
const SAME = 0.5;               // at or above: his voice
const OTHER = 0.25;             // at or below: someone else's. Between: can't tell
const POOL_MAX = 200;           // the old shared pool's size (the 'unlabelled' profile)
const DEVICE_POOL_MAX = Number(process.env.PAN_VOICE_DEVICE_POOL || 100);   // per device; env: tests only
const MAX_DEVICES = 12;         // past this, the device heard least recently is forgotten
export const UNLABELLED = 'unlabelled';
const MIN_GROUP = Number(process.env.PAN_VOICE_MIN_GROUP || 10);       // env: tests only
const MIN_SHARE = Number(process.env.PAN_VOICE_MIN_SHARE || 0.4);      // env: tests only
const REGROUP_EVERY = 5;        // turns between regroupings (each one about 10 ms)

let extractor = null;
let unavailable = false;
// { version: 2, devices: { [device]: { pool: number[][], centre: number[] | null, group, added, last, frozen? } } }
let profiles = null;

function load() {
  if (extractor || unavailable) return extractor;
  try {
    if (!existsSync(MODEL)) { unavailable = true; console.log(`[voice-id] no model at ${MODEL}`); return null; }
    const sherpa = require('sherpa-onnx-node');
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model: MODEL, numThreads: 2, debug: 0, provider: 'cpu' });
    const list = Object.entries(loadProfiles().devices);
    console.log(`[voice-id] ready, ${list.length ? list.map(([d, p]) => `${d} ${p.centre ? `${p.group} of ${p.pool.length}` : `learning ${p.pool.length}`}`).join(', ') : 'still learning (0 turns)'}`);
  } catch (e) {
    unavailable = true;
    console.warn('[voice-id] unavailable:', e.message);
  }
  return extractor;
}

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) + 1e-9;
  return Array.from(v, (x) => x / n);
}

function dot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

// The profile file, read once. The shared format of Nov 13 to 28 ({ pool, centre, ... }) becomes the
// frozen 'unlabelled' profile, with the old file kept next to it.
function loadProfiles() {
  if (profiles) return profiles;
  let raw = null;
  try { raw = JSON.parse(readFileSync(PROFILE, 'utf8')); } catch {}
  let changed = false;
  if (raw?.version === 2 && raw.devices && typeof raw.devices === 'object') profiles = raw;
  else {
    profiles = { version: 2, devices: {} };
    if (Array.isArray(raw?.pool)) {   // the shared pool: no device on its lines
      const backup = PROFILE.replace(/\.json$/, '') + '.v1-backup.json';
      try { if (!existsSync(backup)) writeFileSync(backup, JSON.stringify(raw)); } catch (e) { console.warn('[voice-id] backup failed:', e.message); }
      profiles.devices[UNLABELLED] = { pool: raw.pool.slice(-POOL_MAX), centre: null, group: 0, added: raw.added || raw.pool.length, last: 0, frozen: true };
      regroup(profiles.devices[UNLABELLED]);
      console.log(`[voice-id] moved the shared profile (${raw.pool.length} turns) to '${UNLABELLED}', old file kept as ${backup}`);
      changed = true;
    }
  }
  for (const [d, p] of Object.entries(profiles.devices)) {   // drop PAN's own voice from every pool (Nov 15)
    if (!Array.isArray(p?.pool)) { delete profiles.devices[d]; changed = true; continue; }
    const n = p.pool.length;
    p.pool = p.pool.filter((x) => (panVoiceLikeness(unit(x))?.likeness ?? 0) < PAN_SELF);
    if (p.pool.length < n) { console.log(`[voice-id] dropped ${n - p.pool.length} turns in PAN's own voice from ${d}`); regroup(p); changed = true; }
  }
  if (changed) save();
  return profiles;
}

function deviceKey(device) {
  const d = String(device ?? '').trim().slice(0, 80);
  return d || 'unknown';
}

/** How much a print sounds like him: against this device's own profile, else the best of his
 *  other profiles (a new device, or a call with no device). { likeness, from } */
function likenessOf(print, device) {
  const all = loadProfiles().devices;
  const own = device == null ? null : all[deviceKey(device)];
  if (own?.centre) return { likeness: dot(print, own.centre), from: deviceKey(device) };
  let best = null;
  for (const [d, p] of Object.entries(all)) {
    if (!p.centre) continue;
    const l = dot(print, p.centre);
    if (!best || l > best.likeness) best = { likeness: l, from: d };
  }
  return best || { likeness: null, from: null };
}

// The biggest group of alike voices in the pool: the print with the most alike neighbours is the
// seed, its neighbours the group, their mean (unit length) the centre.
function regroup(profile) {
  const pool = profile.pool;
  if (!pool.length) { profile.centre = null; profile.group = 0; return; }
  let best = -1, bestN = 0;
  for (let i = 0; i < pool.length; i++) {
    let n = 0;
    for (let j = 0; j < pool.length; j++) if (dot(pool[i], pool[j]) >= SAME) n++;
    if (n > bestN) { bestN = n; best = i; }
  }
  if (best < 0 || bestN < MIN_GROUP || bestN < MIN_SHARE * pool.length) { profile.centre = null; profile.group = bestN; return; }
  const sum = new Array(pool[0].length).fill(0);
  for (const p of pool) if (dot(pool[best], p) >= SAME) p.forEach((x, i) => { sum[i] += x; });
  profile.centre = unit(sum);
  profile.group = bestN;
}

// PAN's own voice (Nov 15). The phone's echo filter drops words PAN just said, but a line it
// misses (a word heard differently, a long reply, another phone's speaker) came back as his turn
// and PAN answered itself. pan-voice-print.json holds PAN's voices as prints; a turn that sounds
// like one and not like him is dropped before transcription. Clean Supertonic 3 lines scored 0.71
// to 0.87 against it; his 200 recent turns: median 0.08, 99th percentile 0.29. Over the air (Pad
// bench, the Mint's speakers at 70%): PAN's lines 0.23 to 0.62, median 0.46, so 0.35 drops about
// 84%; recorded people and Windows' David voice through the same speakers -0.00 to 0.09.
const PAN_PRINTS = join(dirname(fileURLToPath(import.meta.url)), 'pan-voice-print.json');
export const PAN_SELF = Number(process.env.PAN_SELF_VOICE || 0.35);
let panVoices = null;

function loadPanVoices() {
  if (panVoices) return panVoices;
  try { panVoices = JSON.parse(readFileSync(PAN_PRINTS, 'utf8')).voices.map((v) => ({ name: v.name, centre: unit(v.centre) })); }
  catch (e) { console.warn('[voice-id] no PAN voice prints:', e.message); panVoices = []; }
  return panVoices;
}

/** { name, likeness } of the PAN voice this print sounds most like, or null. */
export function panVoiceLikeness(print) {
  if (!print) return null;
  let best = null;
  for (const v of loadPanVoices()) {
    const l = dot(print, v.centre);
    if (!best || l > best.likeness) best = { name: v.name, likeness: l };
  }
  return best;
}

/** Off with setting pan_self_voice = off. */
export function panSelfGateOn() {
  try { return String(get("SELECT value FROM settings WHERE key = 'pan_self_voice'")?.value || 'on').replace(/^"|"$/g, '').trim().toLowerCase() !== 'off'; }
  catch { return true; }
}

// Short and not sure it is him (Nov 28): in the car, noise and ΠAN's own echo came in as a word or
// two on the phone, the hub wrote a sentence from it, and ΠAN answered. Judged against the hub's 116
// logged turns of Nov 24 to 28 (phone words, hub words, score, reply): 3 words or fewer and under
// 0.6 caught 24 of 27 noise or echo lines and lost one real line; his real short lines in the car
// scored 0.62 and up. 0.65 lost three more of his; 4 words lost a 4 word line of his. A line that
// names ΠAN is always kept (the caller checks). Off with setting short_noise_gate = off.
export const SHORT_WORDS = Number(process.env.PAN_SHORT_WORDS || 3);
export const SHORT_SURE = Number(process.env.PAN_SHORT_SURE || 0.6);

/** Words with a letter or digit in them ("…" and "." count none). */
export function wordsIn(s) {
  return String(s || '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The phone heard SHORT_WORDS or fewer, voice ID is under SHORT_SURE, and ΠAN was not named. */
export function shortNoise({ phoneText, likeness, named = false } = {}) {
  if (named || likeness === null || likeness === undefined || !Number.isFinite(likeness)) return false;
  return wordsIn(phoneText) <= SHORT_WORDS && likeness < SHORT_SURE;
}

export function shortNoiseGateOn() {
  try { return String(get("SELECT value FROM settings WHERE key = 'short_noise_gate'")?.value || 'on').replace(/^"|"$/g, '').trim().toLowerCase() !== 'off'; }
  catch { return true; }
}

export function gateMode() {
  try { return String(get("SELECT value FROM settings WHERE key = 'voice_id_gate'")?.value || 'observe').replace(/^"|"$/g, '').trim().toLowerCase(); }
  catch { return 'observe'; }
}

/** The voice print of a turn's audio (16 kHz PCM16, base64), or null. */
// Loaded when the Craft starts, not at the first line (Nov 27): the first line after a swap paid
// the model and profile load, 3.4 s of a 6.7 s turn on the Pixel, against 0.03 s on the next line.
// One silent second through the model too, so its first real line is not the first it ever ran.
export function warmVoiceId() {
  const t0 = Date.now();
  if (!load()) return false;
  try {
    const s = extractor.createStream();
    s.acceptWaveform({ samples: new Float32Array(MIN_SAMPLES), sampleRate: 16000 });
    s.inputFinished();
    if (extractor.isReady(s)) extractor.compute(s);
  } catch {}
  console.log(`[voice-id] loaded at start in ${Date.now() - t0} ms`);
  return true;
}

export function voicePrint(b64) {
  if (!b64 || !load()) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const n = Math.floor(buf.length / 2);
    if (n < MIN_SAMPLES) return null;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
    const s = extractor.createStream();
    s.acceptWaveform({ samples, sampleRate: 16000 });
    s.inputFinished();
    if (!extractor.isReady(s)) return null;
    return unit(extractor.compute(s));
  } catch (e) {
    console.warn('[voice-id] print failed:', e.message);
    return null;
  }
}

/** { wearer: true | false | undefined, likeness, from }. wearer is only set when the gate is 'on'.
 *  device: the device the line came in on. No device: the best of all his profiles (a person's
 *  device asks how much a line sounds like the owner). from: whose profile answered. */
export function whoseVoice(print, device = null) {
  const { likeness: l, from } = print ? likenessOf(print, device) : { likeness: null, from: null };
  const verdict = l === null ? undefined : l >= SAME ? true : l <= OTHER ? false : undefined;
  return { verdict, likeness: l, from, wearer: gateMode() === 'on' ? verdict : undefined };
}

/** After every real turn with audio: that device's pool learns, and his voice is found again now and then. */
export function learnWearer(print, device = null) {
  if (!print) return;
  // PAN's own voice must never become his: one of his 200 pool turns scored 0.54 against it (Nov 15).
  if ((panVoiceLikeness(print)?.likeness ?? 0) >= PAN_SELF) return;
  const key = deviceKey(device);
  if (key === UNLABELLED) return;
  const all = loadProfiles().devices;
  if (!all[key]) {
    all[key] = { pool: [], centre: null, group: 0, added: 0, last: 0 };
    const live = Object.entries(all).filter(([d]) => d !== UNLABELLED && d !== key);
    if (live.length >= MAX_DEVICES) {   // the device heard least recently goes
      const [oldest] = live.sort((a, b) => (a[1].last || 0) - (b[1].last || 0))[0];
      delete all[oldest];
      console.log(`[voice-id] forgot the profile of ${oldest} (over ${MAX_DEVICES} devices)`);
    }
  }
  const p = all[key];
  p.pool.push(Array.from(print, (x) => Math.round(x * 1e4) / 1e4));
  if (p.pool.length > DEVICE_POOL_MAX) p.pool.splice(0, p.pool.length - DEVICE_POOL_MAX);
  p.added = (p.added || 0) + 1;
  p.last = Date.now();
  if (p.added % REGROUP_EVERY && p.centre) { save(); return; }
  const had = !!p.centre;
  regroup(p);
  save();
  if (!had && p.centre) console.log(`[voice-id] found his voice on ${key}: ${p.group} of ${p.pool.length} turns`);
}

function save() {
  try { writeFileSync(PROFILE, JSON.stringify(profiles)); } catch (e) { console.warn('[voice-id] save failed:', e.message); }
}

/** Starts again: every device, or only [device]. The v1 backup file is never removed. */
export function resetProfile(device = null) {
  if (device != null && String(device).trim()) {
    delete loadProfiles().devices[deviceKey(device)];
    save();
    return;
  }
  profiles = null;
  try { unlinkSync(PROFILE); } catch {}
}

export function profileState(device = null) {
  load();
  const devices = Object.entries(loadProfiles().devices).map(([d, p]) => ({ device: d, turns: p.pool.length, his_group: p.group || 0, ready: !!p.centre, frozen: !!p.frozen }));
  const one = device != null ? (devices.find((x) => x.device === deviceKey(device)) || { turns: 0, his_group: 0, ready: false }) : null;
  return { model: !!extractor,
    turns: one ? one.turns : devices.reduce((n, x) => n + x.turns, 0),
    his_group: one ? one.his_group : Math.max(0, ...devices.map((x) => x.his_group)),
    ready: one ? one.ready : devices.some((x) => x.ready),
    devices, gate: gateMode(), same: SAME, other: OTHER,
    needs: `${MIN_GROUP} turns and ${Math.round(MIN_SHARE * 100)}% of that device's pool; until then the best of his other devices` };
}

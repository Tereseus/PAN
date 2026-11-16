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
// DELETE /api/v1/voice/profile starts it again.
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
const POOL_MAX = 200;           // recent turns kept for finding his voice
const MIN_GROUP = Number(process.env.PAN_VOICE_MIN_GROUP || 10);       // env: tests only
const MIN_SHARE = Number(process.env.PAN_VOICE_MIN_SHARE || 0.4);      // env: tests only
const REGROUP_EVERY = 5;        // turns between regroupings (each one about 10 ms)

let extractor = null;
let unavailable = false;
let profile = null;             // { pool: number[][], centre: number[] | null, group: n, added: n }

function load() {
  if (extractor || unavailable) return extractor;
  try {
    if (!existsSync(MODEL)) { unavailable = true; console.log(`[voice-id] no model at ${MODEL}`); return null; }
    const sherpa = require('sherpa-onnx-node');
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model: MODEL, numThreads: 2, debug: 0, provider: 'cpu' });
    try { profile = JSON.parse(readFileSync(PROFILE, 'utf8')); } catch { profile = null; }
    if (profile && !Array.isArray(profile.pool)) profile = null;   // the Nov 12 named-line format
    if (profile?.pool) {   // drop PAN's own voice from the pool (Nov 15)
      const n = profile.pool.length;
      profile.pool = profile.pool.filter((p) => (panVoiceLikeness(unit(p))?.likeness ?? 0) < PAN_SELF);
      if (profile.pool.length < n) { console.log(`[voice-id] dropped ${n - profile.pool.length} turns in PAN's own voice from the pool`); regroup(); save(); }
    }
    console.log(`[voice-id] ready, ${profile?.centre ? `his voice known (${profile.group} of ${profile.pool.length} turns)` : `still learning (${profile?.pool?.length || 0} turns)`}`);
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

function likeness(print) {
  return profile?.centre ? dot(print, profile.centre) : null;
}

// The biggest group of alike voices in the pool: the print with the most alike neighbours is the
// seed, its neighbours the group, their mean (unit length) the centre.
function regroup() {
  const pool = profile.pool;
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

export function gateMode() {
  try { return String(get("SELECT value FROM settings WHERE key = 'voice_id_gate'")?.value || 'observe').replace(/^"|"$/g, '').trim().toLowerCase(); }
  catch { return 'observe'; }
}

/** The voice print of a turn's audio (16 kHz PCM16, base64), or null. */
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

/** { wearer: true | false | undefined, likeness }. wearer is only set when the gate is 'on'. */
export function whoseVoice(print) {
  const l = print ? likeness(print) : null;
  const verdict = l === null ? undefined : l >= SAME ? true : l <= OTHER ? false : undefined;
  return { verdict, likeness: l, wearer: gateMode() === 'on' ? verdict : undefined };
}

/** After every real turn with audio: the pool learns, and his voice is found again now and then. */
export function learnWearer(print) {
  if (!print) return;
  // PAN's own voice must never become his: one of his 200 pool turns scored 0.54 against it (Nov 15).
  if ((panVoiceLikeness(print)?.likeness ?? 0) >= PAN_SELF) return;
  if (!profile || !profile.pool) profile = { pool: [], centre: null, group: 0, added: 0 };
  profile.pool.push(Array.from(print, (x) => Math.round(x * 1e4) / 1e4));
  if (profile.pool.length > POOL_MAX) profile.pool.shift();
  profile.added = (profile.added || 0) + 1;
  if (profile.added % REGROUP_EVERY && profile.centre) { save(); return; }
  const had = !!profile.centre;
  regroup();
  save();
  if (!had && profile.centre) console.log(`[voice-id] found his voice: ${profile.group} of ${profile.pool.length} turns`);
}

function save() {
  try { writeFileSync(PROFILE, JSON.stringify(profile)); } catch (e) { console.warn('[voice-id] save failed:', e.message); }
}

export function resetProfile() {
  profile = null;
  try { unlinkSync(PROFILE); } catch {}
}

export function profileState() {
  load();
  return { model: !!extractor, turns: profile?.pool?.length || 0, his_group: profile?.group || 0, ready: !!profile?.centre,
    gate: gateMode(), same: SAME, other: OTHER, needs: `${MIN_GROUP} turns and ${Math.round(MIN_SHARE * 100)}% of the pool` };
}

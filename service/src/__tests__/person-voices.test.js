// Each person's device knows its own person's voice (person-voices.js). Made-up prints stand
// in for the speaker model: one direction per voice, a little noise per line.
// Usage: node service/src/__tests__/person-voices.test.js

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dir = mkdtempSync(join(tmpdir(), 'pan-person-voices-'));
process.env.PAN_DATA_DIR = dir;
process.env.PAN_DEV = '1';
process.env.PAN_PERSON_VOICES = join(dir, 'person-voices.json');

const { run } = await import('../db.js');
const pv = await import('../person-voices.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  pv.resetPersonVoices();
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

// A voice is a direction in 16 dimensions; a line in that voice is the direction plus noise.
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
const voice = (axis) => Array.from({ length: 16 }, (_, i) => (i === axis ? 1 : 0));
const line = (v, noise = 0.25) => unit(v.map((x) => x + rnd() * noise));
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const OWNER_V = voice(0), MIA_V = voice(1), KIT_V = voice(2), STRANGER_V = voice(3);
// How much a print sounds like the owner: what voice-id.js would say.
const ownerL = (p) => dot(p, OWNER_V);
const teach = (id, v, n = 12) => { for (let i = 0; i < n; i++) { const p = line(v); pv.learnPersonVoice(id, p, { owner: ownerL(p) }); } };

console.log('each person\'s own voice');

test('before a device knows its person: the owner\'s voice is not theirs, anyone else\'s is taken', () => {
  const his = line(OWNER_V), hers = line(MIA_V);
  const a = pv.whoseOnDevice(mia, his, { owner: ownerL(his) });
  ok(a.verdict === 'other' && a.by === 1, J(a));
  const b = pv.whoseOnDevice(mia, hers, { owner: ownerL(hers) });
  ok(b.verdict === 'unknown' && b.leans === null, J(b));
  // His voice from across the room: too faint to be sure, but it leans to him.
  const c = pv.whoseOnDevice(mia, his, { owner: 0.36 });
  ok(c.verdict === 'unsure' && c.leans === 1, J(c));
  ok(pv.whoseOnDevice(mia, null, { owner: null }).verdict === 'unknown', 'no print');
});

test('her voice is learned from her own turns, with nothing for her to do', () => {
  ok(pv.personVoiceState(mia).ready === false, 'known before anything was heard');
  teach(mia, MIA_V, 9);
  ok(pv.personVoiceState(mia).ready === false && pv.personVoiceState(mia).turns === 9, J(pv.personVoiceState(mia)));
  teach(mia, MIA_V, 3);
  ok(pv.personVoiceState(mia).ready === true, J(pv.personVoiceState(mia)));
  const hers = line(MIA_V);
  ok(pv.whoseOnDevice(mia, hers, { owner: ownerL(hers) }).verdict === 'theirs', 'her own voice');
});

test('once it knows her: the owner, another known person and a stranger are all dropped', () => {
  teach(mia, MIA_V);
  teach(kit, KIT_V);
  const his = line(OWNER_V), kits = line(KIT_V), someone = line(STRANGER_V);
  const a = pv.whoseOnDevice(mia, his, { owner: ownerL(his) });
  const b = pv.whoseOnDevice(mia, kits, { owner: ownerL(kits) });
  const c = pv.whoseOnDevice(mia, someone, { owner: ownerL(someone) });
  ok(a.verdict === 'other' && a.by === 1 && b.verdict === 'other' && b.by === kit && c.verdict === 'other' && c.by === null, J([a, b, c]));
  // The owner from across the room, the case that got through before: faint against his own
  // profile, but nothing like her, so it is not hers.
  const faint = unit(OWNER_V.map((x, i) => x * 0.4 + (i > 3 ? 0.25 : 0)));
  const d = pv.whoseOnDevice(mia, faint, { owner: 0.38 });
  ok(d.verdict === 'other' && d.by === 1, J(d));
});

test('her own voice heard badly is not thrown away: unsure, for the room check to settle', () => {
  teach(mia, MIA_V);
  const muffled = unit(MIA_V.map((x, i) => x * 0.4 + (i > 3 ? 0.25 : 0)));
  const a = pv.whoseOnDevice(mia, muffled, { owner: ownerL(muffled) });
  ok(a.verdict === 'unsure' && a.leans === null && a.mine > 0.25 && a.mine < 0.5, J(a));
});

test('a device that mostly hears someone else never learns them as its person', () => {
  // The owner talks near her phone all day: none of it goes in.
  let took = 0;
  for (let i = 0; i < 30; i++) { const p = line(OWNER_V); if (pv.learnPersonVoice(mia, p, { owner: ownerL(p) })) took++; }
  // Faint too: not clearly someone else's, so not hers either.
  for (let i = 0; i < 10; i++) if (pv.learnPersonVoice(mia, line(MIA_V), { owner: 0.3 })) took++;
  ok(took === 0 && pv.personVoiceState(mia).turns === 0, `${took} lines went in`);
  // A known person's voice does not go into another person's pool, nor does PAN's own voice.
  teach(kit, KIT_V);
  const kits = line(KIT_V);
  ok(pv.learnPersonVoice(mia, kits, { owner: ownerL(kits) }) === false && pv.learnPersonVoice(mia, line(MIA_V), { owner: 0, pan: true }) === false, 'someone else\'s went in');
  ok(pv.learnPersonVoice(1, line(OWNER_V), { owner: 1 }) === false, 'the owner has his own profile elsewhere');
});

test('a mixed pool: the voice that keeps coming back wins, a few visitors do not', () => {
  for (let i = 0; i < 14; i++) { const p = line(MIA_V); pv.learnPersonVoice(mia, p, { owner: ownerL(p) }); if (i % 4 === 0) { const s = line(STRANGER_V); pv.learnPersonVoice(mia, s, { owner: ownerL(s) }); } }
  const hers = line(MIA_V), someone = line(STRANGER_V);
  ok(pv.personVoiceState(mia).ready && pv.whoseOnDevice(mia, hers, { owner: 0 }).verdict === 'theirs' && pv.whoseOnDevice(mia, someone, { owner: 0 }).verdict === 'other', J(pv.personVoiceState(mia)));
});

test('forgotten when asked, and kept across a restart', async () => {
  teach(mia, MIA_V);
  const again = await import('../person-voices.js?again');
  ok(again.personVoiceState(mia).ready === true, 'not read back from the file');
  ok(pv.forgetPersonVoice(mia) === true && pv.personVoiceState(mia).turns === 0 && pv.forgetPersonVoice(mia) === false, 'forgetting');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

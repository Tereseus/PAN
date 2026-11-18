// One line heard by two ΠANs in the same room (same-line.js): whose it is, by voice or by
// which device heard it louder. No database, no model.
// Usage: node service/src/__tests__/same-line.test.js

const sl = await import('../same-line.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  sl.resetSameLine();
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}: ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }
const J = (v) => JSON.stringify(v);
const OWNER = 1, MIA = 2, KIT = 3;
const T = 1_000_000;
const tone = (amp, ms = 600) => {
  const b = Buffer.alloc(16 * ms * 2);
  for (let i = 0; i < 16 * ms; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(i / 5)), i * 2);
  return b.toString('base64');
};

console.log('one line on two devices');

await test('how loud a turn is: a nearer voice is louder; too short is nothing', async () => {
  const near = sl.speechLevel(tone(0.5)), far = sl.speechLevel(tone(0.05));
  ok(near > far * 5 && far > 0, `${near} ${far}`);
  ok(sl.speechLevel(tone(0.5, 40)) === null && sl.speechLevel('') === null, 'a click');
});

await test('the same words or not', async () => {
  const w = (t) => t.toLowerCase().replace(/[^a-z ]/g, '').split(' ');
  ok(sl.sameWords(w('pan what time is it'), w('Pan, what time is it?')), 'the same');
  ok(sl.sameWords(w('how is the weather today'), w('how is the feather today')), 'one word heard differently');
  ok(sl.sameWords(w('turn off the lights'), w('turn off the lights and lock the door')), 'one heard more of it');
  ok(!sl.sameWords(w('turn off the lights'), w('what time is it')) && !sl.sameWords(w('yes'), w('yes')) && !sl.sameWords(w('okay then'), w('okay now what')), 'different lines, and one word');
});

await test('no voice print: the device that heard it louder keeps it, whichever came first', async () => {
  const a = await sl.whoseLine({ user: MIA, device: 'mia', text: 'What time is it now?', level: 0.30 }, T);
  const b = await sl.whoseLine({ user: KIT, device: 'kit', text: 'what time is it now', level: 0.04 }, T + 200);
  ok(a.mine === true && b.mine === false && b.with === MIA, J([a, b]));
  // The far one first this time: it went ahead (nothing said to wait), and the near one still keeps its own.
  sl.resetSameLine();
  const c = await sl.whoseLine({ user: KIT, device: 'kit', text: 'Remind me to call the school', level: 0.04 }, T);
  const d = await sl.whoseLine({ user: MIA, device: 'mia', text: 'remind me to call the school', level: 0.30 }, T + 200);
  ok(c.mine === true && d.mine === true, J([c, d]));
  // They have now been heard together: the next first hearing waits, and is told it is not theirs.
  const first = sl.whoseLine({ user: KIT, device: 'kit', text: 'Play some quiet music please', level: 0.04 }, T + 5000, { wait: 300 });
  const second = await sl.whoseLine({ user: MIA, device: 'mia', text: 'play some quiet music please', level: 0.30 }, T + 5100);
  const e = await first;
  ok(e.mine === false && second.mine === true, J([e, second]));
});

await test('waiting ends by itself: a line only one device heard is that device\'s', async () => {
  await sl.whoseLine({ user: MIA, device: 'mia', text: 'what time is it now', level: 0.3 }, T);
  await sl.whoseLine({ user: KIT, device: 'kit', text: 'what time is it now', level: 0.04 }, T + 100);
  const t0 = Date.now();
  const alone = await sl.whoseLine({ user: KIT, device: 'kit', text: 'Where did I leave my shoes?', level: 0.2 }, T + 9000, { wait: 60 });
  ok(alone.mine === true && alone.waited >= 40 && Date.now() - t0 < 1000, J(alone));
  // Different words at the same moment are two lines.
  const x = await sl.whoseLine({ user: MIA, device: 'mia', text: 'Turn the heating up', level: 0.3 }, T + 20_000, { wait: 0 });
  const y = await sl.whoseLine({ user: KIT, device: 'kit', text: 'Is my bus on time', level: 0.3 }, T + 20_100, { wait: 0 });
  ok(x.mine && y.mine, J([x, y]));
  // The same words a minute apart are two lines too, and one word is never compared.
  sl.resetSameLine();
  const p = await sl.whoseLine({ user: MIA, device: 'mia', text: 'good morning everyone', level: 0.3 }, T);
  const q = await sl.whoseLine({ user: KIT, device: 'kit', text: 'good morning everyone', level: 0.01 }, T + 60_000);
  const r = await sl.whoseLine({ user: MIA, device: 'mia', text: 'Yes.', level: 0.3 }, T + 70_000);
  const s = await sl.whoseLine({ user: KIT, device: 'kit', text: 'yes', level: 0.01 }, T + 70_100);
  ok(p.mine && q.mine && r.mine && s.mine, J([p, q, r, s]));
});

await test('a voice print outranks loudness: the owner\'s line is his, on whichever device it was louder', async () => {
  // His own device is sure and never waits; the other device heard it louder and still loses.
  const his = await sl.whoseLine({ user: OWNER, device: 'his', text: 'PAN, what is on my calendar', level: 0.05, leans: OWNER, sure: true }, T);
  const hers = await sl.whoseLine({ user: MIA, device: 'mia', text: 'pan what is on my calendar', level: 0.4, leans: OWNER }, T + 150);
  ok(his.mine === true && his.waited === 0 && hers.mine === false, J([his, hers]));
  // Her device first, the voice on it not clearly someone else's: it waits for his, and gets a no.
  sl.resetSameLine();
  const first = sl.whoseLine({ user: MIA, device: 'mia', text: 'pan add milk to the list', level: 0.2, leans: OWNER }, T, { wait: 300 });
  const second = await sl.whoseLine({ user: OWNER, device: 'his', text: 'PAN, add milk to the list', level: 0.2, leans: OWNER, sure: true }, T + 100);
  ok((await first).mine === false && second.mine === true, 'her device kept his line');
  // His device never heard it (it is off): after the wait, the line is hers after all.
  sl.resetSameLine();
  const only = await sl.whoseLine({ user: MIA, device: 'mia', text: 'pan add milk to the list', level: 0.2, leans: OWNER }, T, { wait: 50 });
  ok(only.mine === true && only.waited >= 30, J(only));
});

await test('as loud as each other and no voice to go by: the first one', async () => {
  const a = await sl.whoseLine({ user: MIA, device: 'mia', text: 'open the garage door', level: 0.20 }, T);
  const b = await sl.whoseLine({ user: KIT, device: 'kit', text: 'open the garage door', level: 0.22 }, T + 100);
  ok(a.mine && !b.mine, J([a, b]));
  // Two devices of ONE person are not this module's business: both go on.
  sl.resetSameLine();
  const c = await sl.whoseLine({ user: MIA, device: 'phone', text: 'open the garage door', level: 0.2 }, T);
  const d = await sl.whoseLine({ user: MIA, device: 'tablet', text: 'open the garage door', level: 0.02 }, T + 100);
  ok(c.mine && d.mine, J([c, d]));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

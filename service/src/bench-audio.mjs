// The audio bench (the owner, Nov 28: the speeds we showed came from typed text on an idle hub, not
// what he hears). Each line is SOUND, sent the way the phone sends a turn (POST /query/stream with
// the turn's audio), so the hub hears it again (Parakeet), runs voice ID, the check for ΠAN's own
// voice, the noise drop and own-tail, then the model. bench_audio marks it: it learns nothing, and
// voice ID's verdict is stood in by bench_voice_his because the voice is a synthetic one.
//
//   node service/src/bench-audio.mjs [--hub http://127.0.0.1:7779] [--as trinket-for-arm64]
//        [--cases service/src/bench-audio-cases.json] [--lines his-lines.json] [--out file.json]
//        [--only id,id] [--quiet-min 10] [--quiet-hub http://127.0.0.1:7777]
//
// Lines are spoken by this computer's own text to speech (Windows SAPI through PowerShell, cached
// as 16 kHz mono WAV in the temp folder), or read from a case's "wav". Nothing leaves this computer
// and the hub. --lines takes his own lines ([{q, talk}], e.g. evals/smartbench/lines.json) for his
// own bench: spoken here, sent only to his hub, results kept where --out says.
//
// It never runs over his talk: before EVERY line it asks the hub when he last talked
// (/api/v1/voice/last-turn) and waits until that is --quiet-min minutes ago.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const HUB = arg('hub', 'http://127.0.0.1:7779');
const AS = arg('as', 'trinket-for-arm64');
const QUIET_MIN = Number(arg('quiet-min', 10));
// Where to ask when he last talked: the live hub, also when the bench itself runs against dev 7781.
const QUIET_HUB = arg('quiet-hub', HUB);
const CACHE = join(tmpdir(), 'pan-bench-audio');
mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- sound
function pcmFromWav(buf) {
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4), size = buf.readUInt32LE(i + 4);
    if (id === 'data') return buf.subarray(i + 8, i + 8 + size);
    i += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in the WAV');
}
function speak(text) {
  const f = join(CACHE, createHash('sha1').update(text).digest('hex').slice(0, 16) + '.wav');
  if (!existsSync(f)) {
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
      `$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);` +
      `$s.SetOutputToWaveFile($env:PAN_BENCH_WAV, $fmt); $s.Speak($env:PAN_BENCH_TEXT); $s.Dispose()`;
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { env: { ...process.env, PAN_BENCH_WAV: f, PAN_BENCH_TEXT: text }, windowsHide: true });
  }
  return pcmFromWav(readFileSync(f));
}
// Road noise: a low rumble plus soft hiss, the level of a car on the motorway through a phone mic.
function noise(kind, ms) {
  const n = Math.round(16 * ms), out = Buffer.alloc(n * 2);
  let low = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    low = 0.985 * low + 0.015 * w;                    // rumble
    b = 0.6 * b + 0.4 * w;                             // hiss
    const hum = kind === 'hum' ? 0.05 * Math.sin((2 * Math.PI * 110 * i) / 16000) : 0;
    const v = Math.max(-1, Math.min(1, 1.8 * low + 0.04 * b + hum));
    out.writeInt16LE(Math.round(v * 9000), i * 2);
  }
  return out;
}

// ---- his talk comes first
async function waitForQuiet() {
  for (;;) {
    let j = null;
    for (let tries = 0; tries < 4 && !j?.ok; tries++) {
      try { j = await (await fetch(`${QUIET_HUB}/api/v1/voice/last-turn`, { signal: AbortSignal.timeout(15_000) })).json(); } catch { await sleep(30_000); }
    }
    // Can't tell when he last talked (no such route, hub not answering): stop, never guess.
    if (!j?.ok) throw new Error(`cannot ask ${QUIET_HUB} when he last talked; not running over his talk`);
    const ago = j.ago_ms;
    if (ago === null || ago >= QUIET_MIN * 60_000) return;
    console.log(`  he talked ${Math.round(ago / 1000)} s ago: waiting`);
    await sleep(60_000);
  }
}

// ---- one turn, the phone's way
async function turn(c, pcm, dev) {
  const body = {
    text: c.phone ?? c.say ?? '', audio: pcm.toString('base64'), bench: true, bench_audio: true, bench_as: AS,
    context: c.context || '', since_pan_ms: c.since_pan_ms ?? null, unfinished: false,
    ...(c.voice === 'his' ? { bench_voice_his: true } : c.voice === 'other' ? { bench_voice_his: false } : {}),
  };
  const t0 = Date.now();
  let first = null, said = '', done = null;
  const r = await fetch(`${HUB}/api/v1/query/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': dev, Connection: 'close' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(Number(arg('turn-timeout', 120)) * 1000) });
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let e; try { e = JSON.parse(line.slice(5)); } catch { continue; }
      if (e.type === 'chunk' && e.text) { if (first === null) first = Date.now() - t0; said += e.text; }
      if (e.type === 'heard') c.heard = e.text;
      if (e.type === 'done') done = e;
    }
  }
  const res = done?.result || {};
  const reply = String(res.response || said || '').trim();
  return { reply, heard: c.heard || null, intent: res.intent || null, reason: res.reason || null, actions: (res.actions || []).map((a) => a.type),
    first_ms: first, whole_ms: Date.now() - t0, steps: res.timing?.steps || null, audio_ms: Math.round(pcm.length / 32) };
}

const quiet = (x) => !x.reply || x.reply.toUpperCase().startsWith('[AMBIENT');
function passed(c, x) {
  if (c.expect === 'quiet') return quiet(x);
  if (c.expect === 'navigate') return x.actions.includes('navigate');
  if (c.expect === 'answer') return !quiet(x);
  return true;
}
const pct = (xs, p) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))] : null; };

const main = async () => {
  let cases;
  if (arg('lines')) {   // his own lines, his own bench: spoken here, sent only to his hub
    cases = JSON.parse(readFileSync(arg('lines'), 'utf8')).map((l, i) => ({ id: `his-${i + 1}`, kind: 'his', say: l.q,
      context: (l.talk || []).map(([w, s]) => `${w}: ${String(s).slice(0, 200)}`).join('\n'), since_pan_ms: l.since_ms ?? null, voice: 'his', expect: 'any' }));
  } else {
    cases = JSON.parse(readFileSync(arg('cases', new URL('./bench-audio-cases.json', import.meta.url)), 'utf8')).cases;
  }
  const only = arg('only'); if (only) cases = cases.filter((c) => only.split(',').includes(c.id));
  const tag = Date.now().toString(36).slice(-5);
  const rows = [];
  for (const [i, c] of cases.entries()) {
    await waitForQuiet();
    const pcm = c.wav ? pcmFromWav(readFileSync(c.wav)) : c.noise ? noise(c.noise, c.ms || 1500) : speak(c.say);
    let x;
    try { x = await turn(c, pcm, `audiobench${tag}-${i}-bench`); } catch (e) { x = { error: e.message.slice(0, 120), reply: '', actions: [] }; }
    const ok = !x.error && passed(c, x);
    rows.push({ id: c.id, kind: c.kind, expect: c.expect, ok, ...x });
    console.log(`${String(i + 1).padStart(2)}/${cases.length} ${ok ? 'pass' : 'FAIL'} ${c.id.padEnd(10)}${x.error ? ` ERROR ${x.error}` : ''} first ${x.first_ms ?? '-'} ms, whole ${x.whole_ms ?? '-'} ms` +
      `${x.reason ? `, ${x.reason}` : ''}${x.actions?.length ? `, ${x.actions.join('+')}` : ''} | heard ${JSON.stringify((x.heard || '').slice(0, 50))} -> ${JSON.stringify((x.reply || '').slice(0, 70))}`);
  }
  const spoke = rows.filter((r) => !quiet(r));
  const stepNames = [...new Set(rows.flatMap((r) => (r.steps || []).map((s) => s[0])))];
  const summary = {
    at: new Date().toISOString(), hub: HUB, as: AS, lines: rows.length, passed: rows.filter((r) => r.ok).length,
    first_words_ms: { p50: pct(spoke.map((r) => r.first_ms), 0.5), p90: pct(spoke.map((r) => r.first_ms), 0.9) },
    whole_ms: { p50: pct(spoke.map((r) => r.whole_ms), 0.5), p90: pct(spoke.map((r) => r.whole_ms), 0.9) },
    steps_ms: Object.fromEntries(stepNames.map((n) => { const v = rows.map((r) => r.steps?.find((s) => s[0] === n)?.[2]); return [n, { p50: pct(v, 0.5), p90: pct(v, 0.9) }]; })),
    dropped: Object.fromEntries([...new Set(rows.map((r) => r.reason).filter(Boolean))].map((k) => [k, rows.filter((r) => r.reason === k).length])),
  };
  const out = arg('out', join(tmpdir(), `pan-bench-audio-${tag}.json`));
  writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
  console.log(`\n${summary.passed} of ${summary.lines} passed. First words p50 ${summary.first_words_ms.p50} ms, p90 ${summary.first_words_ms.p90} ms; whole p50 ${summary.whole_ms.p50} ms, p90 ${summary.whole_ms.p90} ms.`);
  console.log(`Dropped: ${JSON.stringify(summary.dropped)}. Saved ${out}`);
};
main().catch((e) => { console.error(e); process.exit(1); });

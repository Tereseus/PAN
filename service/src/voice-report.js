// Nightly voice report: one day of his real voice turns, how fast and how good, so a good
// version is never lost and a bad one shows the next morning (owner, 2026-11-14: "how do we
// measure this to see the levers"). Written for Claude threads to read, not for him.
//
// Joins, per turn (bench turns left out):
//   situation_turns   every voice turn, said or silent, and why it stayed silent (did.reason)
//   RouterCommand     the reply and its turn id (api.js /query/stream)
//   voice-timing.jsonl hub stages by turn id: asr, setup, first_chunk, first_chunk_sent, total, path
//   client_logs       the phone's own clock: "[STT] commit after Xms", "Stream (first=Xms total=Yms)"
// Then a judge model scores each reply 1 to 5 and says whether each silence after PAN spoke was
// meant for PAN. Judge output is for this report only, never training data.
//
// Output: <data>/voice-reports/YYYY-MM-DD.json and .md, plus a line in index.jsonl.
// CLI: node src/voice-report.js [YYYY-MM-DD] [--no-judge]
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { all, get } from './db.js';
import { getDataDir } from './platform.js';
import { timingFilesFor } from './voice-timing.js';
import { checkSteps, readSteps, busyCheck, reportLines } from './step-budget.js';
import { noteFault } from './fault-reports.js';

const DIR = join(getDataDir(), 'voice-reports');
// Local models only: the judge reads his real lines and ΠAN's replies, and his real data never goes
// to an outside API (the owner's rule). Gemini was first in this list until Nov 28.
const JUDGE_MODELS = ['ollama:gemma4:e4b'];
const MAX_JUDGED = 160;

const pad = (n) => String(n).padStart(2, '0');
export function localDay(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function yesterday() { return localDay(Date.now() - 24 * 3600_000); }

function setting(key) {
  try { return String(get(`SELECT value FROM settings WHERE key = :k`, { ':k': key })?.value || '').replace(/^"|"$/g, '').trim(); } catch { return ''; }
}
const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
const isBenchDevice = (d) => /-bench$/.test(String(d || ''));

function stats(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, p50: q(0.5), p90: q(0.9), max: v[v.length - 1] };
}

function readTimings(day) {
  const byTurn = new Map();
  const totals = [];   // [at, turn] for turns with no RouterCommand (silences)
  const [y, m, dd] = day.split('-').map(Number);
  for (const p of timingFilesFor(new Date(y, m - 1, dd, 12).getTime())) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r.turn || r.bench || isBenchDevice(r.device) || localDay(r.at) !== day) continue;
      const t = byTurn.get(r.turn) || {};
      if (r.stage === 'path') t.path = r.path; else t[r.stage] = r.ms;
      if (r.stage === 'total') totals.push([r.at, r.turn]);
      byTurn.set(r.turn, t);
    }
  }
  return { byTurn, totals };
}

// The phone's own view, by what the hub told it it heard.
function readPhone(day) {
  const rows = all(`SELECT device_id, created_at, message FROM client_logs
                     WHERE created_at >= :d AND created_at < date(:d, '+1 day') AND device_id LIKE 'phone-%'
                       AND (message LIKE '[STT] commit after%' OR message LIKE 'Hub heard:%' OR message LIKE 'Stream (first=%' OR message LIKE 'Build: versionCode=%')
                     ORDER BY id`, { ':d': day });
  const byText = new Map();
  const builds = new Set();
  const pending = new Map();   // device -> { commit, p }
  const last = new Map();      // device -> the turn the next Stream line belongs to
  for (const r of rows) {
    const m = r.message;
    let x;
    if ((x = /^\[STT\] commit after (\d+)ms p=([\d.]+)/.exec(m))) pending.set(r.device_id, { commit: +x[1], p: +x[2] });
    else if (m.startsWith('Hub heard:')) {
      const turn = { device: r.device_id, at: r.created_at, ...(pending.get(r.device_id) || {}) };
      pending.delete(r.device_id);
      byText.set(norm(m.slice(10)), turn);
      last.set(r.device_id, turn);
    } else if ((x = /^Stream \(first=(\d+)ms total=(\d+)ms\)(?: up=(\d+)KB\/(\d+)ms)?/.exec(m))) {
      const t = last.get(r.device_id);
      // up (app 0.5.37 on): the turn's size and how long until the hub began answering, which is
      // the network's share of the wait. In the car on a phone's hotspot it was most of it.
      if (t && t.first == null) { t.first = +x[1]; t.total = +x[2]; if (x[4] != null) { t.up_kb = +x[3]; t.up = +x[4]; } }
    } else if ((x = /^Build: versionCode=(\S+)/.exec(m))) builds.add(`${r.device_id} ${x[1]}`);
  }
  return { byText, builds: [...builds] };
}

// Which voice each device spoke in. The app logs a "Voice: ..." line at every start and each
// time the Android voice takes a line (tts/VoiceChoice.kt). The car unit spoke in the Android
// voice for two days and nothing anywhere said so (2026-11-17 to 19): this puts it in the report.
// rows: [{ device_id, message }] in order. -> [{ device, voice, problems: [..] }], problems first.
const VOICE_FINE = [/^Voice: \S+ ready$/, /^Piper TTS: \S+ voice ready$/, /^Voice: the Android voice, chosen in Settings$/];
export function voicesFrom(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const m = String(r.message || '');
    const d = by.get(r.device_id) || { device: r.device_id, started: false, voice: null, problems: [] };
    by.set(r.device_id, d);
    if (m.startsWith('Build: versionCode=')) { d.started = true; continue; }
    if (!m.startsWith('Voice: ') && !m.startsWith('Piper TTS: ')) continue;
    d.voice = m;
    if (!VOICE_FINE.some((re) => re.test(m)) && !d.problems.includes(m)) d.problems.push(m);
  }
  const out = [];
  for (const d of by.values()) {
    // The app started and said nothing about its voice: a build from before every case logged.
    if (d.started && !d.voice) d.problems.push('started without saying which voice it has (a build before 0.5.37)');
    out.push({ device: d.device, voice: d.voice, problems: d.problems.slice(0, 6) });
  }
  return out.sort((a, b) => b.problems.length - a.problems.length || a.device.localeCompare(b.device));
}

function readVoices(day) {
  return voicesFrom(all(`SELECT device_id, message FROM client_logs
                          WHERE created_at >= :d AND created_at < date(:d, '+1 day') AND device_id LIKE 'phone-%'
                            AND (message LIKE 'Voice: %' OR message LIKE 'Piper TTS: %' OR message LIKE 'Build: versionCode=%')
                          ORDER BY id`, { ':d': day }));
}

function readTurns(day) {
  const start = new Date(`${day}T00:00:00`).getTime();
  const end = start + 24 * 3600_000;
  const st = all(`SELECT at, text, history, did, seen, label FROM situation_turns WHERE at >= :s AND at < :e ORDER BY at`, { ':s': start, ':e': end });
  const rc = all(`SELECT created_at, data FROM events WHERE event_type = 'RouterCommand' AND created_at >= :d AND created_at < date(:d, '+1 day') AND data LIKE '%"source":"phone-voice"%'`, { ':d': day });
  const replies = new Map();
  for (const r of rc) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    if (isBenchDevice(d.device_id)) continue;
    replies.set(norm(d.text), { turn: d.turn_id, intent: d.intent, reply: d.result, device: d.device_id });
  }
  return st.map((r) => {
    let did = {}, seen = {};
    try { did = JSON.parse(r.did || '{}'); } catch {}
    try { seen = JSON.parse(r.seen || '{}'); } catch {}
    const rep = replies.get(norm(r.text)) || {};
    return { at: r.at, text: r.text, history: r.history || '', spoke: !!did.spoke, reason: did.reason || null,
      reply: rep.reply || did.response || '', intent: rep.intent || null, turn: rep.turn || null, device: rep.device || null,
      label: r.label || null, place: seen.place || null, p_pan: seen.p_pan ?? null, since_pan_ms: seen.since_pan_ms ?? null };
  });
}

async function judgeOne(prompt) {
  const { askAI } = await import('./llm.js');
  for (const model of JUDGE_MODELS) {
    try {
      const out = await askAI(prompt, { model, timeout: 30000, maxTokens: 120, caller: 'voice-report', _skipAnonymize: true });
      const j = JSON.parse(String(out).match(/\{[\s\S]*\}/)?.[0] || 'null');
      if (j) return { ...j, judge: model };
    } catch {}
  }
  return null;
}

const lastLines = (h, n = 6) => String(h || '').trim().split('\n').slice(-n).join('\n');

function replyPrompt(t) {
  return `You grade one reply of PAN, a spoken voice assistant that talks with its owner like a smart friend in the room.

The talk so far:
${lastLines(t.history) || '(nothing)'}

He said: "${t.text}"
PAN said: "${String(t.reply).slice(0, 600)}"

Score PAN's reply 1 to 5:
5 = answers what he meant, right for this talk, short and natural out loud
4 = good, small flaw
3 = acceptable but flat, vague, or a bit off
2 = misses what he meant, dodges, wrong facts, or reads like text not speech
1 = wrong, nonsense, or should not have spoken
His words come from speech to text and may be misheard; grade against what he most likely meant.
Reply only JSON: {"score": n, "why": "under 15 words"}`;
}

function silencePrompt(t) {
  return `PAN is a voice assistant that hears everything near its owner and must answer only lines meant for it.
PAN stayed silent on the last line below.

The talk so far:
${lastLines(t.history) || '(nothing)'}

Then he said: "${t.text}"

Was that line said to PAN, so PAN should have answered? Lines to other people, to himself, or song lyrics are not.
Reply only JSON: {"for_pan": true or false, "why": "under 15 words"}`;
}

export async function buildReport(day = yesterday(), { judge = true, log = console.log } = {}) {
  const { byTurn, totals } = readTimings(day);
  const phone = readPhone(day);
  const turns = readTurns(day);

  for (const t of turns) {
    let tm = t.turn ? byTurn.get(t.turn) : null;
    if (!tm) {   // silences have no RouterCommand: the hub 'total' line nearest in time
      let best = null;
      for (const [at, id] of totals) if (Math.abs(at - t.at) < 10_000 && (!best || Math.abs(at - t.at) < Math.abs(best[0] - t.at))) best = [at, id];
      if (best) { t.turn = best[1]; tm = byTurn.get(best[1]); }
    }
    t.hub = tm || {};
    t.phone = phone.byText.get(norm(t.text)) || {};
  }

  // Judge: every reply, and silences within a minute of PAN speaking (where misses hide).
  if (judge) {
    // Silences first, on their own budget: a missed line is the worst failure and they are few.
    let n = 0;
    for (const t of turns) {
      if (n >= 80) break;
      if (!t.spoke && t.since_pan_ms != null && t.since_pan_ms < 60_000 && t.text.split(/\s+/).length >= 2) { t.judged = await judgeOne(silencePrompt(t)); n++; }
    }
    n = 0;
    for (const t of turns) {
      if (n >= MAX_JUDGED) break;
      if (t.spoke && t.reply) { t.judged = await judgeOne(replyPrompt(t)); n++; }
    }
  }

  const spoken = turns.filter((t) => t.spoke);
  const scored = spoken.filter((t) => Number.isFinite(t.judged?.score));
  const silences = turns.filter((t) => !t.spoke);
  const misses = silences.filter((t) => t.judged?.for_pan === true);
  const count = (xs, f) => xs.reduce((m, x) => { const k = f(x) || 'none'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const hubStage = (s) => stats(turns.map((t) => t.hub[s]));

  const report = {
    day,
    made_at: new Date().toISOString(),
    versions: {
      reader: setting('voice_student_model') || null,
      fallback_chain: setting('ai_fallback_chain_voice') || null,
      phone_builds: phone.builds,
    },
    turns: turns.length,
    spoke: spoken.length,
    silent: silences.length,
    silent_why: count(silences, (t) => t.reason),
    paths: count(spoken, (t) => t.hub.path || (t.intent && t.intent !== 'query' ? t.intent : null)),
    speed_ms: {
      phone_end_of_speech: stats(turns.map((t) => t.phone.commit)),
      phone_first_words: stats(spoken.map((t) => t.phone.first)),
      phone_upload_and_back: stats(spoken.map((t) => t.phone.up)),
      phone_reply_done: stats(spoken.map((t) => t.phone.total)),
      hub_asr: hubStage('asr'),
      hub_setup: hubStage('setup'),
      hub_model_first: hubStage('first_chunk'),
      hub_first_sent: hubStage('first_chunk_sent'),
      hub_total: hubStage('total'),
    },
    quality: {
      judged: scored.length,
      mean: scored.length ? +(scored.reduce((s, t) => s + t.judged.score, 0) / scored.length).toFixed(2) : null,
      good_share: scored.length ? +(scored.filter((t) => t.judged.score >= 4).length / scored.length).toFixed(2) : null,
      by_path: Object.fromEntries(Object.entries(count(scored, (t) => t.hub.path)).map(([p]) => {
        const xs = scored.filter((t) => (t.hub.path || 'none') === p);
        return [p, { n: xs.length, mean: +(xs.reduce((s, t) => s + t.judged.score, 0) / xs.length).toFixed(2) }];
      })),
      silences_judged: silences.filter((t) => t.judged).length,
      missed: misses.length,
    },
    turn_book_labels: count(turns.filter((t) => t.label), (t) => t.label),
    worst: scored.sort((a, b) => a.judged.score - b.judged.score).slice(0, 8)
      .map((t) => ({ at: new Date(t.at).toLocaleTimeString(), said: t.text, reply: String(t.reply).slice(0, 200), score: t.judged.score, why: t.judged.why, path: t.hub.path || null })),
    missed_lines: misses.slice(0, 8).map((t) => ({ at: new Date(t.at).toLocaleTimeString(), said: t.text, reason: t.reason, why: t.judged.why })),
    voices: readVoices(day),
    slowest: spoken.filter((t) => Number.isFinite(t.phone.first)).sort((a, b) => b.phone.first - a.phone.first).slice(0, 5)
      .map((t) => ({ at: new Date(t.at).toLocaleTimeString(), said: t.text.slice(0, 80), phone_first: t.phone.first, hub_first_sent: t.hub.first_chunk_sent ?? null, path: t.hub.path || null })),
    budget: stepBudget(day),
  };
  // Over budget and each device's speed go to Memory > Reports too (part 'speed'), where he sees
  // them; nothing personal in them, only steps, devices and times.
  for (const l of reportLines(day, report.budget)) noteFault('speed', l.what, l.detail);

  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${day}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(DIR, `${day}.md`), toMarkdown(report, previous(day)));
  const idx = join(DIR, 'index.jsonl');
  const kept = existsSync(idx) ? readFileSync(idx, 'utf8').split('\n').filter((l) => l && !l.includes(`"day":"${day}"`)) : [];
  writeFileSync(idx, kept.length ? kept.join('\n') + '\n' : '');
  appendFileSync(idx, JSON.stringify({ day, turns: report.turns, spoke: report.spoke, mean: report.quality.mean,
    good_share: report.quality.good_share, missed: report.quality.missed, phone_first_p50: report.speed_ms.phone_first_words?.p50 ?? null,
    end_of_speech_p50: report.speed_ms.phone_end_of_speech?.p50 ?? null, reader: report.versions.reader }) + '\n');
  log(`[voice-report] ${day}: ${report.turns} turns, ${report.spoke} replies, quality ${report.quality.mean ?? '-'}, missed ${report.quality.missed}`);
  return report;
}

/** Every step of the day's real turns against its budget (step-budget.js). Never throws. */
function stepBudget(day) {
  try {
    const { rows, bench } = readSteps(day, localDay);
    return checkSteps(rows, busyCheck(bench));
  } catch (e) { return { error: e.message, turns: 0, quiet: 0, devices: {}, steps: {}, over: [] }; }
}

function previous(day) {
  try {
    const days = readdirSync(DIR).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f) && f < `${day}.json`).sort();
    return days.length ? JSON.parse(readFileSync(join(DIR, days[days.length - 1]), 'utf8')) : null;
  } catch { return null; }
}

function toMarkdown(r, prev) {
  const delta = (a, b) => (a == null || b == null ? '' : ` (was ${b})`);
  const s = (k) => r.speed_ms[k] ? `${r.speed_ms[k].p50} / ${r.speed_ms[k].p90}` : '-';
  const ps = (k) => prev?.speed_ms?.[k]?.p50 ?? null;
  const lines = [
    `# Voice report ${r.day}`,
    '',
    `Reader: ${r.versions.reader || '-'}. Phones: ${r.versions.phone_builds.join(', ') || '-'}.`,
    `${r.turns} turns, ${r.spoke} replies, ${r.silent} silent (${Object.entries(r.silent_why).map(([k, v]) => `${k} ${v}`).join(', ')}).`,
    `Paths: ${Object.entries(r.paths).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    '',
    `Quality: mean ${r.quality.mean ?? '-'}${delta(r.quality.mean, prev?.quality?.mean)}, good ${r.quality.good_share ?? '-'}${delta(r.quality.good_share, prev?.quality?.good_share)}, missed ${r.quality.missed} of ${r.quality.silences_judged} silences judged${delta(r.quality.missed, prev?.quality?.missed)}.`,
    '',
    '| Stage (ms) | p50 / p90 | last p50 |',
    '|---|---|---|',
    ...Object.keys(r.speed_ms).map((k) => `| ${k} | ${s(k)} | ${ps(k) ?? '-'} |`),
    '',
  ];
  const b = r.budget;
  if (b && b.turns) {
    const sec = (x) => (x == null ? '-' : (x / 1000).toFixed(1));
    lines.push('## Real turns per device (hub side, quiet turns)', '', '| Device | Turns | First words p50 / p90 (s) | Whole reply p50 / p90 (s) |', '|---|---|---|---|',
      ...Object.entries(b.devices).map(([d, x]) => `| ${d} | ${x.turns}${x.busy ? ` (${x.busy} during a bench)` : ''} | ${sec(x.first?.p50)} / ${sec(x.first?.p90)} | ${sec(x.whole?.p50)} / ${sec(x.whole?.p90)} |`), '');
    lines.push('## Steps against their budgets (step-budget.js)', '', '| Step | Budget ms | p50 / p90 ms | Over |', '|---|---|---|---|',
      ...Object.entries(b.steps).map(([k, x]) => `| ${k} | ${x.budget ?? '-'} | ${x.p50 ?? '-'} / ${x.p90 ?? '-'} | ${x.over ? `${x.over} of ${x.n}, worst +${x.worst_over}` : '-'} |`), '');
  }
  const wrong = (r.voices || []).filter((v) => v.problems.length);
  if (wrong.length) lines.push('## Voices: NOT all on PAN\'s voice', '', ...wrong.flatMap((v) => v.problems.map((p) => `- ${v.device}: ${p}`)), '');
  else if ((r.voices || []).length) lines.push(`Voices: every device that started was on its set voice (${r.voices.length}).`, '');
  if (r.worst.length) lines.push('## Worst replies', '', ...r.worst.map((w) => `- ${w.at} [${w.score}, ${w.path || '-'}] "${w.said}" -> "${w.reply}" (${w.why})`), '');
  if (r.missed_lines.length) lines.push('## Missed (silent, judged for PAN)', '', ...r.missed_lines.map((m) => `- ${m.at} [${m.reason || '-'}] "${m.said}" (${m.why})`), '');
  if (r.slowest.length) lines.push('## Slowest first words', '', ...r.slowest.map((x) => `- ${x.at} phone ${x.phone_first} ms, hub ${x.hub_first_sent ?? '-'} ms, ${x.path || '-'}: "${x.said}"`), '');
  return lines.join('\n');
}

// Run from the steward: once a day, for yesterday, between 01:00 and 07:00 hub time (heavy
// jobs after 01:00, never in his working hours), and only when no voice turn in 10 min.
export async function maybeRun() {
  const h = new Date().getHours();
  if (h < 1 || h >= 7) return false;
  const day = yesterday();
  if (existsSync(join(DIR, `${day}.json`))) return false;
  try {
    const recent = get(`SELECT MAX(at) AS t FROM situation_turns`)?.t || 0;
    if (Date.now() - recent < 10 * 60_000) return false;
  } catch {}
  await buildReport(day);
  return true;
}

if (process.argv[1] && /voice-report\.js$/.test(process.argv[1])) {
  const day = process.argv.find((a) => /^\d{4}-\d\d-\d\d$/.test(a)) || yesterday();
  buildReport(day, { judge: !process.argv.includes('--no-judge') })
    .then((r) => { console.log(readFileSync(join(DIR, `${day}.md`), 'utf8')); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}

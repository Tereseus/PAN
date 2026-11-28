// A time budget for every step of a voice turn (the owner, Nov 28: "if we add more features, it
// gets worse"). The steps clock (voice-timing.js startSteps / step / endSteps) records when each
// step of a real turn ended; this file holds each step's budget and checks a day of real turns
// against it, so a feature that makes a step slower shows up the next morning, in Memory > Reports
// (fault-reports.js, part 'speed') and in the nightly voice report (voice-report.js).
//
// Budgets: the p90 of his real turns while the hub was quiet (no bench row from 3 min before to
// 30 s after the turn), Nov 27 21:49 to Nov 28 13:19, 18 quiet turns of 21, car and Pixel, rounded
// up. Older stage rows (73 hub hearing times) agree: Parakeet p50 252 ms, p90 978 ms. They are
// guards against getting slower, not targets: first words in under a second is the target.
// A step with null budget is not checked (its time depends on the reply's length or the path).

import { readFileSync, existsSync } from 'fs';
import { timingFilesFor, timingFile } from './voice-timing.js';

export const BUDGET_MS = {
  turn_opened: 5,
  voice_id: 100,                 // quiet p50 49, p90 96; the first line after a start was 3,361 before warmVoiceId
  hub_hears_again: 600,          // Parakeet: p50 306, p90 550
  same_line_check: 10,
  echo_and_call_checks: 10,
  rules_before_model: 40,        // p50 5, p90 28
  memory_recall: 10,
  tool_blocks: 100,              // p50 3, p90 86
  projects_check: 200,           // the meaning embedding: p50 3, p90 179, max 292 when quiet
  voice_prompt_built: 10,
  voice_model_first_words: 1100, // the voice reader: p50 269, p90 1046
  world_lookup: 500,             // Nov 27 warm: 84 to 123
  projects_answer: 4000,         // Haiku on his login, whole answer: 2.5 to 3.9 s
  full_prompt_built: 1500,       // only on the backup path
  voice_model_gave_up: 0,        // any at all is over: the backup answers, 10 s or more
  first_words_sent: null,        // the gap since the step before: depends on the path
  reply_done: null,              // depends on the reply's length
};
// The whole hub side up to the first words, from the turn's start (not one step).
export const FIRST_WORDS_BUDGET_MS = 1500;

function pct(xs, p) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))] : null;
}
function summary(xs) {
  const v = xs.filter(Number.isFinite);
  return v.length ? { n: v.length, p50: pct(v, 0.5), p90: pct(v, 0.9), max: pct(v, 1) } : null;
}

/** A bench row from 3 min before to 30 s after the turn means the hub was busy with a bench. */
export function busyCheck(benchAts) {
  const a = [...benchAts].sort((x, y) => x - y);
  return (t) => {
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (a[m] < t - 180_000) lo = m + 1; else if (a[m] > t + 30_000) hi = m - 1; else return true;
    }
    return false;
  };
}

/**
 * rows: real (non bench) 'steps' rows { at, device, steps: [[name, sinceStart, sinceLast]] }.
 * Returns per device first words and whole reply (all turns and quiet turns), and per step the
 * quiet turns over budget. Busy turns are counted but not held against a step: a bench, not a
 * feature, made them slow.
 */
export function checkSteps(rows, isBusy = () => false) {
  const devices = {};
  const steps = {};
  let quiet = 0;
  for (const r of rows) {
    if (!Array.isArray(r?.steps)) continue;
    const busy = isBusy(r.at);
    if (!busy) quiet++;
    const dev = String(r.device || 'unknown');
    const d = (devices[dev] = devices[dev] || { first: [], whole: [], firstQuiet: [], wholeQuiet: [], busy: 0 });
    const fw = r.steps.find((s) => s[0] === 'first_words_sent')?.[1];
    const done = r.steps.find((s) => s[0] === 'reply_done')?.[1];
    d.first.push(fw); d.whole.push(done);
    if (busy) { d.busy++; continue; }
    d.firstQuiet.push(fw); d.wholeQuiet.push(done);
    const check = [...r.steps.map(([name, , ms]) => [name, ms, BUDGET_MS[name]])];
    if (Number.isFinite(fw)) check.push(['first_words_from_start', fw, FIRST_WORDS_BUDGET_MS]);
    for (const [name, ms, budget] of check) {
      const s = (steps[name] = steps[name] || { budget: budget ?? null, times: [], over: 0, worst_over: 0 });
      s.times.push(ms);
      if (budget != null && ms > budget) { s.over++; s.worst_over = Math.max(s.worst_over, ms - budget); }
    }
  }
  const out = { turns: rows.length, quiet, devices: {}, steps: {}, over: [] };
  for (const [dev, d] of Object.entries(devices)) {
    out.devices[dev] = { turns: d.first.length, busy: d.busy, first: summary(d.firstQuiet), whole: summary(d.wholeQuiet), first_all: summary(d.first), whole_all: summary(d.whole) };
  }
  for (const [name, s] of Object.entries(steps)) {
    out.steps[name] = { budget: s.budget, ...summary(s.times), over: s.over, worst_over: s.worst_over };
    if (s.over) out.over.push({ step: name, budget: s.budget, over: s.over, of: s.times.length, worst_over: s.worst_over, p90: pct(s.times, 0.9) });
  }
  out.over.sort((a, b) => b.over - a.over || b.worst_over - a.worst_over);
  return out;
}

/** One day's real steps rows and the bench rows' times, from the voice-timing files. */
export function readSteps(day, localDay) {
  const [y, m, dd] = day.split('-').map(Number);
  const rows = [];
  const bench = [];
  const noon = new Date(y, m - 1, dd, 12).getTime();
  for (const p of [...timingFilesFor(noon), timingFile(noon, true)]) {
    if (!existsSync(p)) continue;
    const isBenchFile = /bench/.test(p);
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!Number.isFinite(r.at)) continue;
      const near = Math.abs(r.at - noon) < 36 * 3600_000;
      if (!near) continue;
      if (isBenchFile || r.bench || /-bench$/.test(String(r.device || ''))) { bench.push(r.at); continue; }
      if (r.stage === 'steps' && localDay(r.at) === day) rows.push(r);
    }
  }
  return { rows, bench };
}

/** Plain lines for Memory > Reports: nothing personal, only steps, devices and times. */
export function reportLines(day, res) {
  const lines = [];
  for (const [dev, d] of Object.entries(res.devices)) {
    if (!d.first && !d.whole) continue;
    const f = d.first ? `first words ${(d.first.p50 / 1000).toFixed(1)} s, slowest tenth ${(d.first.p90 / 1000).toFixed(1)} s` : 'no first words';
    const w = d.whole ? `whole reply ${(d.whole.p50 / 1000).toFixed(1)} s, slowest tenth ${(d.whole.p90 / 1000).toFixed(1)} s` : '';
    lines.push({ what: `Speed on ${day}: ${dev}`, detail: `${d.turns} turns${d.busy ? ` (${d.busy} while a bench ran, left out)` : ''}; on the hub ${f}; ${w}. The phone's own time is not in these yet.` });
  }
  for (const o of res.over) {
    lines.push({ what: `Over its time budget: ${o.step}`, detail: `${day}: ${o.over} of ${o.of} turns over ${o.budget} ms, worst by ${o.worst_over} ms, slowest tenth ${o.p90} ms.` });
  }
  return lines;
}

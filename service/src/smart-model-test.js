// "Test it on this computer" (task 1098, step 3, the owner Nov 27): the smart model picker's button.
// Runs the standard made-up twin project bench, the same 20 questions as our reference numbers
// (bench-reference.json), on THIS hub with one picker choice, so the person sees what that model
// really gives here next to what we measured.
//
// Only the made-up twin goes to the model, never the person's own notes. The results stay in the data
// dir (bench-own.json); sending them anywhere is a later step (Memory > Reports, with a yes).
// One test at a time, in the background. It stands aside while the owner is talking, the same
// rule as the nightly bench (benchmark.js): it waits until 5 min after his last real voice turn.
//
// The bench file: bench-twin.json next to this file, shipped with ΠAN (Nov 28): made-up projects of a
// made-up person, written by an open model with no real data in its prompt, so it can go to anyone.
// A bench-twin.json in the data dir is only read when the shipped one is missing.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { getDataDir } from './platform.js';

const QUIET_MS = 5 * 60_000;
const QUESTION_MS = 180_000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ownFile = () => join(getDataDir(), 'bench-own.json');

/** The twin bench: { today, notes: { projects, waiting_on_owner, owner_waiting_on }, cases: [...] }. */
export function twinBench() {
  for (const p of [new URL('./bench-twin.json', import.meta.url), join(getDataDir(), 'bench-twin.json')]) {
    try { if (existsSync(p)) { const b = JSON.parse(readFileSync(p, 'utf8')); if (b?.cases?.length && b?.notes) return b; } } catch {}
  }
  return null;
}

// The same prompt as the bench that made our reference numbers (evals/projects/twin_run.mjs).
function render(o) {
  const out = [];
  if (o.waiting_on_owner?.length) out.push('WAITING ON YOU:', ...o.waiting_on_owner.map((l) => '- ' + l), '');
  if (o.owner_waiting_on?.length) out.push('YOU ARE WAITING ON:', ...o.owner_waiting_on.map((l) => '- ' + l), '');
  for (const p of o.projects || []) {
    out.push(`PROJECT: ${p.name}`, p.summary || '', ...(p.facts || []).map((f) => '- ' + f));
    for (const q of p.qa || []) out.push(`Q: ${q.q}`, `A: ${q.a}`);
    out.push('');
  }
  return out.join('\n');
}
const answerPrompt = (today, notes, q) => `Today is ${today}. You are the person's voice assistant. Answer from these project notes only. Never add anything the notes do not say; if they do not say, say you don't know. Answer the way you would say it out loud: one to three short sentences, the answer first, no lists.

Project notes:
${notes}

He asks: "${q}"
Your answer:`;

export function scoreReply(c, reply) {
  const miss = (c.need || []).filter((g) => !new RegExp(g, 'i').test(reply));
  const bad = (c.wrong || []).filter((g) => new RegExp(g, 'i').test(reply));
  return !!reply && !miss.length && !bad.length;
}

function hardware() {
  const cpu = os.cpus()[0]?.model?.replace(/\s+/g, ' ').trim() || 'unknown processor';
  return `${cpu}, ${os.cpus().length} threads, ${Math.round(os.totalmem() / 1e9)} GB`;
}

function readOwn() { try { return JSON.parse(readFileSync(ownFile(), 'utf8')); } catch { return { models: {} }; } }

const med = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };

let job = null;   // { id, started, done, of, right, waiting, error, finished }

/** What is running now, or the last one that ran since the start. */
export function testState() { return job ? { ...job } : null; }

/** About how many minutes a test of this choice takes: our reference time, else 10 s a question. */
export function testMinutes(id, reference) {
  const s = reference?.models?.[id]?.whole_s ?? 10;
  return Math.max(1, Math.ceil((s * (twinBench()?.cases?.length || 20)) / 60));
}

/** Starts a test in the background. { ok, error } — 'busy' while one runs, 'no bench' without the twin. */
export function startTest(id, { ask = null } = {}) {
  if (job && !job.finished) return { ok: false, error: 'busy', running: job.id };
  const bench = twinBench();
  if (!bench) return { ok: false, error: 'no bench' };
  job = { id, started: new Date().toISOString(), done: 0, of: bench.cases.length, right: 0, waiting: false, error: null, finished: false };
  const me = job;
  run(me, bench, ask).catch((e) => { me.error = e.message; }).finally(() => { me.finished = true; me.waiting = false; });
  return { ok: true, of: me.of };
}

async function run(me, bench, ask) {
  // Loaded here, so the picker's routes and the unit tests do not load the model layer.
  if (!ask) ask = (await import('./llm-fallback.js')).askAIStreamWithFallback;
  const notes = render(bench.notes);
  const rows = [];
  for (const c of bench.cases) {
    while (Date.now() - (globalThis.__panLastVoiceAt || 0) < QUIET_MS) { me.waiting = true; await delay(30_000); }
    me.waiting = false;
    const t0 = Date.now();
    let text = '', first = null, err = null;
    try {
      for await (const chunk of ask(answerPrompt(bench.today, notes, c.ask), {
        chain: [me.id], callerClass: 'smart', caller: 'smart-model-test', maxTokens: 1200,
        _skipAnonymize: true, firstTokenMs: QUESTION_MS, timeout: QUESTION_MS, signal: AbortSignal.timeout(QUESTION_MS),
      })) {
        if (chunk && first === null) first = Date.now() - t0;
        text += chunk || '';
      }
    } catch (e) { err = e.message; }
    const reply = text.replace(/\s+/g, ' ').trim();
    const right = !err && scoreReply(c, reply);
    rows.push({ right, s: (Date.now() - t0) / 1000, first: first == null ? null : first / 1000 });
    me.done += 1;
    if (right) me.right += 1;
  }
  const whole = med(rows.map((r) => r.s));
  const firstMed = med(rows.map((r) => r.first));
  const result = {
    right: me.right, of: me.of,
    whole_s: whole == null ? null : Math.round(whole * 10) / 10,
    // A first word is only worth showing when it came well before the whole answer (it streamed).
    first_s: firstMed != null && whole != null && firstMed < whole * 0.8 ? Math.round(firstMed * 10) / 10 : null,
    at: new Date().toISOString().slice(0, 10),
    hardware: hardware(),
  };
  const own = readOwn();
  own.models = { ...(own.models || {}), [me.id]: result };
  writeFileSync(ownFile(), JSON.stringify(own, null, 1));
  console.log(`[smart-model-test] ${me.id}: ${result.right} of ${result.of}, about ${result.whole_s} s an answer`);
}

/** "Your test: 18 of 20 right, about 5 s an answer, Nov 28.", or '' when this choice was never tested. */
export function ownLine(id) {
  const m = readOwn().models?.[id];
  if (!m) return '';
  const time = m.first_s != null ? `first word in about ${m.first_s} s` : `about ${m.whole_s} s an answer`;
  const day = new Date(`${m.at}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Your test: ${m.right} of ${m.of} right, ${time}, ${day}.`;
}

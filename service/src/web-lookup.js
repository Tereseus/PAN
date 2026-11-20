// Looking a question up on the web, the way a person would: the computer's own browser opens a
// search page and code reads it. No key, no account, nothing hosted.
//
// What was measured (right-answer bench, 88 general questions, Nov 20): the hub model alone 58
// right and 18 false; with a few lines from the search page 80 right and 7 false, in every
// language asked. Wikipedia's own search held the answer 27 times of 88, the search page 75.
//
// Three things that decide whether it works:
//   1. A REAL browser window, parked off screen. The browser's "headless" mode gets a bot check
//      from DuckDuckGo every time; a normal window does not.
//   2. Code reads the page and hands the model only the few lines that speak to the question
//      (about 400 characters). Handed whole pages, a hub with no graphics card took six seconds.
//   3. A bot check is never worked around. The engine is left alone for a while and the caller
//      gets nothing, so the model answers from what it knows and says when it is not sure.
//
// The profile is a throwaway folder, wiped when the browser closes: no cookies or history are kept
// from one use to the next. The browser closes itself after IDLE_MS without a lookup.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: (q) => 'https://duckduckgo.com/?ia=web&q=' + encodeURIComponent(q) },
  bing: { name: 'Bing', url: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q) },
  qwant: { name: 'Qwant', url: (q) => 'https://www.qwant.com/?t=web&q=' + encodeURIComponent(q) },
  brave: { name: 'Brave Search', url: (q) => 'https://search.brave.com/search?q=' + encodeURIComponent(q) },
};
export const DEFAULT_ENGINE = 'duckduckgo';
const IDLE_MS = 5 * 60_000;        // the browser closes after this long without a lookup
const BOT_REST_MS = 30 * 60_000;   // an engine that showed a bot check is left alone this long
const NOTES_BUDGET = 450;          // characters of notes handed to the model
const CACHE_MS = 10 * 60_000;      // the same question asked again inside this long is not searched again
const DAY_LIMIT = 300;             // lookups a day; far more than a person asks, far less than a program would

/**
 * Which engine to use now: the one chosen, else the next one that is not resting after a bot
 * check. null when every engine is resting. Pure: `resting` maps an engine to the time its rest ends.
 */
export function engineFor(chosen, resting, now = Date.now()) {
  const order = [chosen, DEFAULT_ENGINE, 'bing', 'qwant'].filter((e, i, a) => ENGINES[e] && a.indexOf(e) === i);
  return order.find((e) => !((resting.get ? resting.get(e) : resting[e]) > now)) || null;
}

// ---- reading a page: pure, tested in __tests__/web-lookup.test.js -----------------------------

const BOT = /unusual traffic|are you a robot|not a robot|captcha|verify(?:ing)? (?:you are|you're|you’re) (?:human|not a bot)|select all squares|bots use duckduckgo|verification required|sending automated queries/i;
/** A page that asks the reader to prove it is a person. Such a page is short; a results page that merely has the word is not one. */
export function looksLikeBotCheck(text) {
  const t = String(text || '');
  return t.length < 1500 && BOT.test(t);
}

export function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"(])|(?<=[。！？])/u).map((s) => s.trim()).filter((s) => s.length > 12);
}

/** What a line is made of, for overlap: words (cut to six letters, a crude stem) in scripts with spaces, pairs of characters in scripts without. */
export function grams(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/.test(w)) { for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2)); }
    else if (w.length >= 3 || /\d/.test(w)) out.add(w.length > 6 ? w.slice(0, 6) : w);
  }
  return out;
}

/** The lines of a results page worth ranking: [{ text, top }]. What the page puts first (its own direct answer) is marked top. */
export function pageLines(pageText) {
  const lines = String(pageText || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 12)
    .flatMap((l) => (l.length > 200 ? sentences(l) : [l]));
  return lines.slice(0, 120).map((text, i) => ({ text, top: i < 12 }));
}

/**
 * The lines that speak to the question, inside a budget of characters. No word lists: a word of
 * the question that every line has counts for little, a line that only says the question back
 * (a page title, a link) counts for nothing.
 */
export function pick(question, lines, budget = NOTES_BUDGET) {
  const q = grams(question);
  const sets = lines.map((c) => grams(c.text));
  const df = new Map();
  for (const s of sets) for (const g of s) if (q.has(g)) df.set(g, (df.get(g) || 0) + 1);
  const N = Math.max(1, lines.length);
  const scored = lines.map((c, i) => {
    let s = 0;
    for (const g of q) if (sets[i].has(g)) s += Math.log(1 + N / df.get(g));
    let own = 0;
    for (const g of sets[i]) if (!q.has(g)) own++;
    if (own < 3 || /^https?:\/\/|\s›\s/.test(c.text)) s = 0;
    return { text: c.text, s: s * (c.top ? 1.25 : 1), i };
  }).filter((c) => c.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
  const kept = [];
  const seen = new Set();
  let used = 0;
  for (const c of scored) {
    const line = c.text.length > 260 ? c.text.slice(0, 260) + '…' : c.text;
    const key = c.text.slice(0, 60);
    if (seen.has(key) || used + line.length > budget) continue;
    seen.add(key); kept.push(line); used += line.length;
    if (kept.length >= 4) break;
  }
  return kept;
}

/** From the text of a results page to the notes for one question (an empty list when the page says nothing to it). */
export function notesFromPage(question, pageText, budget = NOTES_BUDGET) {
  return pick(question, pageLines(pageText), budget);
}

// ---- the browser -----------------------------------------------------------------------------

/** The computer's own browser, or null. Edge is on every Windows 10 and 11 PC. */
export function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:/Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', local = process.env.LOCALAPPDATA || '';
  const places = process.platform === 'win32' ? [
    path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'), path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(pf, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Google/Chrome/Application/chrome.exe'), local && path.join(local, 'Google/Chrome/Application/chrome.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return places.filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lane = null;            // { child, ws, send, profile }
let starting = null;        // the start in progress, shared by lookups that arrive together
let queue = Promise.resolve();
let idleTimer = null;
const resting = new Map();  // engine -> time until which it is left alone
const seen = new Map();     // engine -> { ok, blocked, lastOkAt, lastBlockedAt }
const cache = new Map();    // question -> { at, notes, engine }
let day = { key: '', n: 0 };
let onBlocked = null;
const tally = (engine) => { if (!seen.has(engine)) seen.set(engine, { ok: 0, blocked: 0, lastOkAt: 0, lastBlockedAt: 0 }); return seen.get(engine); };
const today = () => new Date().toISOString().slice(0, 10);

/** Called with { engine, name, until } when a search site shows a bot check, so the app can tell the person. */
export function setBlockedListener(fn) { onBlocked = typeof fn === 'function' ? fn : null; }

/**
 * For the settings page and the alerts: is there a browser, which engines are resting after a bot
 * check and until when, and how many lookups today.
 */
export function lookupStatus(chosen = DEFAULT_ENGINE, now = Date.now()) {
  const using = engineFor(chosen, resting, now);
  return {
    browser: !!findBrowser(), chosen, using, usingName: using ? ENGINES[using].name : null,
    today: day.key === today() ? day.n : 0, dayLimit: DAY_LIMIT,
    engines: Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name, blockedUntil: (resting.get(id) || 0) > now ? resting.get(id) : 0, ...tally(id) })),
  };
}

async function start() {
  const exe = findBrowser();
  if (!exe || typeof WebSocket === 'undefined') return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pan-lookup-'));
  // Port 0: the browser picks a free one and writes it to DevToolsActivePort in the profile.
  const child = spawn(exe, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--window-position=-3000,-3000', '--window-size=1100,900', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  let port = 0;
  for (let i = 0; i < 40 && !port; i++) {
    await sleep(200);
    try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0; } catch {}
  }
  let target = null;
  for (let i = 0; i < 20 && port && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
    if (!target) await sleep(150);
  }
  if (!target) { try { child.kill(); } catch {} wipe(profile); return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const opened = await new Promise((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); });
  if (!opened) { try { child.kill(); } catch {} wipe(profile); return null; }
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => { let j; try { j = JSON.parse(m.data); } catch { return; } if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j.result || {}); waiting.delete(j.id); } };
  const send = (method, params = {}) => new Promise((r) => {
    const n = ++id;
    waiting.set(n, r);
    setTimeout(() => { if (waiting.has(n)) { waiting.delete(n); r({}); } }, 5000).unref?.();
    try { ws.send(JSON.stringify({ id: n, method, params })); } catch { waiting.delete(n); r({}); }
  });
  await send('Page.enable');
  const made = { child, ws, send, profile };
  child.on('exit', () => { if (lane === made) lane = null; wipe(profile); });
  return made;
}

function wipe(profile) {
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 800).unref?.();
}

/** Close the browser now (also done after IDLE_MS, and when this process ends). */
export function closeBrowser() {
  const l = lane;
  lane = null;
  starting = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!l) return;
  try { l.ws.close(); } catch {}
  try { l.child.kill(); } catch {}
}
process.on('exit', () => { try { lane?.child.kill(); } catch {} });

async function ready() {
  if (lane) return lane;
  if (!starting) starting = start().then((l) => { lane = l; starting = null; return l; }).catch(() => { starting = null; return null; });
  return starting;
}

/**
 * The text of the results page for one search: { text, ms, bot } or null when there is no browser
 * to use. One search at a time. Read once the page has stopped growing, or at the time limit.
 */
export function searchPage(q, { engine = DEFAULT_ENGINE, timeoutMs = 3500 } = {}) {
  const run = async () => {
    const eng = ENGINES[engine] || ENGINES[DEFAULT_ENGINE];
    if ((resting.get(engine) || 0) > Date.now()) return null;
    const l = await ready();
    if (!l) return null;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeBrowser, IDLE_MS);
    idleTimer.unref?.();
    const t0 = Date.now();
    await l.send('Page.navigate', { url: eng.url(q) });
    let text = '', last = -1, still = 0;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(120);
      const r = await l.send('Runtime.evaluate', { expression: '(document.querySelector("main") || document.body || {}).innerText || ""', returnByValue: true });
      text = (r.result && r.result.value) || '';
      if (looksLikeBotCheck(text)) {
        resting.set(engine, Date.now() + BOT_REST_MS);
        const t = tally(engine); t.blocked++; t.lastBlockedAt = Date.now();
        console.warn(`[web-lookup] ${eng.name} showed a bot check: left alone for ${BOT_REST_MS / 60000} minutes`);
        try { if (onBlocked) onBlocked({ engine, name: eng.name, until: resting.get(engine) }); } catch {}
        return { text: '', ms: Date.now() - t0, bot: true };
      }
      // the results come in after the page shell: wait for real text that has stopped growing
      if (text.length > 1500 && text.length === last) { if (++still >= 3) break; } else still = 0;
      last = text.length;
    }
    return { text, ms: Date.now() - t0, bot: false };
  };
  const p = queue.then(run, run).catch(() => null);
  queue = p;
  return p;
}

/**
 * Notes for one question: { notes: [line, ...], ms, engine } or null (no browser, every engine
 * resting after a bot check, the day's limit reached, or nothing on the page that speaks to it).
 * `engine` is the person's choice; when it is resting the next one is used, and when it shows a bot
 * check during this lookup the next one is tried once. Never throws, never waits past deadlineMs.
 */
export async function lookupNotes(question, { engine = DEFAULT_ENGINE, budget = NOTES_BUDGET, deadlineMs = 4000 } = {}) {
  const q = String(question || '').trim();
  if (q.length < 4) return null;
  const t0 = Date.now();
  const key = q.toLowerCase();
  const kept = cache.get(key);
  if (kept && t0 - kept.at < CACHE_MS) return { notes: kept.notes, ms: 0, engine: kept.engine, cached: true };
  if (day.key !== today()) day = { key: today(), n: 0 };
  if (day.n >= DAY_LIMIT) return null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const use = engineFor(engine, resting);
      const left = deadlineMs - (Date.now() - t0);
      if (!use || left < 1000) return null;
      day.n++;
      const page = await Promise.race([searchPage(q, { engine: use, timeoutMs: Math.max(1000, left - 300) }), sleep(left).then(() => null)]);
      if (page && page.bot) continue;          // that engine now rests; the next one gets one try
      if (!page || !page.text) return null;
      const t = tally(use); t.ok++; t.lastOkAt = Date.now();
      const notes = notesFromPage(q, page.text, budget);
      if (!notes.length) return null;
      cache.set(key, { at: Date.now(), notes, engine: use });
      if (cache.size > 60) cache.delete(cache.keys().next().value);
      return { notes, ms: Date.now() - t0, engine: use };
    }
    return null;
  } catch { return null; }
}

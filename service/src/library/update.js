// Keeps the offline Wikipedia current (owner, 2026-11-23: updating it is part of what the app does
// on its own). Kiwix publishes a new English "mini" edition every few months. Every 6 hours the hub
// reads Kiwix's file list; when a newer edition is out it downloads it at night only (01:00 to
// 06:00 on the hub's clock), capped at 2 MB/s so his voice keeps room, picking up where it left off
// the night before. The file is checked against Kiwix's own SHA-256, then the reader switches to it
// and the old file is deleted. Setting wiki_update: 'auto' (the default) or 'off'.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { get } from '../db.js';
import { libraryDir, wikipediaFile, library } from './zim.js';

const LIST = 'https://download.kiwix.org/zim/wikipedia/';
const CHECK_MS = 6 * 60 * 60_000;
const RATE = 2 * 1024 * 1024;          // bytes a second
const NIGHT = [1, 6];                   // hours on the hub's clock when a download may run
const UA = 'PAN/1.0 (offline library update)';

/** The newest edition named in Kiwix's file list: 'wikipedia_en_all_mini_2026-09.zim' or null. */
export function newestEdition(listingHtml, edition = 'mini', lang = 'en') {
  const re = new RegExp(`wikipedia_${lang}_all_${edition}_(\\d{4}-\\d{2})\\.zim(?!\\.)`, 'g');
  let best = null;
  for (const m of String(listingHtml).matchAll(re)) if (!best || m[1] > best[1]) best = m;
  return best ? best[0] : null;
}

/** True when `candidate` is a newer edition than the installed file name (or nothing is installed). */
export function isNewer(candidate, installed) {
  const d = (s) => (String(s || '').match(/_(\d{4}-\d{2})\.zim$/) || [])[1] || '';
  return !!candidate && d(candidate) > d(installed);
}

const atNight = (now = new Date()) => now.getHours() >= NIGHT[0] && now.getHours() < NIGHT[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false;
let state = { status: 'idle', file: null, have: 0, size: 0, checkedAt: 0, error: null };
export const updateState = () => ({ ...state });

function setting() {
  try { return String(get("SELECT value FROM settings WHERE key = 'wiki_update'")?.value || 'auto').replace(/^"|"$/g, '').toLowerCase(); }
  catch { return 'auto'; }
}

async function sha256Of(path) {
  const h = createHash('sha256');
  await new Promise((res, rej) => fs.createReadStream(path).on('data', (b) => h.update(b)).on('end', res).on('error', rej));
  return h.digest('hex');
}

/** One check: find the newest edition and, at night, download (more of) it. */
export async function checkOnce({ force = false } = {}) {
  if (busy || setting() === 'off') return updateState();
  busy = true;
  try {
    const listing = await (await fetch(LIST, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })).text();
    const name = newestEdition(listing);
    const installed = await wikipediaFile();
    state = { ...state, checkedAt: Date.now(), error: null };
    if (!isNewer(name, installed && installed.split(/[\\/]/).pop())) { state.status = 'current'; return updateState(); }
    if (!force && !atNight()) { state = { ...state, status: 'waiting for the night', file: name }; return updateState(); }

    const dir = libraryDir();
    fs.mkdirSync(dir, { recursive: true });
    const part = join(dir, name + '.part');
    const sumText = await (await fetch(LIST + name + '.sha256', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })).text();
    const want = (sumText.match(/^[0-9a-f]{64}/) || [])[0];
    if (!want) throw new Error('no checksum published for ' + name);

    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const res = await fetch(LIST + name, { headers: { 'User-Agent': UA, ...(have ? { Range: `bytes=${have}-` } : {}) } });
    if (have && res.status !== 206) have = 0;                 // the mirror ignored the range: start over
    if (!res.ok) throw new Error('download HTTP ' + res.status);
    const size = have + Number(res.headers.get('content-length') || 0);
    state = { ...state, status: 'downloading', file: name, have, size };
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    const t0 = Date.now();
    let got = 0;
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        got += chunk.length;
        state.have = have + got;
        const ahead = got / RATE * 1000 - (Date.now() - t0);
        if (ahead > 0) await sleep(ahead);
        if (!force && !atNight()) break;                       // morning: stop, carry on tomorrow night
      }
    } finally { await new Promise((r) => out.end(r)); }
    if (fs.statSync(part).size < size) { state.status = 'paused until the night'; return updateState(); }

    state.status = 'checking';
    if ((await sha256Of(part)) !== want) { fs.rmSync(part, { force: true }); throw new Error('checksum did not match; deleted, will download again'); }
    const final = join(dir, name);
    fs.renameSync(part, final);
    // The reader picks the newest file; the old one is closed and deleted.
    if (installed && installed !== final) {
      try { await (await library(installed)).close(); } catch {}
      try { fs.rmSync(installed, { force: true }); } catch {}
    }
    state = { ...state, status: 'current', have: size };
    console.log(`[library] offline Wikipedia updated to ${name}`);
    return updateState();
  } catch (err) {
    state = { ...state, status: 'error', error: err.message };
    console.warn('[library] Wikipedia update:', err.message);
    return updateState();
  } finally { busy = false; }
}

let timer = null;
export function startUpdates() {
  if (timer) return;
  const tick = () => { checkOnce().catch(() => {}); };
  setTimeout(tick, 10 * 60_000).unref();                       // not at start-up: start-up is busy enough
  timer = setInterval(tick, CHECK_MS);
  timer.unref();
}

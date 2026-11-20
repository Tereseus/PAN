// Screen control on real web apps: two open source admin dashboards that people start real
// projects from, run locally and opened on the device, harder than practice.mjs's pages (pop-up
// lists, side panels, radio groups, a date picker, a data table with a filter).
//
//   shadcn-admin  https://github.com/satnaing/shadcn-admin  (MIT, tested at e16c87f)
//                 React, Radix UI, TanStack. The task form shows back what it was given.
//   TailAdmin     https://github.com/TailAdmin/free-react-tailwind-admin-dashboard  (MIT, 486ed74)
//                 React, Tailwind, FullCalendar, flatpickr.
//
// Set up once (a minute or two):
//   git clone --depth 1 https://github.com/satnaing/shadcn-admin <sites>/shadcn-admin
//   git clone --depth 1 https://github.com/TailAdmin/free-react-tailwind-admin-dashboard <sites>/tailadmin
//   cd <sites>/shadcn-admin && npx pnpm@9 install --frozen-lockfile
//   cd <sites>/tailadmin && npm ci
// Then:
//   node tests/screen-control/boilerplates.mjs --serial <adb serial> [--device <id>] [--hub URL]
//        [--sites F:/pan-test-sites] [--only tasks,filter,status,calendar]
// The runner starts each app's own dev server on this computer if it is not up, and reaches the
// device through `adb reverse`, so the device needs no network path to this computer.
// Needs app 0.5.46 or later (a tap by name on a web page is a real tap).
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split(/\s*--/).filter(Boolean).map((a) => { const [k, ...v] = a.split(/\s+/); return [k, v.join(' ') || true]; }));
const HUB = args.hub || 'http://127.0.0.1:7777';
const SERIAL = args.serial;
const SITES = args.sites || 'F:/pan-test-sites';
if (!SERIAL) { console.error('give --serial <adb serial> (adb devices)'); process.exit(2); }
const ONLY = args.only ? String(args.only).split(',') : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   ' + String(detail).slice(0, 500)}`); };
let DEVICE = args.device || '';

async function pan(action, params = {}) {
  try {
    const r = await fetch(HUB + '/api/v1/accessibility', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, device: DEVICE, ...params }), signal: AbortSignal.timeout(25000) });
    return await r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}
const read = () => pan('read_screen');
const els = (seen) => seen.elements || [];
/** The page's own text: what the browser shows below its tab strip and above its own buttons. */
const page = (seen) => { const t = seen.text || ''; const a = t.indexOf('New tab\n'); const b = t.lastIndexOf('Open the home page'); return t.slice(a >= 0 ? a + 8 : 0, b > 0 ? b : undefined); };
const brief = (seen) => JSON.stringify({ page: page(seen).slice(0, 400), error: seen.error });
async function readUntil(test, ms = 12000) {
  const end = Date.now() + ms;
  let seen = {};
  while (Date.now() < end) { seen = await read(); if (seen.ok && test(seen)) return { ok: true, seen }; await sleep(600); }
  return { ok: false, seen };
}
async function step(action, params, settle = 900) { const r = await pan(action, params); await sleep(settle); return r; }
async function openPage(url, marker) {
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url);
  const r = await readUntil((s) => marker.test(page(s)), 30000);
  check(`the app opened: ${url}`, r.ok, brief(r.seen));
  return r.ok;
}

// The two apps, each on its own port, started from its own folder with its own dev server.
const APPS = { shadcn: { dir: 'shadcn-admin', port: 5173 }, tailadmin: { dir: 'tailadmin', port: 5174 } };
const started = [];
async function up(app) {
  const { dir, port } = APPS[app];
  const url = `http://127.0.0.1:${port}/`;
  const answers = async () => { try { return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };
  if (!await answers()) {
    const p = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: path.join(SITES, dir), shell: true, windowsHide: true, stdio: 'ignore' });
    started.push(p);
    for (let i = 0; i < 40 && !await answers(); i++) await sleep(1000);
  }
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  return answers();
}

/** Tap, then read until `test` passes; tap once more if the first tap changed nothing (on web
 *  pages the first tap after typing, or after a pop-up closes, is often taken by the browser
 *  itself). A person does the same: look, and tap again. */
async function tapUntil(params, test, ms = 5000) {
  for (let i = 0; i < 2; i++) {
    await pan('tap', params);
    const r = await readUntil(test, ms);
    if (r.ok || i === 1) return r;
  }
}

const TESTS = {
  // A data table: type a task's id into the filter, only that task is left.
  async filter() {
    if (!await openPage('http://localhost:5173/tasks', /Here's a list of your tasks/)) return;
    const ids = (s) => [...new Set(page(s).match(/TASK-\d+/g) || [])];
    const first = ids((await readUntil((s) => ids(s).length > 3)).seen)[2];
    await step('type_text', { text: first, target: 'Filter by title or ID' });
    const r = await readUntil((s) => ids(s).length === 1 && ids(s)[0] === first);
    check(`typed ${first} into the filter, the table shows only that task`, r.ok, brief(r.seen));
  },
  // A pop-up filter with its own search box: Status, type "Done", Enter; every task left is Done.
  async status() {
    if (!await openPage('http://localhost:5173/tasks', /Here's a list of your tasks/)) return;
    let r = await tapUntil({ text: 'Status' }, (s) => /Backlog \d+[\s\S]*Canceled \d+/.test(page(s)));
    check('tapped "Status", its list of states opened', r.ok, brief(r.seen));
    if (!r.ok) return;
    await step('type_text', { text: 'Done' });
    await step('press_enter');
    await tapUntil({ text: "Here's a list of your tasks for this month!" }, (s) => !/Canceled \d+/.test(page(s)), 3000);
    const states = (s) => [...page(s).matchAll(/\n(Todo|In Progress|Backlog|Canceled|Done)\n(?:Low|Medium|High)\n/g)].map((m) => m[1]);
    r = await readUntil((s) => states(s).length > 0 && states(s).every((x) => x === 'Done') && /Status Done/.test(page(s)));
    check(`typed "Done" and pressed Enter, all ${states(r.seen).length} tasks in the table are Done`, r.ok, brief(r.seen));
  },
  // A side panel form: a text field, a pop-up list, two radio groups, Save. The app shows back
  // exactly what it was given, so the check is the app's own word.
  async tasks() {
    if (!await openPage('http://localhost:5173/tasks', /Here's a list of your tasks/)) return;
    let r = await tapUntil({ text: 'Create' }, (s) => /Create Task/.test(page(s)));
    check('tapped "Create", the new task panel slid in', r.ok, brief(r.seen));
    if (!r.ok) return;
    const title = `Fix the voice gap ${String(Date.now()).slice(-4)}`;
    await step('type_text', { text: title, target: 'Title' });
    r = await tapUntil({ text: 'Select dropdown' }, (s) => /In Progress[\s\S]*Done/.test(page(s)) && !/Create Task/.test(page(s)));
    check('tapped the Status field, its list opened', r.ok, brief(r.seen));
    await tapUntil({ text: 'In Progress' }, (s) => /Create Task/.test(page(s)));
    await step('tap', { text: 'Feature' });
    await step('tap', { text: 'High' });
    r = await readUntil((s) => els(s).filter((e) => e.checkable && e.checked).length === 2, 5000);
    check('PAN reads two radio buttons as picked (label and priority)', r.ok, brief(r.seen));
    r = await tapUntil({ text: 'Save changes' }, (s) => /You submitted/.test(page(s)), 8000);
    const said = page(r.seen);
    check('the app got exactly the title, "in progress", "feature" and "high"',
      r.ok && said.includes(`"title": "${title}"`) && said.includes('"status": "in progress"') && said.includes('"label": "feature"') && said.includes('"priority": "high"'), brief(r.seen));
  },
  // A calendar: add an event through a dialog with a colour choice and two date pickers.
  async calendar() {
    if (!await openPage('http://localhost:5174/calendar', /Add Event \+/)) return;
    let r = await tapUntil({ text: 'Add Event +' }, (s) => /Add \/ Edit Event/.test(page(s)));
    check('tapped "Add Event +", the event dialog opened', r.ok, brief(r.seen));
    if (!r.ok) return;
    const fields = els(r.seen).filter((e) => e.type === 'EditText' && e.y > 400).sort((a, b) => a.y - b.y);
    const radios = els(r.seen).filter((e) => e.checkable).sort((a, b) => a.x - b.x);
    const title = `Call the board maker ${String(Date.now()).slice(-4)}`;
    await step('tap', { x: fields[0].x, y: fields[0].y });
    await step('type_text', { text: title });
    await step('tap', { x: radios[1].x, y: radios[1].y });
    // Days 16 and 17 never show as a spare day of the month before or after, so each is the
    // only one of its number in the picker.
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const pickerOpen = (s) => /\nSun\nMon\n/.test(page(s));
    await tapUntil({ x: fields[1].x, y: fields[1].y }, pickerOpen);
    await tapUntil({ text: '16' }, (s) => page(s).includes(`${ym}-16`) && !pickerOpen(s));
    r = await readUntil((s) => page(s).includes(`${ym}-16`), 3000);
    check('picked the 16th in the start date picker', r.ok, brief(r.seen));
    // The end date's picker opens below the bottom of a landscape tablet screen and the field
    // takes no typing, so a person could not reach the 17th either. PAN must say so and leave
    // the dialog as it is; an earlier build clicked off screen and the whole dialog closed.
    await tapUntil({ x: fields[2].x, y: fields[2].y }, pickerOpen);
    const miss = await pan('tap', { text: '17' });
    await sleep(800);
    r = await readUntil((s) => /Add \/ Edit Event/.test(page(s)), 3000);
    const reachable = miss.ok && page(r.seen).includes(`${ym}-17`);
    check(reachable ? 'picked the 17th in the end date picker' : 'the 17th is off screen: PAN said so and the dialog stayed open',
      reachable || (!miss.ok && /off screen/.test(miss.error || '') && r.ok), JSON.stringify(miss) + ' ' + brief(r.seen));
    await tapUntil({ text: 'Event Title' }, (s) => !pickerOpen(s), 3000);
    r = await readUntil((s) => /Add \/ Edit Event/.test(page(s)), 3000);
    const picked = els(r.seen).filter((e) => e.checkable).sort((a, b) => a.x - b.x).findIndex((e) => e.checked);
    check('the second colour reads as picked', picked === 1, `picked ${picked}`);
    const month = now.toLocaleString('en-US', { month: 'long' });
    r = await tapUntil({ text: 'Add Event' }, (s) => page(s).includes(`${month} 16, ${now.getFullYear()} ${title}`), 8000);
    check(`the calendar shows "${title}" on ${month} 16`, r.ok, brief(r.seen));
  },
};

try {
  console.log(`0. The device, the hub (${HUB}) and the apps`);
  const on = (await (await fetch(HUB + '/api/v1/accessibility/devices', { signal: AbortSignal.timeout(8000) })).json()).devices || [];
  if (!DEVICE) DEVICE = adb('shell', 'getprop', 'ro.product.model').toLowerCase().replace(/\s+/g, '-');
  check(`screen control is on for ${DEVICE}`, on.some((d) => d.device === DEVICE), JSON.stringify(on));
  check('the device is unlocked', !/isKeyguardShowing=true/.test(adb('shell', 'dumpsys', 'window')), 'it is locked: unlock it and run this again');
  for (const app of Object.keys(APPS)) check(`${app} is running and reachable from the device`, await up(app), `could not start it from ${path.join(SITES, APPS[app].dir)}`);
  if (!results.every(Boolean)) throw new Error('not ready');
  let n = 0;
  for (const [name, run] of Object.entries(TESTS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    console.log(`${++n}. ${name}`);
    await run();
  }
  await pan('home');
} catch (e) {
  check('the run finished', false, e.message);
} finally {
  for (const p of Object.values(APPS)) { try { adb('reverse', '--remove', `tcp:${p.port}`); } catch {} }
  for (const p of started) { try { execFileSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
}
const good = results.filter(Boolean).length;
console.log(`\n${good} of ${results.length} checks passed`);
process.exit(good === results.length ? 0 : 1);

// Screen control on pages PAN did not write: public practice pages that exist for testing
// automation (the-internet.herokuapp.com and the TodoMVC demo). No sign in, no account, nothing
// bought or sent. Every check is made from what PAN reads off the screen, the way a real task
// would have to work, because these pages report nothing back to us.
//
//   node tests/screen-control/practice.mjs --serial <adb serial> [--device <id the hub knows>]
//        [--hub http://127.0.0.1:7777] [--only buttons,checkboxes,dropdown,wait,todo]
//
// Needs: the device on adb, unlocked, on the internet, PAN's screen control on, the app at 0.5.45
// or later (ticked state in a read, and the press_enter action).
// shop.html + run.mjs beside this file is the stricter test: there the page itself confirms each step.
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split(/\s*--/).filter(Boolean).map((a) => { const [k, ...v] = a.split(/\s+/); return [k, v.join(' ') || true]; }));
const HUB = args.hub || 'http://127.0.0.1:7777';
const SERIAL = args.serial;
if (!SERIAL) { console.error('give --serial <adb serial> (adb devices)'); process.exit(2); }
const ONLY = args.only ? String(args.only).split(',') : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   ' + String(detail).slice(0, 400)}`); };
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
const brief = (seen) => JSON.stringify({ text: (seen.text || '').slice(0, 250), elements: els(seen).slice(0, 25).map((e) => `${e.type}:${e.text}${e.checkable ? (e.checked ? '[x]' : '[ ]') : ''}`), error: seen.error });
/** Read the screen again and again until `test(read)` passes; hands back the last read either way. */
async function readUntil(test, ms = 12000) {
  const end = Date.now() + ms;
  let seen = {};
  while (Date.now() < end) { seen = await read(); if (seen.ok && test(seen)) return { ok: true, seen }; await sleep(700); }
  return { ok: false, seen };
}
async function openPage(url, marker) {
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url);
  const r = await readUntil((s) => marker.test(s.text || ''), 25000);
  check(`the page opened: ${url}`, r.ok, brief(r.seen));
  return r.ok;
}

const PAGES = {
  // Buttons that add and remove things on the page.
  async buttons() {
    if (!await openPage('https://the-internet.herokuapp.com/add_remove_elements/', /Add\/Remove Elements/)) return;
    const count = (s) => els(s).filter((e) => e.text === 'Delete').length;
    await pan('tap', { text: 'Add Element' });
    await pan('tap', { text: 'Add Element' });
    let r = await readUntil((s) => count(s) === 2);
    check('two taps on "Add Element" made two Delete buttons', r.ok, brief(r.seen));
    await pan('tap', { text: 'Delete' });
    r = await readUntil((s) => count(s) === 1);
    check('a tap on "Delete" took one away', r.ok, brief(r.seen));
  },
  // Tick boxes: read which are ticked, tick one, read it back.
  async checkboxes() {
    if (!await openPage('https://the-internet.herokuapp.com/checkboxes', /Checkboxes/)) return;
    const boxes = (s) => els(s).filter((e) => e.checkable);
    let r = await readUntil((s) => boxes(s).length === 2);
    check('PAN sees two boxes, the first not ticked and the second ticked', r.ok && boxes(r.seen)[0].checked === false && boxes(r.seen)[1].checked === true, brief(r.seen));
    if (!r.ok) return;
    const first = boxes(r.seen)[0];
    await pan('tap', { x: first.x, y: first.y });
    r = await readUntil((s) => boxes(s).length === 2 && boxes(s)[0].checked === true);
    check('after a tap the first box reads as ticked', r.ok, brief(r.seen));
  },
  // A drop-down list: open it, pick a line, read the choice back.
  async dropdown() {
    if (!await openPage('https://the-internet.herokuapp.com/dropdown', /Dropdown List/)) return;
    let r = await readUntil((s) => els(s).some((e) => /please select an option/i.test(e.text)));
    check('PAN sees the list, nothing picked yet', r.ok, brief(r.seen));
    if (!r.ok) return;
    const list = els(r.seen).find((e) => /please select an option/i.test(e.text));
    await pan('tap', { x: list.x, y: list.y });
    r = await readUntil((s) => /Option 2/.test(s.text || ''), 8000);
    check('the list opened and shows its lines', r.ok, brief(r.seen));
    await pan('tap', { text: 'Option 2' });
    r = await readUntil((s) => /Option 2/.test(s.text || '') && !/please select an option/i.test(s.text || ''), 8000);
    check('"Option 2" is the choice the page now shows', r.ok, brief(r.seen));
  },
  // Something that takes time: press Start and wait for the page to finish.
  async wait() {
    if (!await openPage('https://the-internet.herokuapp.com/dynamic_loading/1', /Dynamically Loaded Page Elements/)) return;
    await pan('tap', { text: 'Start' });
    const r = await readUntil((s) => /Hello World!/.test(s.text || ''), 20000);
    check('PAN waited for the page and read "Hello World!"', r.ok, brief(r.seen));
  },
  // A to-do list app: type a line, press Enter, tick it off.
  async todo() {
    if (!await openPage('https://demo.playwright.dev/todomvc/', /todos/i)) return;
    // The page keeps its list between visits (browser storage), so count what is left first.
    const left = (s) => { const m = /(\d+)\s+items?\s+left/.exec(s.text || ''); return m ? Number(m[1]) : 0; };
    const before = left((await readUntil((s) => /What needs to be done/i.test(s.text || ''))).seen);
    const line = `Buy coffee beans ${String(Date.now()).slice(-4)}`;
    let r = await pan('type_text', { text: line, target: 'What needs to be done?' });
    const typed = r.ok;
    r = await pan('press_enter');
    const entered = r.ok;
    r = await readUntil((s) => (s.text || '').includes(line) && left(s) === before + 1);
    check(`typed a to-do, pressed Enter, the list shows it (${before} left before, ${before + 1} after)`, typed && entered && r.ok, brief(r.seen));
    if (!r.ok) return;
    // The new line's own tick box: new lines go to the bottom, so take the last tick box.
    const boxes = els(r.seen).filter((e) => e.checkable);
    const box = boxes[boxes.length - 1];
    if (!box) return check('ticked the to-do off', false, brief(r.seen));
    await pan('tap', { x: box.x, y: box.y });
    r = await readUntil((s) => left(s) === before);
    check(`ticked it off, the list is back to ${before} left`, r.ok, brief(r.seen));
  },
};

try {
  console.log(`0. The device and the hub (${HUB})`);
  const on = (await (await fetch(HUB + '/api/v1/accessibility/devices', { signal: AbortSignal.timeout(8000) })).json()).devices || [];
  if (!DEVICE) DEVICE = adb('shell', 'getprop', 'ro.product.model').toLowerCase().replace(/\s+/g, '-');
  check(`screen control is on for ${DEVICE}`, on.some((d) => d.device === DEVICE), JSON.stringify(on));
  const locked = /isKeyguardShowing=true/.test(adb('shell', 'dumpsys', 'window'));
  check('the device is unlocked', !locked, 'it is locked: unlock it and run this again');
  if (!results.every(Boolean)) throw new Error('not ready');
  let n = 0;
  for (const [name, run] of Object.entries(PAGES)) {
    if (ONLY && !ONLY.includes(name)) continue;
    console.log(`${++n}. ${name}`);
    await run();
  }
  await pan('home');
} catch (e) {
  check('the run finished', false, e.message);
}
const good = results.filter(Boolean).length;
console.log(`\n${good} of ${results.length} checks passed`);
process.exit(good === results.length ? 0 : 1);

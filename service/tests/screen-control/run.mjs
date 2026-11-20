// Screen control, tested end to end on a real device: PAN's hub drives a small test shop in the
// device's browser through the app's accessibility service, up to the "check your order" screen,
// and stops there. Nothing is bought anywhere: the shop is shop.html beside this file, it sells
// nothing, and it reports every change to this runner, so each step is checked against what
// really happened on the page and not only against what PAN read off the screen.
//
//   node tests/screen-control/run.mjs --serial <adb serial> [--device <id the hub knows>]
//        [--hub http://127.0.0.1:7777] [--port 8765] [--place]
//
// Needs: the device on adb (USB or wireless), PAN's screen control on (Android Settings,
// Accessibility, PAN), the PAN app connected to the hub. The page reaches this runner through
// `adb reverse`, so the device needs no network path to this computer.
// --place also taps "Place the order" at the end (still the test shop): the step a real flow may
// only take after the person's yes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split(/\s*--/).filter(Boolean).map((a) => { const [k, ...v] = a.split(/\s+/); return [k, v.join(' ') || true]; }));
const HUB = args.hub || 'http://127.0.0.1:7777';
const PORT = Number(args.port || 8765);
const SERIAL = args.serial;
if (!SERIAL) { console.error('give --serial <adb serial> (adb devices)'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();

let state = null;          // the page's own account of itself, newest
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   ' + String(detail).slice(0, 300)}`); };

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/state') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { state = JSON.parse(body); } catch {} res.end('ok'); });
    return;
  }
  if (req.url.startsWith('/shop')) { res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('cache-control', 'no-store'); return res.end(fs.readFileSync(path.join(here, 'shop.html'))); }
  res.statusCode = 404; res.end('no');
});

async function pan(action, params = {}) {
  const r = await fetch(HUB + '/api/v1/accessibility', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, device: DEVICE, ...params }), signal: AbortSignal.timeout(25000) });
  return r.json();
}
/** Wait until the page reports something that passes `test`. */
async function until(test, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (state && test(state)) return true; await sleep(200); }
  return false;
}

let DEVICE = args.device || '';
try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`0. The device and the hub (${HUB})`);
  const on = (await (await fetch(HUB + '/api/v1/accessibility/devices', { signal: AbortSignal.timeout(8000) })).json()).devices || [];
  const model = adb('shell', 'getprop', 'ro.product.model').toLowerCase().replace(/\s+/g, '-');
  if (!DEVICE) DEVICE = model;
  check(`screen control is on for ${DEVICE}`, on.some((d) => d.device === DEVICE), JSON.stringify(on));
  if (!results[0]) throw new Error('screen control is not on for this device');
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `http://localhost:${PORT}/shop?run=${Date.now()}`);
  check('the test shop opened on the device', await until((s) => s.what === 'loaded', 15000), 'the page never reported in');
  await sleep(1500);

  console.log('1. Read the screen');
  let seen = await pan('read_screen');
  check('PAN reads the shop off the screen', seen.ok && /PAN test shop/.test(seen.text || '') && /Coffee beans/.test(seen.text || ''), JSON.stringify(seen).slice(0, 300));
  check('it sees the buttons it can press', (seen.elements || []).some((e) => /add coffee beans/i.test(e.text)), JSON.stringify((seen.elements || []).map((e) => e.text)));

  console.log('2. Put two things in the cart');
  let r = await pan('tap', { text: 'Add coffee beans' });
  check('coffee beans went into the cart', r.ok && await until((s) => s.cart.join() === 'coffee'), JSON.stringify([r, state]));
  r = await pan('tap', { text: 'Add blue mug' });
  check('the mug went in, and the page total is $21.50', r.ok && await until((s) => s.cart.join() === 'coffee,mug' && s.total === 21.5), JSON.stringify([r, state]));
  seen = await pan('read_screen');
  check('PAN reads the cart line as the page shows it', /Cart: 2 items \(Coffee beans, Blue mug\), total \$21\.50/.test(seen.text || ''), (seen.text || '').slice(0, 400));

  console.log('3. Type a delivery note');
  r = await pan('type_text', { text: 'Leave it at the door', target: 'Delivery note' });
  check('the note is in the field', r.ok && await until((s) => s.note === 'Leave it at the door'), JSON.stringify([r, state && state.note]));

  console.log('4. Go to checkout and stop at the check screen');
  r = await pan('tap', { text: 'Go to checkout' });
  check('the check screen is up', r.ok && await until((s) => s.view === 'confirm'), JSON.stringify([r, state && state.view]));
  seen = await pan('read_screen');
  const t = seen.text || '';
  const readBack = /Items: Coffee beans, Blue mug/.test(t) && /Total \$21\.50/.test(t) && /card ending 4242/.test(t);
  check('PAN can read back the items, the total and the card', readBack, t.slice(0, 500));
  if (readBack) console.log('     read back: "Coffee beans and a blue mug, 21 dollars 50, on the card ending 4242. Shall I place it?"');
  check('nothing was ordered', state && state.ordered === false && state.view === 'confirm', JSON.stringify(state));

  if (args.place) {
    console.log('5. The yes step (test shop only)');
    r = await pan('tap', { text: 'Place the order' });
    check('the order was placed after the yes', r.ok && await until((s) => s.ordered === true && s.view === 'done'), JSON.stringify([r, state]));
  }
  await pan('home');
} catch (e) {
  check('the run finished', false, e.message);
} finally {
  try { adb('reverse', '--remove', `tcp:${PORT}`); } catch {}
  server.close();
}
const good = results.filter(Boolean).length;
console.log(`\n${good} of ${results.length} checks passed`);
process.exit(good === results.length ? 0 : 1);

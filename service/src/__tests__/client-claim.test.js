// Which computer may use a PAN client name (client-claim.js). Runs standalone, no server needed.
// Usage: node service/src/__tests__/client-claim.test.js

import { decideClaim, LOCAL } from '../client-claim.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const PHONE = 'd1111111111aa'; // the owner's own computers on the link
const LAPTOP = 'd2222222222bb';
const SHARED = 'd3333333333cc'; // a limited one
const row = (trusted, link_device_id = null) => ({ trusted, link_device_id });
const full = { limited: false };
const limited = { limited: true };

console.log('client-claim');

test('a new name goes to whoever uses it first, and waits for approval', () => {
  eq(decideClaim(null, LAPTOP, full), { ok: true, bind: LAPTOP, pending: true, reapprove: false }, 'link');
  eq(decideClaim(null, LOCAL), { ok: true, bind: LOCAL, pending: true, reapprove: false }, 'local');
  eq(decideClaim(null, SHARED, limited), { ok: true, bind: SHARED, pending: true, reapprove: false }, 'limited');
});

test('the holder comes back: nothing to bind, approval as it was', () => {
  eq(decideClaim(row(1, LAPTOP), LAPTOP, full), { ok: true, bind: null, pending: false, reapprove: false }, 'approved');
  eq(decideClaim(row(0, LAPTOP), LAPTOP, full), { ok: true, bind: null, pending: true, reapprove: false }, 'pending');
  eq(decideClaim(row(1, SHARED), SHARED, limited), { ok: true, bind: null, pending: false, reapprove: false }, 'limited holder');
  eq(decideClaim(row(1, LOCAL), LOCAL), { ok: true, bind: null, pending: false, reapprove: false }, 'local holder');
});

test('a name another link computer holds is refused, to everyone', () => {
  eq(decideClaim(row(1, LAPTOP), SHARED, limited), { ok: false }, 'limited');
  eq(decideClaim(row(1, LAPTOP), PHONE, full), { ok: false }, 'full');
  eq(decideClaim(row(1, LAPTOP), LOCAL), { ok: false }, 'local');
  eq(decideClaim(row(0, LAPTOP), PHONE, full), { ok: false }, 'even while pending');
});

test("this computer's names move to the owner's link computer, never a limited one", () => {
  eq(decideClaim(row(1, LOCAL), LAPTOP, full), { ok: true, bind: LAPTOP, pending: false, reapprove: false }, 'full');
  eq(decideClaim(row(1, LOCAL), SHARED, limited), { ok: false }, 'limited');
});

test('a name nobody holds that PAN approved: the owner keeps it, a limited computer asks again', () => {
  eq(decideClaim(row(1), LAPTOP, full), { ok: true, bind: LAPTOP, pending: false, reapprove: false }, 'full');
  eq(decideClaim(row(1), LOCAL), { ok: true, bind: LOCAL, pending: false, reapprove: false }, 'local');
  eq(decideClaim(row(1), SHARED, limited), { ok: true, bind: SHARED, pending: true, reapprove: true }, 'limited');
  eq(decideClaim(row(0), SHARED, limited), { ok: true, bind: SHARED, pending: true, reapprove: false }, 'not approved anyway');
  eq(decideClaim(row(null), LAPTOP, full), { ok: true, bind: LAPTOP, pending: true, reapprove: false }, 'never approved');
});

test('the holder was removed from PAN Link: the name is free again', () => {
  eq(decideClaim(row(1, PHONE), LAPTOP, { limited: false, holderGone: true }), { ok: true, bind: LAPTOP, pending: false, reapprove: false }, 'full');
  eq(decideClaim(row(1, PHONE), SHARED, { limited: true, holderGone: true }), { ok: true, bind: SHARED, pending: true, reapprove: true }, 'limited');
});

test('limited is ignored for this computer itself', () => {
  eq(decideClaim(row(1), LOCAL, limited), { ok: true, bind: LOCAL, pending: false, reapprove: false }, 'local');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

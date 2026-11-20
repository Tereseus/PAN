import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenControl, deviceKey } from '../screen-control.js';

const clock = () => { let t = 1_000_000; const now = () => t; now.add = (ms) => { t += ms; }; return now; };

test('a device id is lower case with dashes', () => {
  assert.equal(deviceKey('Pixel 6 Pro'), 'pixel-6-pro');
  assert.equal(deviceKey('  '), '');
  assert.equal(deviceKey(null), '');
});

test('with no device on, a command is refused and nothing waits', () => {
  const sc = createScreenControl({ now: clock() });
  const r = sc.add({ id: 'a', action: 'read_screen' });
  assert.match(r.error, /No device has screen control on/);
  assert.equal(sc.waiting(), 0);
});

test('one device on: a command without a name goes to it, and only once', () => {
  const sc = createScreenControl({ now: clock() });
  assert.deepEqual(sc.poll('Pixel 6 Pro', 'Test phone'), []);
  assert.deepEqual(sc.add({ id: 'a', action: 'read_screen' }), { device: 'pixel-6-pro' });
  assert.deepEqual(sc.poll('pixel-6-pro'), [{ id: 'a', action: 'read_screen' }]);
  assert.deepEqual(sc.poll('pixel-6-pro'), []);
});

test('two devices on: a command must name one, and the other never gets it', () => {
  const sc = createScreenControl({ now: clock() });
  sc.poll('pixel-6-pro', 'Test phone');
  sc.poll('pixel-10-pro', 'His phone');
  const r = sc.add({ id: 'a', action: 'tap', text: 'Buy' });
  assert.match(r.error, /More than one device/);
  assert.match(r.error, /Test phone/);
  assert.equal(sc.waiting(), 0);
  assert.deepEqual(sc.add({ id: 'b', action: 'tap', text: 'OK' }, 'pixel-6-pro'), { device: 'pixel-6-pro' });
  assert.deepEqual(sc.poll('pixel-10-pro'), []);
  assert.deepEqual(sc.poll('pixel-6-pro'), [{ id: 'b', action: 'tap', text: 'OK' }]);
});

test('a device can be named by the name it shows', () => {
  const sc = createScreenControl({ now: clock() });
  sc.poll('pixel-6-pro', 'Test Phone');
  sc.poll('opd2403', 'Pad');
  assert.deepEqual(sc.add({ id: 'a', action: 'home' }, 'pad'), { device: 'opd2403' });
  assert.deepEqual(sc.add({ id: 'b', action: 'home' }, 'Test Phone'), { device: 'pixel-6-pro' });
});

test('a named device that is not on is refused', () => {
  const sc = createScreenControl({ now: clock() });
  sc.poll('pixel-6-pro', 'Test phone');
  const r = sc.add({ id: 'a', action: 'home' }, 'pixel-10-pro');
  assert.match(r.error, /does not have screen control on/);
  assert.equal(sc.waiting(), 0);
});

test('a device that does not name itself gets nothing', () => {
  const sc = createScreenControl({ now: clock() });
  sc.poll('pixel-6-pro');
  sc.add({ id: 'a', action: 'read_screen' });
  assert.deepEqual(sc.poll(''), []);
  assert.deepEqual(sc.poll(undefined), []);
  assert.equal(sc.waiting(), 1);
});

test('a device that stopped asking is no longer on', () => {
  const now = clock();
  const sc = createScreenControl({ now });
  sc.poll('pixel-6-pro');
  now.add(11_000);
  assert.deepEqual(sc.devices(), []);
  assert.match(sc.add({ id: 'a', action: 'home' }).error, /No device/);
});

test('a command nobody picked up is dropped, not run late', () => {
  const now = clock();
  const sc = createScreenControl({ now });
  sc.poll('pixel-6-pro');
  sc.add({ id: 'a', action: 'tap', text: 'Pay' });
  now.add(16_000);
  assert.deepEqual(sc.poll('pixel-6-pro'), []);
});

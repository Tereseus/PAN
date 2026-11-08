// safe-files tests — runs standalone, no server needed
// Usage: node service/src/__tests__/safe-files.test.js

import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { imageExt, safeTag, insideDir } from '../safe-files.js';

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
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const dir = join(tmpdir(), 'pan-screenshots');
const win = process.platform === 'win32';

console.log('safe-files');

test('image types keep their extension', () => {
  eq(imageExt('image/png'), 'png', 'png');
  eq(imageExt('image/jpeg'), 'jpeg', 'jpeg');
  eq(imageExt('IMAGE/WEBP'), 'webp', 'upper case');
  eq(imageExt('image/heic'), 'heic', 'phone photos');
});

test('anything else becomes png, so it cannot steer the path', () => {
  eq(imageExt('image/x\\..\\..\\pan-clip-test'), 'png', 'backslashes');
  eq(imageExt('image/../../x'), 'png', 'dots');
  eq(imageExt('image/bat'), 'png', 'other type');
  eq(imageExt(undefined), 'png', 'missing');
  eq(imageExt({}), 'png', 'not a string');
});

test('a short tag passes, anything with path characters is replaced', () => {
  eq(safeTag('phone', 'x'), 'phone', 'plain');
  eq(safeTag('desktop-1', 'x'), 'desktop-1', 'dash');
  eq(safeTag('x/../../evil', 'phone'), 'phone', 'slashes');
  eq(safeTag('..\\evil', 'phone'), 'phone', 'backslashes');
  eq(safeTag('', 'phone'), 'phone', 'empty');
  eq(safeTag(undefined, 'phone'), 'phone', 'missing');
  eq(safeTag('a'.repeat(33), 'phone'), 'phone', 'too long');
});

test('a file in the folder is allowed', () => {
  const f = join(dir, 'screenshot_phone_1.png');
  eq(insideDir(dir, f), resolve(f), 'path');
});

test('"..\\" or "../" out of the folder is refused', () => {
  eq(insideDir(dir, join(dir, '..', 'secret.txt')), null, 'one level up');
  eq(insideDir(dir, dir + (win ? '\\..\\..\\x' : '/../../x')), null, 'two levels up');
  eq(insideDir(dir, win ? 'C:\\pan-screenshots\\..\\Windows\\win.ini' : '/pan-screenshots/../etc/passwd'), null, 'name check trick');
});

test('the folder itself, a look-alike folder, and odd input are refused', () => {
  eq(insideDir(dir, dir), null, 'the folder');
  eq(insideDir(dir, dir + '-other' + (win ? '\\x.png' : '/x.png')), null, 'look-alike');
  eq(insideDir(dir, ''), null, 'empty');
  eq(insideDir(dir, ['a', 'b']), null, 'array (?path=a&path=b)');
  eq(insideDir(dir, undefined), null, 'missing');
});

if (win) {
  test('Windows: letter case does not matter', () => {
    const f = join(dir, 'screenshot_phone_1.png').toUpperCase();
    eq(insideDir(dir, f) !== null, true, 'upper case path');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

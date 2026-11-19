// node --test installer/windows/launch-plan.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchPlan, restartDelayMs } = require('./launch-plan.cjs');

const config = { installDir: 'C:\\Users\\sam\\AppData\\Local\\PAN', version: '2026.11.19-abc1234' };

test('everything runs from the version folder, data stays beside it', () => {
  const p = launchPlan(config, 'SAMS-PC', {});
  assert.equal(p.dataDir, 'C:\\Users\\sam\\AppData\\Local\\PAN\\data');
  assert.equal(p.pan.exe, 'C:\\Users\\sam\\AppData\\Local\\PAN\\app\\2026.11.19-abc1234\\node\\node.exe');
  assert.deepEqual(p.pan.args, ['C:\\Users\\sam\\AppData\\Local\\PAN\\app\\2026.11.19-abc1234\\service\\pan.js', 'start']);
  assert.equal(p.link.exe, 'C:\\Users\\sam\\AppData\\Local\\PAN\\app\\2026.11.19-abc1234\\pan-link\\pan-link.exe');
  assert.equal(p.pan.env.PAN_DATA_DIR, p.dataDir);
  assert.equal(p.pairUrl, 'http://127.0.0.1:7777/pair/');
});

test('an installed PAN never opens its ports to the network', () => {
  const p = launchPlan(config, 'SAMS-PC', { PAN_HOST: '0.0.0.0', PAN_DEV: '1', PATH: 'x' });
  assert.equal('PAN_HOST' in p.pan.env, false);
  assert.equal('PAN_DEV' in p.pan.env, false);
  assert.equal(p.pan.env.PATH, 'x');
  assert.ok(p.link.args.includes('http://127.0.0.1:7777'));
});

test('pan-link points at the same PAN port and the admin port PAN is told about', () => {
  const p = launchPlan({ ...config, port: 27877, carrierPort: 27860, craftPortBase: 27800, linkPort: 42720, linkAdmin: '127.0.0.1:27792' }, 'BOX', {});
  assert.equal(p.pan.env.PAN_PORT, '27877');
  assert.equal(p.pan.env.PAN_CARRIER_INTERNAL_PORT, '27860');
  assert.equal(p.pan.env.PAN_CRAFT_PORT_BASE, '27800');
  assert.equal(p.pan.env.PAN_LINK_ADMIN, 'http://127.0.0.1:27792');
  const a = p.link.args;
  assert.equal(a[a.indexOf('--port') + 1], '42720');
  assert.equal(a[a.indexOf('--backend') + 1], 'http://127.0.0.1:27877');
  assert.equal(a[a.indexOf('--admin') + 1], '127.0.0.1:27792');
  assert.equal(a[a.indexOf('--name') + 1], 'BOX');
  assert.equal(p.healthUrl, 'http://127.0.0.1:27877/health');
});

test('a broken install.json is refused, not guessed at', () => {
  assert.throws(() => launchPlan({}, 'X', {}), /installDir/);
  assert.throws(() => launchPlan({ installDir: 'C:\\P' }, 'X', {}), /version/);
  assert.throws(() => launchPlan({ ...config, port: 'abc' }, 'X', {}), /not a port/);
  assert.throws(() => launchPlan({ ...config, linkPort: 70000 }, 'X', {}), /not a port/);
});

test('PAN stops on a clean exit, pan-link always comes back', () => {
  const p = launchPlan(config, 'X', {});
  assert.equal(p.pan.restartOnCleanExit, false);
  assert.equal(p.link.restartOnCleanExit, true);
});

test('a program that keeps dying is started again more slowly', () => {
  assert.equal(restartDelayMs(0), 5000);
  assert.equal(restartDelayMs(1), 10000);
  assert.equal(restartDelayMs(3), 40000);
  assert.equal(restartDelayMs(50), 300000);
});

test('Ollama is started only when voice was installed, and only if nothing answers already', () => {
  assert.equal(launchPlan(config, 'X', {}).ollama, null);
  const o = launchPlan({ ...config, ollama: 'C:\\Users\\sam\\AppData\\Local\\Programs\\Ollama\\ollama.exe' }, 'X', { PATH: 'x' }).ollama;
  assert.equal(o.exe, 'C:\\Users\\sam\\AppData\\Local\\Programs\\Ollama\\ollama.exe');
  assert.deepEqual(o.args, ['serve']);
  assert.equal(o.onlyIfDown, 'http://127.0.0.1:11434/api/version');
  assert.equal(o.restartOnCleanExit, true);
  assert.equal(o.log, 'C:\\Users\\sam\\AppData\\Local\\PAN\\data\\ollama.log');
});

test('test mode comes from install.json only', () => {
  assert.equal(launchPlan({ ...config, dev: true }, 'X', {}).pan.env.PAN_DEV, '1');
  assert.equal('PAN_DEV' in launchPlan({ ...config, dev: 'yes' }, 'X', {}).pan.env, false);
  assert.equal('PAN_HOST' in launchPlan({ ...config, dev: true }, 'X', { PAN_HOST: '0.0.0.0' }).pan.env, false);
});

test('on Linux the same plan uses the Linux layout of the bundle', () => {
  const linux = { installDir: '/home/sam/.local/share/pan', version: '2026.11.19-abc', ollama: '/usr/local/bin/ollama' };
  const p = launchPlan(linux, 'box', { PAN_HOST: '0.0.0.0' }, 'linux');
  assert.equal(p.pan.exe, '/home/sam/.local/share/pan/app/2026.11.19-abc/node/bin/node');
  assert.deepEqual(p.pan.args, ['/home/sam/.local/share/pan/app/2026.11.19-abc/service/pan.js', 'start']);
  assert.equal(p.link.exe, '/home/sam/.local/share/pan/app/2026.11.19-abc/pan-link/pan-link');
  assert.equal(p.pan.env.PAN_DATA_DIR, '/home/sam/.local/share/pan/data');
  assert.equal(p.ollama.cwd, '/usr/local/bin');
  assert.equal('PAN_HOST' in p.pan.env, false);
});

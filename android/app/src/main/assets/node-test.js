// PAN Node.js execution test
const results = {};

// Test 1: Basic execution
results.basic = { ok: true, version: process.version, platform: process.platform, arch: process.arch };

// Test 2: Filesystem (use HOME dir which is app's filesDir)
try {
  const fs = require('fs');
  const homeDir = process.env.HOME || '/data/data/dev.pan.app/files';
  const tmpFile = homeDir + '/pan-node-test-' + Date.now() + '.txt';
  fs.writeFileSync(tmpFile, 'PAN node test ' + Date.now());
  const read = fs.readFileSync(tmpFile, 'utf8');
  fs.unlinkSync(tmpFile);
  results.filesystem = { ok: true, wrote: read.length + ' bytes', dir: homeDir };
} catch (e) {
  results.filesystem = { ok: false, error: e.message };
}

// Test 3: child_process.spawn
try {
  const { execSync } = require('child_process');
  const out = execSync('echo hello_from_spawn', { encoding: 'utf8', timeout: 5000 });
  results.child_process = { ok: true, output: out.trim() };
} catch (e) {
  results.child_process = { ok: false, error: e.message };
}

// Test 4: Network (HTTP module loads)
try {
  require('https');
  results.network = { ok: true, https: 'available' };
} catch (e) {
  results.network = { ok: false, error: e.message };
}

console.log(JSON.stringify(results, null, 2));

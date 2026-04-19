#!/usr/bin/env node
// Builds the PAN installer binaries using @yao-pkg/pkg.
// Output: service/bin/pan-installer-win.exe  (Windows x64)
//         service/bin/pan-installer-linux     (Linux x64)
//
// Run: node scripts/build-installer.js
// Or:  npm run build:installer

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const BIN_DIR   = join(ROOT, 'bin');
const INSTALLER = join(ROOT, 'installer', 'pan-installer.cjs');

if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });

// Install @yao-pkg/pkg if not present
try {
  execSync('npx --yes @yao-pkg/pkg --version', { stdio: 'pipe', windowsHide: true });
} catch {
  console.log('Installing @yao-pkg/pkg...');
  execSync('npm install --save-dev @yao-pkg/pkg', { cwd: ROOT, stdio: 'inherit', windowsHide: true });
}

const targets = [
  { target: 'node22-win-x64',   out: join(BIN_DIR, 'pan-installer-win.exe') },
  { target: 'node22-linux-x64', out: join(BIN_DIR, 'pan-installer-linux')   },
];

for (const { target, out } of targets) {
  console.log(`Building ${target}...`);
  execSync(
    `npx @yao-pkg/pkg "${INSTALLER}" --target ${target} --output "${out}" --compress GZip`,
    { cwd: ROOT, stdio: 'inherit', windowsHide: true }
  );
  console.log(`  → ${out}`);
}

console.log('\nDone. Installers ready in service/bin/');

// Build wrapper — preserves old immutable bundles so in-flight SPAs don't break.
// Copies old _app/immutable/ to temp, builds, copies old files back alongside new ones.
// Stale bundles (>24h old) are cleaned up.

import { execSync } from 'child_process';
import { readdirSync, statSync, unlinkSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';

const PUBLIC_V2 = join(import.meta.dirname, '..', 'public', 'v2');
const IMMUTABLE_DIR = join(PUBLIC_V2, '_app', 'immutable');
const BACKUP_DIR = join(import.meta.dirname, '.immutable-backup');
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// ── Step 1: backup old immutable files ──
function copyRecursive(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else copyFileSync(s, d);
  }
}

function rmRecursive(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) rmRecursive(full);
    else unlinkSync(full);
  }
  try { readdirSync(dir).length === 0 && unlinkSync(dir); } catch {}
}

console.log('[build] Backing up old bundles...');
rmRecursive(BACKUP_DIR);
copyRecursive(IMMUTABLE_DIR, BACKUP_DIR);

// ── Step 2: run vite build ──
console.log('[build] Running vite build...');
execSync('npx vite build', { stdio: 'inherit', cwd: import.meta.dirname, windowsHide: true });

// ── Step 3: restore old bundles (don't overwrite new ones) ──
function restoreOld(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) { restoreOld(s, d); continue; }
    // Only restore if the file doesn't exist in new build
    if (!existsSync(d)) {
      copyFileSync(s, d);
    }
  }
}

console.log('[build] Restoring old bundles alongside new...');
restoreOld(BACKUP_DIR, IMMUTABLE_DIR);

// ── Step 4: clean stale files (>24h old) ──
const now = Date.now();
let cleaned = 0;
function cleanStale(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { cleanStale(full); continue; }
    try {
      const st = statSync(full);
      if (now - st.mtimeMs > MAX_AGE_MS) {
        unlinkSync(full);
        cleaned++;
      }
    } catch {}
  }
}
cleanStale(IMMUTABLE_DIR);
if (cleaned) console.log(`[build] Cleaned ${cleaned} stale bundles (>24h).`);

// ── Step 5: clean up backup ──
rmRecursive(BACKUP_DIR);

console.log('[build] Done — old + new bundles coexist.');

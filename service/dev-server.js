#!/usr/bin/env node
// PAN Dev Server — runs on a separate port with its own database
// Automatically kills any existing process on the port before starting.
//
// Usage: node dev-server.js [port]

import { join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync, mkdirSync, copyFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] || 7781;

// Auto-kill any process already on this port
try {
  const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const pids = new Set();
  for (const line of result.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    const pid = parseInt(parts[parts.length - 1]);
    if (pid && pid !== process.pid) pids.add(pid);
  }
  for (const pid of pids) {
    console.log(`[PAN Dev] Killing existing process on port ${port} (PID: ${pid})`);
    try { execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000, windowsHide: true }); } catch {}
  }
  if (pids.size > 0) {
    // Wait for port to release
    await new Promise(r => setTimeout(r, 2000));
  }
} catch {
  // No process on port — good
}

// Dev config — separate port, database, and dev mode (skips steward/reaper/device registration)
process.env.PAN_PORT = String(port);
process.env.PAN_DEV = '1';
process.env.PAN_DATA_DIR = join(
  process.env.LOCALAPPDATA || 'C:\\Users\\tzuri\\AppData\\Local',
  'PAN', 'data-dev'
);

// Clone prod DB to dev on first start (gives dev a real copy of all data)
const prodDataDir = join(
  process.env.LOCALAPPDATA || 'C:\\Users\\tzuri\\AppData\\Local',
  'PAN', 'data'
);
const devDataDir = process.env.PAN_DATA_DIR;
const devDbPath = join(devDataDir, 'pan.db');
const prodDbPath = join(prodDataDir, 'pan.db');
const prodKeyPath = join(prodDataDir, 'pan.key');
const devKeyPath = join(devDataDir, 'pan.key');

if (!existsSync(devDataDir)) {
  mkdirSync(devDataDir, { recursive: true });
}

if (!existsSync(devDbPath) && existsSync(prodDbPath)) {
  console.log(`[PAN Dev] Cloning prod database to dev...`);
  copyFileSync(prodDbPath, devDbPath);
  // Copy encryption key so dev can read the cloned DB
  if (existsSync(prodKeyPath)) {
    copyFileSync(prodKeyPath, devKeyPath);
  }
  console.log(`[PAN Dev] Clone complete: ${devDbPath}`);
} else if (existsSync(devDbPath)) {
  console.log(`[PAN Dev] Using existing dev database`);
}
// Copy encryption key if missing (dev needs same key to open cloned DB)
if (!existsSync(devKeyPath) && existsSync(prodKeyPath)) {
  copyFileSync(prodKeyPath, devKeyPath);
}

console.log(`[PAN Dev] Starting dev server on port ${port}`);
console.log('[PAN Dev] Database:', process.env.PAN_DATA_DIR);
console.log(`[PAN Dev] Dashboard: http://localhost:${port}/v2/terminal`);
console.log('');

// Import and start
const { start } = await import('./src/server.js');
await start();

#!/usr/bin/env node
// PAN Dev Server — runs on a separate port with its own database
// Automatically kills any existing process on the port before starting.
//
// Usage: node dev-server.js [port]

import { join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] || 7781;

// Auto-kill any process already on this port
try {
  const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
  const pids = new Set();
  for (const line of result.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    const pid = parseInt(parts[parts.length - 1]);
    if (pid && pid !== process.pid) pids.add(pid);
  }
  for (const pid of pids) {
    console.log(`[PAN Dev] Killing existing process on port ${port} (PID: ${pid})`);
    try { execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000 }); } catch {}
  }
  if (pids.size > 0) {
    // Wait for port to release
    await new Promise(r => setTimeout(r, 2000));
  }
} catch {
  // No process on port — good
}

// Dev config — separate port and database
process.env.PAN_PORT = String(port);
process.env.PAN_DATA_DIR = join(
  process.env.LOCALAPPDATA || 'C:\\Users\\tzuri\\AppData\\Local',
  'PAN', 'data-dev'
);

console.log(`[PAN Dev] Starting dev server on port ${port}`);
console.log('[PAN Dev] Database:', process.env.PAN_DATA_DIR);
console.log(`[PAN Dev] Dashboard: http://localhost:${port}/v2/terminal`);
console.log('');

// Import and start
const { start } = await import('./src/server.js');
await start();

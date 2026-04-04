#!/usr/bin/env node
// PAN Test Runner — one command to run all tests in an Electron window
//
// Usage: node run-tests.cjs [port]
//
// What it does:
// 1. Kills any existing process on the port
// 2. Starts the dev server (isolated DB)
// 3. Waits for it to respond to /dashboard/api/stats
// 4. Opens the Electron dev dashboard window
// 5. Electron window auto-selects Tests panel and runs all tests

const { execSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = parseInt(process.argv[2]) || 7781;
const SERVICE_DIR = __dirname;

// --- Step 1: Kill any existing process on the port ---
function killPort(port) {
  try {
    const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      encoding: 'utf8', timeout: 5000
    });
    const pids = new Set();
    for (const line of result.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1]);
      if (pid && pid !== process.pid) pids.add(pid);
    }
    for (const pid of pids) {
      console.log(`[run-tests] Killing existing process on port ${port} (PID: ${pid})`);
      try { execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000 }); } catch {}
    }
    if (pids.size > 0) return true;
  } catch {
    // No process on port — good
  }
  return false;
}

// --- Step 2: Start the dev server ---
function startDevServer() {
  return new Promise((resolve, reject) => {
    console.log(`[run-tests] Starting dev server on port ${PORT}...`);
    const child = spawn('node', ['dev-server.js', String(PORT)], {
      cwd: SERVICE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let started = false;

    child.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`  [dev] ${line}`);
      // Once we see "Dashboard:" line, the server is initializing
      if (!started && line.includes('Dashboard:')) {
        started = true;
      }
    });

    child.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.error(`  [dev] ${line}`);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start dev server: ${err.message}`));
    });

    child.on('exit', (code) => {
      if (!started) {
        reject(new Error(`Dev server exited with code ${code} before starting`));
      }
    });

    // Resolve with the child process after a brief delay to let it start binding
    setTimeout(() => resolve(child), 1000);
  });
}

// --- Step 3: Wait for server to respond ---
function waitForServer(maxWaitMs = 30000) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (Date.now() - startTime > maxWaitMs) {
        reject(new Error(`Dev server did not respond within ${maxWaitMs / 1000}s`));
        return;
      }

      const req = http.get(`http://127.0.0.1:${PORT}/api/v1/stats`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log(`[run-tests] Dev server is ready (${Date.now() - startTime}ms)`);
            resolve();
          } else {
            setTimeout(check, 500);
          }
        });
      });

      req.on('error', () => {
        // Server not ready yet
        setTimeout(check, 500);
      });

      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(check, 500);
      });
    }

    check();
  });
}

// --- Step 4: Open Electron dev dashboard ---
function openElectron() {
  console.log(`[run-tests] Opening Electron dev dashboard...`);
  const electronScript = path.join(SERVICE_DIR, 'open-dev-dashboard.cjs');
  // Resolve electron binary directly — require('electron') returns the exe path
  const electronBin = require('electron');
  const child = spawn(electronBin, [electronScript, String(PORT)], {
    cwd: SERVICE_DIR,
    stdio: 'inherit',
    env: { ...process.env }
  });

  child.on('error', (err) => {
    console.error(`[run-tests] Failed to open Electron: ${err.message}`);
  });

  return child;
}

// --- Main ---
async function main() {
  console.log(`\n[run-tests] PAN Test Runner — port ${PORT}\n`);

  // Step 1: Kill existing
  const killed = killPort(PORT);
  if (killed) {
    console.log('[run-tests] Waiting for port to release...');
    await new Promise(r => setTimeout(r, 2000));
  }

  // Step 2: Start dev server
  let devServer;
  try {
    devServer = await startDevServer();
  } catch (err) {
    console.error(`[run-tests] ${err.message}`);
    process.exit(1);
  }

  // Step 3: Wait for server
  try {
    await waitForServer();
  } catch (err) {
    console.error(`[run-tests] ${err.message}`);
    devServer.kill();
    process.exit(1);
  }

  // Step 4: Open Electron
  const electronProc = openElectron();

  // Handle cleanup on exit
  function cleanup() {
    console.log('\n[run-tests] Shutting down...');
    try { electronProc.kill(); } catch {}
    try { devServer.kill(); } catch {}
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // When Electron closes, kill the dev server too
  electronProc.on('exit', () => {
    console.log('[run-tests] Electron closed, stopping dev server...');
    try { devServer.kill(); } catch {}
    process.exit(0);
  });

  // When dev server dies unexpectedly, clean up
  devServer.on('exit', (code) => {
    if (code !== null) {
      console.log(`[run-tests] Dev server exited (code ${code})`);
      try { electronProc.kill(); } catch {}
      process.exit(code || 1);
    }
  });
}

main().catch(err => {
  console.error(`[run-tests] Fatal: ${err.message}`);
  process.exit(1);
});

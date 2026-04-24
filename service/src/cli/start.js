import { start } from '../server.js';
import { killProcessOnPort } from '../platform.js';

export default async function cmdStart(args) {
  const detached = args.includes('-d') || args.includes('--detach');
  const noCarrier = args.includes('--no-carrier');
  const isDev = process.env.PAN_DEV === '1';

  if (detached) {
    // Spawn self as background process
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, [process.argv[1], 'start'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    console.log(`[PAN] Started in background (PID: ${child.pid})`);
    return;
  }

  // Kill any ghost server holding the port — but NOT a healthy Carrier.
  // If a healthy Carrier is already running, we're a duplicate spawn and should exit.
  const port = parseInt(process.env.PAN_PORT) || 7777;

  // Check for restart marker — Carrier writes this before process.exit(1) so we
  // know we're a respawn, not a duplicate. Without this, a dying Carrier can
  // still respond to health checks during its shutdown grace period, causing
  // start.js to exit(0) and pan-loop.bat to stop looping.
  const { existsSync, unlinkSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  const markerDir = join(process.env.LOCALAPPDATA || '', 'PAN', isDev ? 'data-dev' : 'data');
  const markerPath = join(markerDir, '.restart-pending');

  if (existsSync(markerPath)) {
    console.log('[PAN] Restart marker found — this is a respawn, not a duplicate');
    try { unlinkSync(markerPath); } catch {}
    // Wait for the old process to fully die before we take over
    for (let i = 0; i < 15; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          console.log(`[PAN] Old server still alive on port ${port}, waiting... (${i + 1}/15)`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      } catch {
        break; // Port is free — proceed
      }
    }
    // Force-kill whatever's left
    const killed = await killProcessOnPort(port);
    if (killed.size > 0) {
      console.log(`[PAN] Killed stale process(es) on port ${port}: ${[...killed].join(', ')}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  } else {
    // Normal start — check if a healthy Carrier is already running
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body.carrier) {
          console.log(`[PAN] Healthy Carrier already running on port ${port} — exiting to avoid conflict`);
          process.exit(0);
        }
      }
    } catch {
      // No healthy server — safe to kill whatever's there
    }
    const killed = await killProcessOnPort(port);
    if (killed.size > 0) {
      console.log(`[PAN] Killed stale process(es) on port ${port}: ${[...killed].join(', ')}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Boot via Super-Carrier in prod mode (zero-downtime Carrier restarts)
  // Dev mode and --no-carrier flag skip Super-Carrier and boot server.js directly
  if (!isDev && !noCarrier) {
    console.log('[PAN] Booting via Super-Carrier (zero-downtime carrier restarts)...');
    // Super-Carrier is a self-booting module — it spawns Carrier underneath
    await import('../super-carrier.js');
  } else {
    if (isDev) console.log('[PAN] Dev mode — booting server directly (no Carrier)');
    if (noCarrier) console.log('[PAN] --no-carrier flag — booting server directly');
    await start();
  }
}

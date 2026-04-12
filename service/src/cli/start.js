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

  // Boot via Carrier in prod mode (hot-swap, Lifeboat, rollback safety)
  // Dev mode and --no-carrier flag skip Carrier and boot server.js directly
  if (!isDev && !noCarrier) {
    console.log('[PAN] Booting via Carrier (hot-swap enabled)...');
    // Carrier is a self-booting module — just import it and it runs
    await import('../carrier.js');
  } else {
    if (isDev) console.log('[PAN] Dev mode — booting server directly (no Carrier)');
    if (noCarrier) console.log('[PAN] --no-carrier flag — booting server directly');
    await start();
  }
}

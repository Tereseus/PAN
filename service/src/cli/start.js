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

  // Kill any ghost server holding port 7777 before starting
  const port = parseInt(process.env.PAN_PORT) || 7777;
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

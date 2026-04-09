import { start } from '../server.js';
import { killProcessOnPort } from '../platform.js';

export default async function cmdStart(args) {
  const detached = args.includes('-d') || args.includes('--detach');

  if (detached) {
    // Spawn self as background process
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, [process.argv[1], 'start'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    console.log(`[PAN] Started in background (PID: ${child.pid})`);
    return;
  }

  // Kill any ghost server holding port 7777 before starting
  const killed = await killProcessOnPort(7777);
  if (killed.size > 0) {
    console.log(`[PAN] Killed stale process(es) on port 7777: ${[...killed].join(', ')}`);
    await new Promise(r => setTimeout(r, 1000));
  }
  await start();
}

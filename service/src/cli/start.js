import { start } from '../server.js';

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

  await start();
}

import { start } from '../server.js';
import { execSync } from 'child_process';

async function killStaleServer(port) {
  try {
    // Find and kill any process holding the port (Windows)
    const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
    const lines = result.trim().split('\n');
    const pids = new Set();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1]);
      if (pid && pid !== process.pid) pids.add(pid);
    }
    for (const pid of pids) {
      console.log(`[PAN] Killing stale process on port ${port} (PID: ${pid})`);
      try { execSync(`taskkill /PID ${pid} /F`, { timeout: 5000 }); } catch {}
    }
    if (pids.size > 0) {
      // Brief pause for port to release
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch {
    // No process on port — good
  }
}

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
  await killStaleServer(7777);
  await start();
}

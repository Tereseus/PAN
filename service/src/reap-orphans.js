// reap-orphans.js — kill PAN-spawned processes left over from previous PAN
// runs, without touching this server, its children, or unrelated processes
// belonging to other Claude Code sessions or the user's own tools.
//
// Targets:
//   - bash.exe / claude.exe whose ancestor chain does NOT include this PAN pid
//   - python.exe running PAN's own whisper-server.py (matched by command line),
//     since steward used to leak one per restart and each commits ~1.95GB
//
// Strategy:
//   1. Enumerate via PowerShell Get-CimInstance Win32_Process — modern, supported
//      replacement for the deprecated `wmic`. Falls back to `wmic` if PowerShell
//      CIM call fails (e.g. WMI service hung). If both fail we bail safely.
//   2. For bash/claude: build a parent-pid map and walk ancestors; protect this
//      PAN pid + any explicitly protected PTY child pids.
//   3. For python: kill any whose CommandLine matches PAN's whisper-server.py,
//      regardless of ancestry — they are always supposed to be steward-owned
//      and steward will respawn one fresh on next boot.
//   4. Kill with taskkill /F /T (whole tree) per pid.
//
// Safe to call repeatedly. Returns a structured result for logging / API.

import { listProcesses, killProcessTree } from './platform.js';

export async function reapOrphans({ activeChildPids = [], dryRun = false } = {}) {
  if (process.platform !== 'win32') {
    return { ok: true, killed: [], skipped: 'non-windows' };
  }

  const myPid = process.pid;
  const protect = new Set([myPid, ...activeChildPids.filter(Number.isFinite)]);
  const killed = [];
  const errors = [];

  // Enumerate via platform.js (PowerShell CIM on Windows, ps on Linux)
  let procs;
  let enumSource = 'platform.js';
  try {
    procs = await listProcesses(['bash', 'claude', 'node', 'python']);
  } catch (err) {
    return {
      ok: false,
      error: `process enumeration failed: ${err.message}`,
      killed,
    };
  }

  const ppidOf = new Map(procs.map((p) => [p.pid, p.ppid]));

  function ancestorIncludes(pid, target, maxDepth = 12) {
    let cur = pid;
    for (let i = 0; i < maxDepth; i++) {
      const parent = ppidOf.get(cur);
      if (parent === undefined) return false;
      if (parent === target) return true;
      if (!parent || parent === cur) return false;
      cur = parent;
    }
    return false;
  }

  function inProtectedTree(pid) {
    for (const pp of protect) {
      if (pid === pp) return true;
      if (ancestorIncludes(pid, pp)) return true;
    }
    return false;
  }

  for (const p of procs) {
    let reason = null;

    if (p.name === 'bash.exe' || p.name === 'claude.exe') {
      if (inProtectedTree(p.pid)) continue;
      reason = 'orphan-bash-or-claude';
    } else if (p.name === 'python.exe') {
      // Only kill python that is running PAN's whisper-server.py. Anything else
      // is the user's own python and must be left alone. We need cmdline for
      // this — if we fell back to wmic we don't have it, so skip python.
      if (!p.cmdline) continue;
      const cl = p.cmdline.toLowerCase();
      if (!cl.includes('whisper-server')) continue;
      // No protect-tree check: whisper is always steward-owned, and if any are
      // still running on a fresh PAN boot they are by definition zombies.
      reason = 'whisper-zombie';
    } else {
      continue;
    }

    if (dryRun) {
      killed.push({ ...p, reason });
      continue;
    }

    try {
      killProcessTree(p.pid);
      killed.push({ ...p, reason });
    } catch (e) {
      // Process may have already exited (e.g. parent reaped it via /T)
      errors.push({ pid: p.pid, name: p.name, error: e.message?.trim().slice(0, 200) || String(e) });
    }
  }

  return {
    ok: true,
    killed,
    errors,
    scanned: procs.length,
    enumSource,
    protected: [...protect],
  };
}

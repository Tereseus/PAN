// PAN Platform Abstraction — cross-platform utilities for Windows + Linux
//
// Every platform-specific operation goes through this module. When PAN runs
// on Linux, these functions return the correct paths, commands, and behaviors
// without any caller needing to know the OS.
//
// Usage:
//   import { platform, getDataDir, getShell, killProcess, ... } from './platform.js';

import { execSync, execFile, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir, platform as osPlatform } from 'os';
import { promisify } from 'util';

const pexec = promisify(execFile);

// ── Platform detection ──────────────────────────────────────────────────

export const platform = osPlatform();            // 'win32' | 'linux' | 'darwin'
export const isWindows = platform === 'win32';
export const isLinux   = platform === 'linux';
export const isMac     = platform === 'darwin';

// ── Directory paths ─────────────────────────────────────────────────────

/** PAN's persistent data directory (DB, logs, keys). Outside cloud sync.
 *  Dev server sets PAN_DATA_DIR for full isolation from prod. */
export function getDataDir() {
  if (process.env.PAN_DATA_DIR) return process.env.PAN_DATA_DIR;
  if (isWindows) {
    const base = process.env.LOCALAPPDATA
      || join(process.env.USERPROFILE || homedir(), 'AppData', 'Local');
    return join(base, 'PAN', 'data');
  }
  // Linux/Mac: XDG_DATA_HOME or ~/.local/share/pan
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'pan', 'data');
}

/** PAN's config directory (settings, preferences). */
export function getConfigDir() {
  if (isWindows) {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'PAN');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'pan');
}

/** Temp directory for ephemeral files. */
export function getTempDir() {
  return tmpdir();
}

/** User's home directory. */
export function getHomeDir() {
  return homedir();
}

/** User's desktop directory. */
export function getDesktopDir() {
  if (isWindows) {
    return join(process.env.USERPROFILE || homedir(), 'Desktop');
  }
  // XDG user dirs — fallback to ~/Desktop
  return join(homedir(), 'Desktop');
}

/** Recordings directory for screen recorder. */
export function getRecordingsDir() {
  return join(getDataDir(), 'recordings');
}

/** Terminal log directory. */
export function getTerminalLogDir() {
  return join(getDataDir(), 'terminal-logs');
}

/** Claude CLI command path. */
export function getClaudeCmd() {
  if (isWindows) {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'claude.cmd');
  }
  // Linux/Mac: claude should be in PATH via npm global install
  return 'claude';
}

// ── Shell detection ─────────────────────────────────────────────────────

/** Returns { shell, args } for spawning a PTY terminal. */
export function getShell() {
  if (isWindows) {
    // Prefer Git Bash for consistency, fall back to PowerShell
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (existsSync(gitBash)) {
      return { shell: gitBash, args: ['--login', '-i'] };
    }
    return { shell: 'powershell.exe', args: [] };
  }
  // Linux/Mac: use user's default shell or /bin/bash
  const userShell = process.env.SHELL || '/bin/bash';
  return { shell: userShell, args: ['--login', '-i'] };
}

// ── Process management ──────────────────────────────────────────────────

/**
 * Kill a process by PID. Tries graceful first, then force.
 * On Windows: taskkill /F /T (kills tree).
 * On Linux: SIGTERM, then SIGKILL after timeout.
 */
export function killProcess(pid, { tree = false, force = true } = {}) {
  if (!pid || pid === process.pid) return false;
  try {
    if (isWindows) {
      const args = ['/PID', String(pid)];
      if (tree) args.push('/T');
      if (force) args.push('/F');
      execSync(`taskkill ${args.join(' ')}`, { timeout: 5000, stdio: 'ignore', windowsHide: true });
    } else {
      // Linux: kill the process group if tree kill requested
      if (tree) {
        try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {}
      }
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process tree by PID. Ensures all children die.
 */
export function killProcessTree(pid) {
  return killProcess(pid, { tree: true, force: true });
}

/**
 * Find and kill any process listening on a given port.
 * Returns the set of killed PIDs.
 */
export async function killProcessOnPort(port) {
  const killed = new Set();
  try {
    let pids;
    if (isWindows) {
      const result = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf8', timeout: 5000 }
      );
      pids = new Set();
      for (const line of result.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1]);
        if (pid && pid !== process.pid) pids.add(pid);
      }
    } else {
      // Linux: lsof or ss
      let result;
      try {
        result = execSync(`lsof -ti :${port}`, { encoding: 'utf8', timeout: 5000 });
      } catch {
        // lsof not available, try ss
        result = execSync(
          `ss -tlnp | grep :${port} | grep -oP 'pid=\\K[0-9]+'`,
          { encoding: 'utf8', timeout: 5000 }
        );
      }
      pids = new Set();
      for (const line of result.trim().split('\n')) {
        const pid = parseInt(line.trim());
        if (pid && pid !== process.pid) pids.add(pid);
      }
    }

    for (const pid of pids) {
      killProcess(pid, { force: true });
      killed.add(pid);
    }
  } catch {
    // No process on port — good
  }
  return killed;
}

/**
 * Enumerate processes matching given names.
 * Returns array of { pid, ppid, name, cmdline }.
 */
export async function listProcesses(nameFilter = []) {
  const procs = [];
  try {
    if (isWindows) {
      const filterExpr = nameFilter.length
        ? nameFilter.map(n => `Name='${n}.exe'`).join(' or ')
        : "Name like '%'";
      const script =
        `Get-CimInstance Win32_Process -Filter "${filterExpr}" -ErrorAction Stop | ` +
        "ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, ($_.CommandLine -replace '\\|','/') }";
      const r = await pexec(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 12000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
      );
      for (const raw of r.stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const parts = line.split('|');
        if (parts.length < 3) continue;
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const name = (parts[2] || '').toLowerCase();
        const cmdline = parts.slice(3).join('|') || '';
        if (!pid || Number.isNaN(pid)) continue;
        procs.push({ pid, ppid, name, cmdline });
      }
    } else {
      // Linux: ps with full command line
      const r = await pexec(
        'ps', ['ax', '-o', 'pid,ppid,comm,args', '--no-headers'],
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }
      );
      for (const raw of r.stdout.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) continue;
        const pid = parseInt(match[1], 10);
        const ppid = parseInt(match[2], 10);
        const name = match[3].toLowerCase();
        const cmdline = match[4] || '';
        if (nameFilter.length && !nameFilter.some(n => name.includes(n))) continue;
        procs.push({ pid, ppid, name, cmdline });
      }
    }
  } catch (err) {
    console.warn('[platform] listProcesses failed:', err.message);
  }
  return procs;
}

/**
 * Kill processes matching a command line pattern.
 * Used for cleaning up whisper-server, orphan claude processes, etc.
 */
export async function killByCommandLine(pattern, processNames = []) {
  const procs = await listProcesses(processNames);
  const killed = [];
  for (const p of procs) {
    if (p.cmdline.includes(pattern) && p.pid !== process.pid) {
      killProcess(p.pid, { force: true });
      killed.push(p);
    }
  }
  return killed;
}

// ── Mode detection ──────────────────────────────────────────────────────

/**
 * Detect whether PAN is running in interactive user mode or headless service mode.
 * Windows: checks USERPROFILE for system profile, machine accounts, service accounts.
 * Linux: checks if running under systemd as a service (no TTY, INVOCATION_ID set).
 */
export function detectMode() {
  if (isWindows) {
    const username = process.env.USERNAME || '';
    const userProfile = process.env.USERPROFILE || '';
    const isSystemProfile = /\\config\\systemprofile/i.test(userProfile);
    const isMachineAccount = username.endsWith('$');
    const isServiceAccount = /^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$/i.test(username);
    return (isSystemProfile || isMachineAccount || isServiceAccount) ? 'service' : 'user';
  }
  // Linux: if stdin is not a TTY and INVOCATION_ID is set → systemd service
  if (process.env.INVOCATION_ID && !process.stdin.isTTY) return 'service';
  // Also check if parent is PID 1 (init/systemd)
  try {
    const ppid = execSync('ps -o ppid= -p ' + process.pid, { encoding: 'utf8' }).trim();
    if (ppid === '1') return 'service';
  } catch {}
  return 'user';
}

// ── Path normalization ──────────────────────────────────────────────────

/** Normalize path separators to forward slashes (for Map keys, comparisons). */
export function normalizePath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

/** Convert a path to OS-native separators. */
export function toNativePath(p) {
  if (!p) return '';
  if (isWindows) return p.replace(/\//g, '\\');
  return p.replace(/\\/g, '/');
}

// ── Ensure directories exist ────────────────────────────────────────────

/** Create the data directory tree on first run. */
export function ensureDataDirs() {
  const dirs = [getDataDir(), getTerminalLogDir(), getRecordingsDir()];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// PAN WezTerm CLI Integration
// Wraps WezTerm CLI commands for terminal management.
// Falls back gracefully if WezTerm is not installed.

import { execFile, spawn as cpSpawn } from 'child_process';
import { access, constants } from 'fs/promises';

const WEZTERM_PATH = 'C:\\Program Files\\WezTerm\\wezterm.exe';

let _available = null; // cached availability check

/**
 * Check if WezTerm CLI is available on this machine.
 * Result is cached after first call.
 */
async function isAvailable() {
  if (_available !== null) return _available;
  try {
    await access(WEZTERM_PATH, constants.X_OK);
    // Also verify the CLI responds
    await run(['cli', 'list', '--format', 'json']);
    _available = true;
  } catch {
    _available = false;
  }
  console.log(`[PAN WezTerm] Available: ${_available}`);
  return _available;
}

/**
 * Run a wezterm command and return stdout.
 * Rejects on non-zero exit or timeout.
 */
function run(args, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = execFile(WEZTERM_PATH, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`wezterm ${args.join(' ')} failed: ${err.message} ${stderr || ''}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * List all panes. Returns array of pane objects.
 * Each pane has: pane_id, tab_id, window_id, title, cwd, etc.
 */
async function listPanes() {
  const raw = await run(['cli', 'list', '--format', 'json']);
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Spawn a new pane/tab in WezTerm.
 * @param {object} opts
 * @param {string} opts.cwd - Working directory for the new pane
 * @param {string} [opts.command] - Optional command to run (e.g., 'claude --continue')
 * @param {boolean} [opts.newWindow] - If true, spawn in a new window instead of a tab
 * @returns {object} { paneId: number }
 */
async function spawnPane({ cwd, command, newWindow = false } = {}) {
  const args = ['cli', 'spawn'];

  if (newWindow) args.push('--new-window');
  if (cwd) args.push('--cwd', cwd);

  // If a command is specified, append it after '--'
  if (command) {
    args.push('--');
    // Split command into parts for execFile
    const parts = command.split(/\s+/);
    args.push(...parts);
  }

  const stdout = await run(args);
  // wezterm cli spawn returns the new pane ID
  const paneId = parseInt(stdout.trim(), 10);
  return { paneId: isNaN(paneId) ? null : paneId };
}

/**
 * Send text (keystrokes) to a specific pane.
 * @param {number} paneId
 * @param {string} text - Text to send (include \n for Enter)
 */
async function sendText(paneId, text) {
  await run(['cli', 'send-text', '--pane-id', String(paneId), '--no-paste', text]);
}

/**
 * Get the text content of a pane (screen buffer).
 * @param {number} paneId
 * @returns {string} The pane's visible text
 */
async function getText(paneId) {
  return await run(['cli', 'get-text', '--pane-id', String(paneId)]);
}

/**
 * Activate (focus) a specific pane.
 * @param {number} paneId
 */
async function activatePane(paneId) {
  await run(['cli', 'activate-pane', '--pane-id', String(paneId)]);
}

/**
 * Split a pane horizontally or vertically.
 * @param {number} paneId - The pane to split
 * @param {object} opts
 * @param {string} [opts.direction='right'] - 'right', 'bottom', 'left', 'top'
 * @param {string} [opts.cwd] - Working directory for the new pane
 * @returns {object} { paneId: number }
 */
async function splitPane(paneId, { direction = 'right', cwd } = {}) {
  const args = ['cli', 'split-pane', '--pane-id', String(paneId)];

  if (direction === 'bottom' || direction === 'top') {
    args.push('--bottom');
  } else {
    args.push('--right');
  }

  if (cwd) args.push('--cwd', cwd);

  const stdout = await run(args);
  const newPaneId = parseInt(stdout.trim(), 10);
  return { paneId: isNaN(newPaneId) ? null : newPaneId };
}

/**
 * Find a pane by its cwd or title.
 * @param {object} filter
 * @param {string} [filter.cwd] - Match panes whose cwd contains this string
 * @param {string} [filter.title] - Match panes whose title contains this string
 * @returns {object|null} The first matching pane, or null
 */
async function findPane({ cwd, title } = {}) {
  const panes = await listPanes();
  return panes.find(p => {
    if (cwd && p.cwd && p.cwd.toLowerCase().includes(cwd.toLowerCase())) return true;
    if (title && p.title && p.title.toLowerCase().includes(title.toLowerCase())) return true;
    return false;
  }) || null;
}

/**
 * Open a terminal for a project — the main entry point PAN uses.
 * If a pane already exists for that cwd, activate it instead of opening a new one.
 * @param {string} projectPath - The project directory
 * @param {string} [name] - Display name (for logging)
 * @param {object} [opts]
 * @param {string} [opts.command] - Command to run after opening
 * @returns {object} { paneId, reused, method }
 */
async function openTerminal(projectPath, name, opts = {}) {
  // Normalize path for comparison
  const normPath = projectPath.replace(/\//g, '\\');

  // Check if a pane already exists for this path
  const existing = await findPane({ cwd: normPath });
  if (existing) {
    await activatePane(existing.pane_id);
    if (opts.command) {
      await sendText(existing.pane_id, opts.command + '\n');
    }
    console.log(`[PAN WezTerm] Reused existing pane ${existing.pane_id} for ${name || normPath}`);
    return { paneId: existing.pane_id, reused: true, method: 'wezterm' };
  }

  // Spawn a new pane
  const result = await spawnPane({ cwd: normPath, command: opts.command });
  console.log(`[PAN WezTerm] Spawned new pane ${result.paneId} for ${name || normPath}`);
  return { paneId: result.paneId, reused: false, method: 'wezterm' };
}

export {
  isAvailable,
  listPanes,
  spawnPane,
  sendText,
  getText,
  activatePane,
  splitPane,
  findPane,
  openTerminal,
  WEZTERM_PATH
};

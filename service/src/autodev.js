// PAN AutoDev — Automated development scheduler
//
// Picks development tasks from the database, spawns headless Claude sessions
// to implement them, logs the results. Runs on a schedule (default: disabled).
//
// Safety: ALL jobs off by default. Must be explicitly enabled per-project.
// Changes are NOT auto-committed — user must review and approve.

import { all, get, run, logEvent } from './db.js';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

let devInterval = null;
let running = false;

// AutoDev config — stored in settings table
function getConfig() {
  const row = get("SELECT value FROM settings WHERE key = 'autodev_config'");
  if (row) {
    try { return JSON.parse(row.value); } catch {}
  }
  return {
    enabled: false,
    schedule_hours: 24,
    run_at_hour: 2,           // 2 AM
    max_files_per_run: 5,
    auto_commit: false,       // require manual review
    allowed_actions: ['new_files', 'edit'],  // no 'delete' by default
    enabled_projects: [],     // project IDs that AutoDev can touch
  };
}

function saveConfig(config) {
  const existing = get("SELECT id FROM settings WHERE key = 'autodev_config'");
  if (existing) {
    run("UPDATE settings SET value = :val WHERE key = 'autodev_config'", { ':val': JSON.stringify(config) });
  } else {
    insert("INSERT INTO settings (key, value) VALUES ('autodev_config', :val)", { ':val': JSON.stringify(config) });
  }
}

// Find the next task to work on
function pickTask(config) {
  if (config.enabled_projects.length === 0) return null;

  const placeholders = config.enabled_projects.map(() => '?').join(',');
  const task = get(
    `SELECT t.*, p.path as project_path, p.name as project_name
     FROM project_tasks t
     JOIN projects p ON p.id = t.project_id
     WHERE t.status = 'todo'
       AND t.project_id IN (${placeholders})
     ORDER BY t.priority DESC, t.created_at ASC
     LIMIT 1`,
    ...config.enabled_projects
  );
  return task;
}

// Run a headless Claude session to implement a task
async function executeTask(task, config) {
  return new Promise((resolve) => {
    const projectPath = task.project_path.replace(/\//g, '\\');

    if (!existsSync(projectPath)) {
      resolve({ ok: false, error: `Project path not found: ${projectPath}` });
      return;
    }

    // Build the prompt
    const prompt = `You are PAN AutoDev — an automated development system.

TASK: ${task.title}
${task.description ? `DESCRIPTION: ${task.description}` : ''}
PROJECT: ${task.project_name} (${projectPath})

RULES:
- Implement this task with minimal changes
- Do NOT modify more than ${config.max_files_per_run} files
- ${config.allowed_actions.includes('delete') ? 'You may delete files if needed' : 'Do NOT delete any files'}
- Do NOT commit changes — the user will review and commit
- Do NOT push to remote
- Do NOT modify .env, credentials, or secret files
- Keep changes focused on this single task
- When done, output a brief summary of what you changed

Implement the task now.`;

    console.log(`[PAN AutoDev] Starting: "${task.title}" in ${task.project_name}`);

    const startTime = Date.now();
    let output = '';
    let errorOutput = '';

    // Spawn headless Claude with auto mode (safe auto-permissions, blocks destructive actions)
    const proc = spawn('claude', ['-p', '--model', 'haiku', '--permission-mode', 'auto', prompt], {
      cwd: projectPath,
      shell: true,
      timeout: 300000, // 5 minute max
      env: { ...process.env }
    });

    proc.stdout?.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[PAN AutoDev] Finished in ${elapsed}s (exit ${code}): "${task.title}"`);

      resolve({
        ok: code === 0,
        output: output.slice(-2000), // last 2KB of output
        error: errorOutput.slice(-500),
        elapsed,
        exit_code: code
      });
    });

    proc.on('error', (err) => {
      resolve({ ok: false, error: err.message, elapsed: 0 });
    });
  });
}

async function autodev() {
  if (running) {
    console.log('[PAN AutoDev] Already running, skipping');
    return;
  }

  const config = getConfig();
  if (!config.enabled) return;

  // Check if it's the right hour (if configured)
  const hour = new Date().getHours();
  if (config.run_at_hour != null && hour !== config.run_at_hour) return;

  running = true;
  console.log('[PAN AutoDev] Starting development cycle...');

  try {
    const task = pickTask(config);
    if (!task) {
      console.log('[PAN AutoDev] No eligible tasks found');
      running = false;
      return;
    }

    // Mark task as in_progress
    run("UPDATE project_tasks SET status = 'in_progress' WHERE id = :id", { ':id': task.id });

    // Execute
    const result = await executeTask(task, config);

    // Log the result
    logEvent('autodev-' + Date.now(), 'AutoDevCycle', {
      task_id: task.id,
      task_title: task.title,
      project: task.project_name,
      project_path: task.project_path,
      success: result.ok,
      output: result.output,
      error: result.error,
      elapsed_seconds: result.elapsed,
      timestamp: Date.now()
    });

    if (result.ok) {
      // Mark task as done (but changes not committed yet)
      run("UPDATE project_tasks SET status = 'done', completed_at = datetime('now','localtime') WHERE id = :id",
        { ':id': task.id });
      console.log(`[PAN AutoDev] Task completed: "${task.title}"`);
    } else {
      // Revert to todo
      run("UPDATE project_tasks SET status = 'todo' WHERE id = :id", { ':id': task.id });
      console.log(`[PAN AutoDev] Task failed: "${task.title}" — ${result.error}`);
    }
  } catch (err) {
    console.error('[PAN AutoDev] Error:', err.message);
  }

  running = false;
}

function startAutoDev(intervalMs = 60 * 60 * 1000) {
  const run = async () => {
    try {
      await autodev();
      const { reportServiceRun } = await import('./steward.js');
      reportServiceRun('autodev');
    } catch (err) {
      try { const { reportServiceRun } = await import('./steward.js'); reportServiceRun('autodev', err.message); } catch {}
      console.error('[PAN AutoDev]', err.message);
    }
  };
  setTimeout(() => {
    run();
    devInterval = setInterval(run, intervalMs);
  }, 30000);
  console.log('[PAN AutoDev] Scheduled (checks hourly, runs at configured hour)');
}

function stopAutoDev() {
  if (devInterval) clearInterval(devInterval);
  devInterval = null;
}

function getAutoDevLog(limit = 20) {
  return all(
    `SELECT * FROM events WHERE event_type = 'AutoDevCycle' ORDER BY created_at DESC LIMIT :limit`,
    { ':limit': limit }
  );
}

export { autodev, startAutoDev, stopAutoDev, getConfig, saveConfig, getAutoDevLog };

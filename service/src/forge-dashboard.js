// PAN Forge: Dashboard Bug Auto-Fixer — task #508, Layer 5 of self-heal stack.
//
// Closes the loop. Reads bugs filed by L3 (dashboard-render-health) and L4
// (dashboard-vision-verifier), picks one, spawns a headless `claude -p`
// session with a constrained prompt that demands a regression test, runs it,
// records the attempt, and (if successful) lets the dashboard naturally
// re-validate via L1/L2/L4 on the next cycle.
//
// Off by default. Enabled via the `forge_dashboard_autofix` setting key:
//   { enabled: bool, max_attempts_per_bug: 3, attempt_window_hours: 24,
//     model: 'haiku', dry_run: bool }
//
// Each attempt is logged as an event (type='ForgeDashboardAttempt'). The
// kill-switch counts attempts in the trailing attempt_window_hours and refuses
// to spawn a new Claude session if max_attempts_per_bug has been reached.
//
// Safe path: dry_run=true makes the loop file a comment on the bug rather
// than actually launching Claude. Use this to validate the picker without
// burning tokens.

import { all, get, run, logEvent } from './db.js';
import { spawn } from 'child_process';

const PROJECT_ID = 791;
const PROJECT_PATH = '%USERPROFILE%\\Desktop\\PAN';
const SOURCE_TAG = 'forge-dashboard';
const CHECK_INTERVAL_MS = 5 * 60_000; // every 5 min — generous; bugs aren't created that often
const FIRST_RUN_DELAY_MS = 2 * 60_000;

let _interval = null;
let _running = false;

function getConfig() {
  const row = get("SELECT value FROM settings WHERE key = 'forge_dashboard_autofix'");
  if (row) { try { return JSON.parse(row.value); } catch {} }
  return {
    enabled: false,
    max_attempts_per_bug: 3,
    attempt_window_hours: 24,
    model: 'haiku',
    dry_run: false,
  };
}

function countAttempts(bugId, windowHours) {
  try {
    const row = get(`SELECT COUNT(*) as n FROM events
      WHERE event_type = 'ForgeDashboardAttempt'
        AND created_at >= datetime('now','localtime', :w)
        AND json_extract(data, '$.bug_id') = :bug`,
      { ':w': `-${windowHours} hours`, ':bug': bugId });
    return row?.n || 0;
  } catch (e) {
    return 0;
  }
}

function pickDashboardBug(config) {
  // Pick the oldest open dashboard-render bug whose attempt count is under
  // the limit. Skips bugs that are already in_progress (someone else is on it).
  let candidates;
  try {
    candidates = all(`SELECT id, title, description FROM project_tasks
      WHERE project_id = :pid AND status = 'todo' AND type = 'bug'
        AND (title LIKE :pat1 OR title LIKE :pat2)
      ORDER BY created_at ASC LIMIT 10`,
      { ':pid': PROJECT_ID, ':pat1': "%Widget '%' rendering %", ':pat2': 'Vision: %' });
  } catch (e) {
    return null;
  }
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  for (const c of candidates) {
    const attempts = countAttempts(c.id, config.attempt_window_hours);
    if (attempts < config.max_attempts_per_bug) {
      return { ...c, attempts };
    }
  }
  return null;
}

function buildPrompt(bug) {
  return `You are PAN Forge — automated bug-fix system. Today you're fixing a dashboard-render bug detected by the self-heal stack.

BUG #${bug.id}: ${bug.title}

DESCRIPTION:
${bug.description || '(no description)'}

CONSTRAINTS:
- Focus narrowly on the widget named in the title. Do NOT refactor unrelated code.
- The dashboard lives at service/dashboard/src/routes/terminal/+page.svelte. Most fixes will live there.
- Every dashboard widget has a contract: data-widget="<name>", data-widget-state (loading|empty|ok|error|stale), data-widget-rendered-at. If the bug says the state is wrong, fix the derivation logic, not the data attribute itself.
- Do NOT remove any data-widget* attributes — they are the contract every monitoring layer depends on.
- After fixing, run \`cd service/dashboard && npm run build\` and confirm it succeeds. If the build fails, fix the syntax error before exiting.
- Do NOT commit. Do NOT push.

REGRESSION TEST REQUIREMENT:
- Add a regression-test comment block above the section you changed describing exactly what condition would cause the widget to go empty again, and what code path now prevents it.

When done, output a short summary of what you changed and why. The bug will be re-validated on the next dashboard-vision-verifier cycle (~2 min).`;
}

function recordAttempt(bug, result) {
  try {
    logEvent('forge-dashboard-' + Date.now(), 'ForgeDashboardAttempt', {
      bug_id: bug.id,
      bug_title: bug.title,
      success: !!result.ok,
      exit_code: result.exit_code ?? null,
      elapsed_seconds: result.elapsed ?? 0,
      output_tail: (result.output || '').slice(-1500),
      error_tail: (result.error || '').slice(-500),
      attempt_count_before: bug.attempts,
      source: SOURCE_TAG,
      timestamp: Date.now(),
    });
  } catch (e) {
    console.warn('[ForgeDashboard] logEvent failed:', e.message);
  }
}

async function runClaudeOnBug(bug, config) {
  return new Promise((resolve) => {
    const prompt = buildPrompt(bug);
    const args = ['-p', '--model', config.model || 'haiku', '--permission-mode', 'auto', prompt];
    console.log(`[ForgeDashboard] spawning claude on bug #${bug.id} (attempt ${bug.attempts + 1}/${config.max_attempts_per_bug})`);
    const startedAt = Date.now();
    let output = '';
    let errorOutput = '';
    const proc = spawn('claude', args, {
      cwd: PROJECT_PATH,
      shell: true,
      windowsHide: true,
      timeout: 5 * 60_000,
      env: { ...process.env },
    });
    proc.stdout?.on('data', d => { output += d.toString(); });
    proc.stderr?.on('data', d => { errorOutput += d.toString(); });
    proc.on('close', code => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[ForgeDashboard] bug #${bug.id} finished in ${elapsed}s, exit=${code}`);
      resolve({ ok: code === 0, output, error: errorOutput, elapsed, exit_code: code });
    });
    proc.on('error', err => resolve({ ok: false, error: err.message, elapsed: 0 }));
  });
}

async function tickOnce() {
  if (_running) return;
  _running = true;
  try {
    const config = getConfig();
    if (!config.enabled) return;

    const bug = pickDashboardBug(config);
    if (!bug) return; // nothing eligible

    if (config.dry_run) {
      console.log(`[ForgeDashboard] dry_run=true — would fix bug #${bug.id}: ${bug.title}`);
      recordAttempt(bug, { ok: false, error: '(dry-run)', elapsed: 0 });
      return;
    }

    // Mark in_progress so the bug doesn't get picked again by anything else this cycle.
    try {
      run("UPDATE project_tasks SET status = 'in_progress' WHERE id = :id", { ':id': bug.id });
    } catch {}

    const result = await runClaudeOnBug(bug, config);
    recordAttempt(bug, result);

    // Don't mark done automatically — vision verifier (L4) will re-validate
    // on its next pass. If the bug remains, L3 will keep filing recurrences
    // and L5 will retry up to max_attempts. If vision says ok, the operator
    // (or a future hook) can close the bug.
    try {
      const status = result.ok ? 'in_test' : 'todo';
      run(`UPDATE project_tasks SET status = :s WHERE id = :id`,
        { ':s': status, ':id': bug.id });
    } catch {}
  } catch (e) {
    console.warn('[ForgeDashboard] tick error:', e.message);
  } finally {
    _running = false;
  }
}

export function startForgeDashboard() {
  if (_interval) return;
  console.log('[ForgeDashboard] starting — check every', CHECK_INTERVAL_MS / 1000, 's (off by default; enable via forge_dashboard_autofix setting)');
  setTimeout(() => {
    tickOnce().catch(e => console.warn('[ForgeDashboard] tick fail:', e.message));
    _interval = setInterval(() => {
      tickOnce().catch(e => console.warn('[ForgeDashboard] tick fail:', e.message));
    }, CHECK_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

export function stopForgeDashboard() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

// Manual trigger for testing — bypasses interval, runs one pass now.
export async function runForgeDashboardOnce() {
  await tickOnce();
  return { ok: true };
}

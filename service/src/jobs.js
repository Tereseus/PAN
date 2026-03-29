// PAN Job Runner — manages all scheduled jobs across projects
//
// The general-purpose scheduled task system. Each job has:
//   - A type (github, dependency_check, build_monitor, custom, etc.)
//   - An interval (how often it runs)
//   - A project scope (which project it belongs to, or 'global')
//   - An enabled flag
//   - A handler function
//
// GitHub monitoring, dependency checking, deploy status, etc. are all
// just job types registered with this runner. New job types can be
// added by any subsystem.

import { all, get, insert, run as dbRun } from './db.js';

// Job registry — maps job type to handler function
const jobHandlers = {};
const activeTimers = {};  // jobId -> intervalHandle
let masterTimer = null;

// Ensure jobs table exists
try {
  dbRun(`CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    job_type TEXT NOT NULL,
    project_id INTEGER,
    config TEXT DEFAULT '{}',
    interval_ms INTEGER DEFAULT 7200000,
    enabled INTEGER DEFAULT 1,
    last_run TEXT,
    last_result TEXT,
    last_error TEXT,
    run_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(name)
  )`);
  dbRun(`CREATE INDEX IF NOT EXISTS idx_jobs_type ON scheduled_jobs(job_type)`);
  dbRun(`CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON scheduled_jobs(enabled)`);
} catch {}

/**
 * Register a job type handler.
 * Handlers are async functions that receive (jobConfig) and return { ok, result?, error? }
 */
function registerJobType(type, handler) {
  jobHandlers[type] = handler;
  console.log(`[Jobs] Registered type: ${type}`);
}

/**
 * Create or update a scheduled job.
 */
function upsertJob({ name, job_type, project_id = null, config = {}, interval_ms = 7200000, enabled = true }) {
  const existing = get(`SELECT id FROM scheduled_jobs WHERE name = :name`, { ':name': name });
  if (existing) {
    dbRun(`UPDATE scheduled_jobs SET job_type = :type, project_id = :pid, config = :config,
      interval_ms = :interval, enabled = :enabled WHERE name = :name`, {
      ':name': name, ':type': job_type, ':pid': project_id,
      ':config': JSON.stringify(config), ':interval': interval_ms, ':enabled': enabled ? 1 : 0,
    });
    return existing.id;
  } else {
    return insert(`INSERT INTO scheduled_jobs (name, job_type, project_id, config, interval_ms, enabled)
      VALUES (:name, :type, :pid, :config, :interval, :enabled)`, {
      ':name': name, ':type': job_type, ':pid': project_id,
      ':config': JSON.stringify(config), ':interval': interval_ms, ':enabled': enabled ? 1 : 0,
    });
  }
}

/**
 * Run a single job by ID or row object.
 */
async function runJob(jobOrId) {
  const job = typeof jobOrId === 'number'
    ? get(`SELECT * FROM scheduled_jobs WHERE id = :id`, { ':id': jobOrId })
    : jobOrId;

  if (!job) return { ok: false, error: 'Job not found' };

  const handler = jobHandlers[job.job_type];
  if (!handler) {
    console.log(`[Jobs] No handler for type: ${job.job_type}`);
    return { ok: false, error: `No handler for type: ${job.job_type}` };
  }

  let config = {};
  try { config = JSON.parse(job.config || '{}'); } catch {}

  console.log(`[Jobs] Running: ${job.name} (${job.job_type})`);
  const start = Date.now();

  try {
    const result = await handler(config, job);
    const elapsed = Date.now() - start;

    dbRun(`UPDATE scheduled_jobs SET last_run = datetime('now','localtime'),
      last_result = :result, last_error = NULL, run_count = run_count + 1 WHERE id = :id`, {
      ':id': job.id,
      ':result': JSON.stringify(result).slice(0, 2000),
    });

    console.log(`[Jobs] ${job.name} completed in ${elapsed}ms`);
    return { ok: true, result, elapsed };
  } catch (err) {
    dbRun(`UPDATE scheduled_jobs SET last_run = datetime('now','localtime'),
      last_error = :err, run_count = run_count + 1 WHERE id = :id`, {
      ':id': job.id,
      ':err': err.message,
    });

    console.error(`[Jobs] ${job.name} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Main tick — checks all enabled jobs and runs any that are due.
 */
async function tick() {
  const jobs = all(`SELECT * FROM scheduled_jobs WHERE enabled = 1`);

  for (const job of jobs) {
    // Check if it's time to run (last_run + interval_ms <= now)
    if (job.last_run) {
      const lastRun = new Date(job.last_run).getTime();
      if (Date.now() - lastRun < job.interval_ms) continue;
    }

    // Run it (don't await sequentially — fire and handle)
    runJob(job).catch(err => console.error(`[Jobs] Tick error for ${job.name}:`, err.message));
  }
}

/**
 * List all jobs with their status.
 */
function listJobs(filter = {}) {
  let query = 'SELECT * FROM scheduled_jobs';
  const params = {};

  if (filter.job_type) {
    query += ' WHERE job_type = :type';
    params[':type'] = filter.job_type;
  } else if (filter.project_id) {
    query += ' WHERE project_id = :pid';
    params[':pid'] = filter.project_id;
  } else if (filter.enabled !== undefined) {
    query += ' WHERE enabled = :enabled';
    params[':enabled'] = filter.enabled ? 1 : 0;
  }

  query += ' ORDER BY job_type, name';
  return all(query, params);
}

/**
 * Enable or disable a job.
 */
function setJobEnabled(jobId, enabled) {
  dbRun(`UPDATE scheduled_jobs SET enabled = :enabled WHERE id = :id`, {
    ':id': jobId, ':enabled': enabled ? 1 : 0,
  });
}

/**
 * Delete a job.
 */
function deleteJob(jobId) {
  dbRun(`DELETE FROM scheduled_jobs WHERE id = :id`, { ':id': jobId });
}

/**
 * Start the job runner. Checks every 60 seconds for jobs that are due.
 */
function startJobRunner() {
  // Tick every 60 seconds to check for due jobs
  setTimeout(() => tick().catch(console.error), 45000); // first tick after 45s
  masterTimer = setInterval(() => tick().catch(console.error), 60000);
  console.log('[Jobs] Runner started (checks every 60s)');
}

function stopJobRunner() {
  if (masterTimer) clearInterval(masterTimer);
  masterTimer = null;
  console.log('[Jobs] Runner stopped');
}

export {
  registerJobType,
  upsertJob,
  runJob,
  listJobs,
  setJobEnabled,
  deleteJob,
  startJobRunner,
  stopJobRunner,
};

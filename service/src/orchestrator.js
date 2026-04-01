// PAN Orchestrator — the autonomous agent loop
//
// Connects Scout, Dream, GitHub Monitor, AutoDev, and Classifier into a unified
// system that thinks about what to do next. Runs after each subsystem produces
// findings, and decides what actions to take.
//
// Flow:
//   Scout finds tools → Orchestrator decides if PAN should integrate them → creates tasks
//   GitHub Monitor finds replies → Orchestrator drafts responses or creates tasks
//   Dream updates state → Orchestrator reads it and identifies gaps/opportunities
//   Classifier processes events → Orchestrator spots patterns and suggests new scouting missions
//
// The orchestrator surfaces actionable items to the user via:
//   - Dashboard notifications (events table with type 'OrchestratorAction')
//   - Phone notifications (via /api/v1/actions queue)
//   - Console log for terminal users

import { all, get, run, logEvent } from './db.js';
import { claude } from './claude.js';

let timer = null;

// Ensure orchestrator tables exist
try {
  run(`CREATE TABLE IF NOT EXISTS orchestrator_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    action_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority INTEGER DEFAULT 5,
    status TEXT DEFAULT 'pending',
    auto_approve INTEGER DEFAULT 0,
    data TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    resolved_at TEXT
  )`);
  run(`CREATE INDEX IF NOT EXISTS idx_orch_status ON orchestrator_actions(status)`);
  run(`CREATE INDEX IF NOT EXISTS idx_orch_priority ON orchestrator_actions(priority DESC)`);
} catch {}

// Process new scout findings into actionable items
async function processScoutFindings() {
  const findings = all(`
    SELECT * FROM scout_findings
    WHERE status = 'new' AND relevance_score >= 0.7
    ORDER BY relevance_score DESC
    LIMIT 10
  `);

  if (findings.length === 0) return;

  for (const f of findings) {
    // Check if we already created an action for this tool
    const existing = get(
      `SELECT id FROM orchestrator_actions WHERE source = 'scout' AND title LIKE :name`,
      { ':name': `%${f.tool_name}%` }
    );
    if (existing) continue;

    insert(`INSERT INTO orchestrator_actions (source, action_type, title, description, priority, data)
      VALUES (:src, :type, :title, :desc, :pri, :data)`, {
      ':src': 'scout',
      ':type': 'evaluate_tool',
      ':title': `Evaluate: ${f.tool_name}`,
      ':desc': `${f.description}\nRelevance: ${f.relevance}\nScore: ${f.relevance_score}`,
      ':pri': Math.round(f.relevance_score * 10),
      ':data': JSON.stringify({ finding_id: f.id, url: f.url, category: f.category }),
    });

    // Mark finding as queued
    run(`UPDATE scout_findings SET status = 'queued' WHERE id = :id`, { ':id': f.id });
  }

  if (findings.length > 0) {
    console.log(`[Orchestrator] Queued ${findings.length} scout findings for evaluation`);
  }
}

// Process new GitHub comments into actionable items
async function processGithubComments() {
  // Find GitHubComment events that haven't been turned into actions yet
  const comments = all(`
    SELECT e.id, e.data, e.created_at FROM events e
    LEFT JOIN orchestrator_actions oa ON oa.source = 'github' AND oa.data LIKE '%"event_id":' || e.id || '%'
    WHERE e.event_type = 'GitHubComment'
    AND oa.id IS NULL
    ORDER BY e.created_at DESC
    LIMIT 20
  `);

  for (const c of comments) {
    let data;
    try { data = JSON.parse(c.data); } catch { continue; }

    insert(`INSERT INTO orchestrator_actions (source, action_type, title, description, priority, data)
      VALUES (:src, :type, :title, :desc, :pri, :data)`, {
      ':src': 'github',
      ':type': 'review_comment',
      ':title': `Reply on ${data.repo}#${data.issue_number}`,
      ':desc': `@${data.author}: ${(data.body || '').slice(0, 200)}`,
      ':pri': 7,
      ':data': JSON.stringify({ event_id: c.id, ...data }),
    });
  }

  if (comments.length > 0) {
    console.log(`[Orchestrator] Queued ${comments.length} GitHub comments for review`);
  }
}

// Analyze the dream state for gaps and suggest new scouting missions or tasks
async function analyzeState() {
  // Only run this occasionally — check if we've done it in the last 6 hours
  const lastAnalysis = get(
    "SELECT created_at FROM orchestrator_actions WHERE source = 'analysis' ORDER BY created_at DESC LIMIT 1"
  );
  if (lastAnalysis) {
    const hoursAgo = (Date.now() - new Date(lastAnalysis.created_at).getTime()) / 3600000;
    if (hoursAgo < 6) return;
  }

  // Read the current state file and recent events
  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  const stateFile = join(process.cwd(), '.pan-state.md');
  const state = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '';

  if (!state) return;

  // Get recent orchestrator actions to avoid duplicates
  const recentActions = all(
    `SELECT title FROM orchestrator_actions WHERE created_at > datetime('now', '-2 days', 'localtime') LIMIT 30`
  ).map(a => a.title);

  // Get active project tasks
  const activeTasks = all(
    `SELECT title, status FROM project_tasks WHERE status IN ('todo', 'in_progress') LIMIT 20`
  ).map(t => `[${t.status}] ${t.title}`);

  try {
    const result = await claude(
      `You are PAN's Orchestrator. You analyze the current project state and suggest automated actions.

CURRENT STATE:
${state.slice(0, 3000)}

ACTIVE TASKS:
${activeTasks.join('\n') || 'None'}

RECENT ACTIONS ALREADY QUEUED (do NOT duplicate):
${recentActions.join('\n') || 'None'}

Based on the state, suggest 0-3 NEW automated actions PAN should take. Each should be:
- A specific scouting mission (search for a tool/library to solve a known issue)
- A task to create (something that should be built based on current priorities)
- A notification to surface to the user (something important they should know)

Return a JSON array. Each item:
{"type": "scout_mission|create_task|notify", "title": "short title", "description": "what and why", "priority": 1-10}

Return [] if nothing actionable. Only return the JSON array.`,
      { model: 'claude-haiku-4-5-20251001', timeout: 30000, maxTokens: 1000, caller: 'orchestrator' }
    );

    const match = result.match(/\[[\s\S]*\]/);
    if (!match) return;

    const suggestions = JSON.parse(match[0]);
    for (const s of suggestions) {
      if (!s.title || !s.type) continue;

      insert(`INSERT INTO orchestrator_actions (source, action_type, title, description, priority, data)
        VALUES (:src, :type, :title, :desc, :pri, :data)`, {
        ':src': 'analysis',
        ':type': s.type,
        ':title': s.title,
        ':desc': s.description || '',
        ':pri': s.priority || 5,
        ':data': JSON.stringify({ ai_suggested: true }),
      });
    }

    if (suggestions.length > 0) {
      console.log(`[Orchestrator] AI suggested ${suggestions.length} new actions`);
    }
  } catch (err) {
    console.error('[Orchestrator] State analysis error:', err.message);
  }
}

// Main orchestration cycle
async function orchestrate() {
  console.log('[Orchestrator] Running cycle...');

  try {
    await processScoutFindings();
    await processGithubComments();
    await analyzeState();

    // Count pending actions for summary
    const pending = get(
      "SELECT COUNT(*) as count FROM orchestrator_actions WHERE status = 'pending'"
    );
    const count = pending?.count || 0;

    if (count > 0) {
      console.log(`[Orchestrator] ${count} pending action(s) awaiting review`);

      // Push notification event for dashboard/phone
      const actions = all(
        `SELECT id, action_type, title, priority FROM orchestrator_actions
         WHERE status = 'pending' ORDER BY priority DESC LIMIT 5`
      );

      logEvent('orchestrator-' + Date.now(), 'OrchestratorSummary', {
        pending_count: count,
        top_actions: actions.map(a => ({ id: a.id, type: a.action_type, title: a.title, priority: a.priority })),
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    console.error('[Orchestrator] Error:', err.message);
  }
}

// Get pending actions for dashboard display
function getPendingActions(limit = 20) {
  return all(
    `SELECT * FROM orchestrator_actions WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT :limit`,
    { ':limit': limit }
  );
}

// Approve an action — moves it to AutoDev task queue or executes it
async function approveAction(actionId) {
  const action = get(`SELECT * FROM orchestrator_actions WHERE id = :id`, { ':id': actionId });
  if (!action) return { ok: false, error: 'Action not found' };

  run(`UPDATE orchestrator_actions SET status = 'approved', resolved_at = datetime('now','localtime') WHERE id = :id`,
    { ':id': actionId });

  // If it's a task, create it in project_tasks
  if (action.action_type === 'create_task') {
    insert(`INSERT INTO project_tasks (project_id, title, description, priority, status)
      VALUES (1, :title, :desc, :pri, 'todo')`, {
      ':title': action.title,
      ':desc': action.description,
      ':pri': action.priority,
    });
  }

  console.log(`[Orchestrator] Approved: ${action.title}`);
  return { ok: true };
}

// Dismiss an action
function dismissAction(actionId) {
  run(`UPDATE orchestrator_actions SET status = 'dismissed', resolved_at = datetime('now','localtime') WHERE id = :id`,
    { ':id': actionId });
}

// Add a custom scouting mission
function addScoutMission(topic, description) {
  insert(`INSERT INTO orchestrator_actions (source, action_type, title, description, priority)
    VALUES ('user', 'scout_mission', :title, :desc, 8)`, {
    ':title': topic,
    ':desc': description || '',
  });
}

function startOrchestrator(intervalMs = 4 * 60 * 60 * 1000) {
  // First run after 2 minutes (let subsystems warm up)
  setTimeout(() => orchestrate().catch(console.error), 120000);
  timer = setInterval(() => orchestrate().catch(console.error), intervalMs);
  console.log(`[Orchestrator] Running every ${Math.round(intervalMs / 3600000)}h`);
}

function stopOrchestrator() {
  if (timer) clearInterval(timer);
  timer = null;
}

export {
  orchestrate,
  startOrchestrator,
  stopOrchestrator,
  getPendingActions,
  approveAction,
  dismissAction,
  addScoutMission,
};

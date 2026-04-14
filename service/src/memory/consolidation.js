// PAN Memory Consolidation — extracts memories from session events
//
// After each session (or periodically), processes recent events and
// extracts episodic memories, semantic facts, and procedural patterns.
// Uses LLM for deep extraction, with heuristic fallback.

import { all, get, run as dbRun, logEvent } from '../db.js';
import { claude } from '../claude.js';
import * as episodic from './episodic.js';
import * as semantic from './semantic.js';
import * as procedural from './procedural.js';

// Heuristic patterns for extracting facts without LLM
const CORRECTION_PATTERNS = [
  /no,?\s+(?:actually|it's|it is|that's|use)\s+(.+)/i,
  /don't\s+(.+)/i,
  /stop\s+(.+)/i,
  /never\s+(.+)/i,
  /always\s+(.+)/i,
  /(?:I|we)\s+prefer\s+(.+)/i,
  /(?:from now on|going forward)\s+(.+)/i,
];

const PREFERENCE_PATTERNS = [
  /(?:I|we)\s+(?:like|want|need|prefer)\s+(.+)/i,
  /(?:make sure|ensure|remember)\s+(?:to\s+)?(.+)/i,
  /(?:the rule is|the pattern is)\s+(.+)/i,
];

// Extract episodes and facts from recent events using heuristics
function heuristicExtract(events) {
  const episodes = [];
  const facts = [];

  for (const e of events) {
    let data = {};
    try { data = JSON.parse(e.data); } catch { continue; }

    // Extract user prompts as potential episodes
    if (e.event_type === 'UserPromptSubmit') {
      const prompt = data.prompt || '';
      if (prompt.length < 20 || prompt.startsWith('{')) continue;

      // Check for corrections/preferences
      for (const pattern of CORRECTION_PATTERNS) {
        const match = prompt.match(pattern);
        if (match) {
          facts.push({
            subject: 'user_correction',
            predicate: 'stated',
            object: match[1].slice(0, 200),
            category: 'user_preference',
            confidence: 0.9,
          });
        }
      }
      for (const pattern of PREFERENCE_PATTERNS) {
        const match = prompt.match(pattern);
        if (match) {
          facts.push({
            subject: 'user_preference',
            predicate: 'wants',
            object: match[1].slice(0, 200),
            category: 'user_preference',
            confidence: 0.8,
          });
        }
      }
    }

    // Extract voice commands as episodes
    if (e.event_type === 'RouterCommand') {
      const q = data.text || '';
      const a = data.result || data.response_text || '';
      if (q.length > 10) {
        const importance = data.error ? 0.7 : 0.4;
        episodes.push({
          summary: `Voice: ${q.slice(0, 150)}`,
          detail: a.slice(0, 300),
          type: 'voice',
          outcome: data.error ? 'failure' : 'success',
          importance,
          sessionId: e.session_id,
        });
      }
    }

    // Extract errors as high-importance episodes
    if (e.event_type === 'Stop' && data.stop_reason === 'error') {
      episodes.push({
        summary: `Error: ${(data.error || data.last_assistant_message || '').slice(0, 150)}`,
        detail: data.last_assistant_message?.slice(0, 300) || '',
        type: 'error',
        outcome: 'failure',
        importance: 0.8,
        sessionId: e.session_id,
      });
    }
  }

  return { episodes, facts };
}

// Deep extraction using LLM — finds things heuristics miss
async function llmExtract(events) {
  // Build event summary for LLM
  const entries = [];
  for (const e of events) {
    let data = {};
    try { data = JSON.parse(e.data); } catch { continue; }

    let text = null;
    if (e.event_type === 'RouterCommand') {
      text = `Voice Q: ${data.text || ''} → A: ${(data.result || data.response_text || '').slice(0, 200)}`;
    } else if (e.event_type === 'UserPromptSubmit') {
      const p = data.prompt || '';
      if (p.length >= 20 && !p.startsWith('{')) text = `User: ${p.slice(0, 300)}`;
    } else if (e.event_type === 'Stop') {
      const m = data.last_assistant_message || '';
      if (m.length >= 30) text = `Claude: ${m.slice(0, 300)}`;
    }
    if (text) entries.push(`[${e.created_at}] ${text}`);
  }

  if (entries.length < 3) return { episodes: [], facts: [], procedures: [] };

  const context = entries.slice(0, 80).join('\n');

  const prompt = `You are PAN's memory consolidation system. Extract structured memories from these recent events.

EVENTS:
${context}

Extract and return a JSON object with three arrays:

{
  "episodes": [
    {"summary": "brief what happened", "detail": "more context", "type": "interaction|task|error|observation", "outcome": "success|failure|partial", "importance": 0.0-1.0}
  ],
  "facts": [
    {"subject": "entity", "predicate": "relationship", "object": "value", "description": "natural language", "category": "user_preference|domain_knowledge|codebase|process|tool", "confidence": 0.0-1.0}
  ],
  "procedures": [
    {"name": "procedure name", "description": "what it does", "triggerPattern": "when to use it", "steps": [{"action": "step description"}]}
  ]
}

Rules:
- Episodes: only meaningful interactions, not routine status checks
- Facts: corrections ("no, actually X"), preferences ("I want X"), domain knowledge ("X uses Y")
- Procedures: multi-step patterns that were repeated or explicitly taught
- Importance: errors=0.7+, corrections=0.8+, routine=0.3-0.5
- Be selective — only extract what's worth remembering long-term
- Return ONLY the JSON object, no other text`;

  try {
    const result = await claude(prompt, { maxTokens: 2000, timeout: 45000, caller: 'consolidation' });
    return JSON.parse(result);
  } catch (err) {
    console.error('[PAN Memory] LLM extraction failed:', err.message);
    return { episodes: [], facts: [], procedures: [] };
  }
}

// Task reconciliation — cross-reference session activity against open tasks
// and auto-mark tasks as done/in_progress when evidence supports it
async function reconcileTasks(events) {
  // Build summary of what happened in recent events
  const entries = [];
  for (const e of events) {
    let data = {};
    try { data = JSON.parse(e.data); } catch { continue; }
    if (e.event_type === 'UserPromptSubmit' && data.prompt) {
      entries.push(`User: ${data.prompt.slice(0, 300)}`);
    } else if (e.event_type === 'Stop' && data.last_assistant_message) {
      entries.push(`Claude: ${data.last_assistant_message.slice(0, 300)}`);
    }
  }
  if (entries.length < 2) return { updated: 0 };

  // Fetch all open tasks (todo + in_progress) across all projects via DB directly
  let openTasks;
  try {
    openTasks = all(
      `SELECT t.id, t.title, t.status, t.description, p.name as project_name, m.name as milestone_name
       FROM project_tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN project_milestones m ON m.id = t.milestone_id
       WHERE t.status IN ('todo', 'in_progress')
       ORDER BY t.priority DESC LIMIT 200`
    );
  } catch (err) {
    console.error('[PAN Tasks] Failed to fetch open tasks:', err.message);
    return { updated: 0 };
  }

  if (openTasks.length === 0) return { updated: 0 };

  // Build task list for LLM
  const taskList = openTasks.map(t => `[id=${t.id}] ${t.title} (${t.status})`).join('\n');
  const sessionSummary = entries.slice(-40).join('\n');

  const prompt = `You are PAN's task tracker. Compare recent session activity against open tasks and identify which tasks were COMPLETED or STARTED.

OPEN TASKS:
${taskList}

RECENT SESSION ACTIVITY:
${sessionSummary}

Return a JSON array of task updates. ONLY include tasks where the session activity clearly shows the task was completed or started. Be conservative — don't mark something done unless there's clear evidence.

[
  {"task_id": 123, "new_status": "done", "reason": "brief evidence"},
  {"task_id": 456, "new_status": "in_progress", "reason": "brief evidence"}
]

Rules:
- "done" = the feature/fix is clearly implemented and working
- "in_progress" = work clearly started but not finished
- Do NOT guess — only match when the session activity directly relates to the task
- Return empty array [] if no tasks match
- Return ONLY the JSON array, no other text`;

  try {
    const result = await claude(prompt, { maxTokens: 1000, timeout: 30000, caller: 'task-reconcile' });
    const updates = JSON.parse(result);
    if (!Array.isArray(updates)) return { updated: 0 };

    let updated = 0;
    for (const u of updates) {
      if (!u.task_id || !u.new_status) continue;
      if (!['done', 'in_progress'].includes(u.new_status)) continue;

      try {
        const existing = get("SELECT * FROM project_tasks WHERE id = :id", { ':id': u.task_id });
        if (!existing) continue;
        if (existing.status === 'done') continue; // already done, skip

        const updates = ["status = :status"];
        const params = { ':id': u.task_id, ':status': u.new_status };
        if (u.new_status === 'done') {
          updates.push("completed_at = datetime('now','localtime')");
        }
        dbRun(`UPDATE project_tasks SET ${updates.join(', ')} WHERE id = :id`, params);

        updated++;
        console.log(`[PAN Tasks] Auto-updated task ${u.task_id} → ${u.new_status}: ${u.reason}`);
        logEvent('system-task-reconcile', 'TaskAutoUpdate', {
          task_id: u.task_id,
          new_status: u.new_status,
          reason: u.reason,
          previous_status: existing.status,
        });
      } catch (err) {
        console.error(`[PAN Tasks] Failed to update task ${u.task_id}:`, err.message);
      }
    }

    if (updated > 0) {
      console.log(`[PAN Tasks] Reconciled ${updated} tasks from session activity`);
    }
    return { updated };
  } catch (err) {
    console.error('[PAN Tasks] Reconciliation LLM call failed:', err.message);
    return { updated: 0 };
  }
}

// Consolidate — run after session end or periodically
async function consolidate({ since = null, useLLM = true } = {}) {
  // Track consolidation window properly — use a dedicated marker, not episodic_memories timestamp
  // This prevents re-processing the same events when no episodes were stored
  const lastConsolidation = get("SELECT MAX(created_at) as t FROM events WHERE event_type = 'ConsolidationRun'");
  const sinceTime = since || lastConsolidation?.t || new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const events = all(
    `SELECT id, session_id, event_type, data, created_at FROM events
     WHERE created_at > :since
     AND event_type IN ('RouterCommand', 'UserPromptSubmit', 'Stop', 'VisionAnalysis')
     ORDER BY created_at ASC LIMIT 200`,
    { ':since': sinceTime }
  );

  if (events.length < 3) {
    console.log(`[PAN Memory] Only ${events.length} events since last consolidation — skipping`);
    return { episodes: 0, facts: 0, procedures: 0 };
  }

  console.log(`[PAN Memory] Consolidating ${events.length} events since ${sinceTime}...`);

  // Heuristic extraction (always runs, fast)
  const heuristic = heuristicExtract(events);

  // LLM extraction (optional, more thorough)
  let llm = { episodes: [], facts: [], procedures: [] };
  if (useLLM && events.length >= 5) {
    llm = await llmExtract(events);
  }

  // Merge results (LLM takes priority for episodes/facts, heuristic for corrections)
  const allEpisodes = [...llm.episodes, ...heuristic.episodes];
  const allFacts = [...llm.facts, ...heuristic.facts];
  const allProcedures = llm.procedures || [];

  // Store episodes
  let storedEpisodes = 0;
  for (const ep of allEpisodes) {
    try {
      await episodic.store(ep);
      storedEpisodes++;
    } catch (err) {
      console.error('[PAN Memory] Episode store error:', err.message);
    }
  }

  // Store facts (with contradiction detection)
  let storedFacts = 0;
  for (const fact of allFacts) {
    try {
      await semantic.store(fact);
      storedFacts++;
    } catch (err) {
      console.error('[PAN Memory] Fact store error:', err.message);
    }
  }

  // Store procedures
  let storedProcs = 0;
  for (const proc of allProcedures) {
    try {
      await procedural.store(proc);
      storedProcs++;
    } catch (err) {
      console.error('[PAN Memory] Procedure store error:', err.message);
    }
  }

  // Log consolidation run so we don't re-process the same events
  logEvent('system-consolidation', 'ConsolidationRun', {
    since: sinceTime,
    events_processed: events.length,
    episodes: storedEpisodes,
    facts: storedFacts,
    procedures: storedProcs,
  });

  // Task reconciliation — check if any open tasks were completed during this window
  let tasksUpdated = 0;
  if (useLLM && events.length >= 3) {
    try {
      const taskResult = await reconcileTasks(events);
      tasksUpdated = taskResult.updated;
    } catch (err) {
      console.error('[PAN Memory] Task reconciliation error:', err.message);
    }
  }

  console.log(`[PAN Memory] Consolidated: ${storedEpisodes} episodes, ${storedFacts} facts, ${storedProcs} procedures, ${tasksUpdated} tasks updated`);
  return { episodes: storedEpisodes, facts: storedFacts, procedures: storedProcs, tasksUpdated };
}

export { consolidate, reconcileTasks, heuristicExtract, llmExtract };

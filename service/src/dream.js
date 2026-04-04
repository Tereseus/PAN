// PAN Auto-Dream — living project state maintenance
//
// Runs periodically to review recent events and REWRITE a single living
// state document (.pan-state.md). No more appending rows to a database —
// one file, always current, always accurate.

import { all, get, insert } from './db.js';
import { consolidate as consolidateMemory } from './memory/consolidation.js';
import { evolve } from './evolution/engine.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

let dreamInterval = null;

// State file goes in PROJECT ROOT (where CLAUDE.md lives)
// inject-context.cjs reads from project root, dream writes there too
// Write to BOTH locations for compatibility (server reads from cwd, hook reads from project root)
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __dreamDirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dreamDirname, '..', '..');
const STATE_FILE = join(PROJECT_ROOT, '.pan-state.md');
const SERVICE_STATE_FILE = join(__dreamDirname, '..', '.pan-state.md');

function readCurrentState() {
  try {
    if (existsSync(STATE_FILE)) return readFileSync(STATE_FILE, 'utf8');
  } catch {}
  return '';
}

async function dream() {
  console.log('[PAN Dream] Starting state update...');

  try {
    const { claude } = await import('./claude.js');

    // Get events since last dream (or last 12 hours)
    const lastDream = get("SELECT MAX(created_at) as t FROM events WHERE event_type = 'DreamCycle'");
    const since = lastDream?.t || new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const events = all(
      `SELECT id, event_type, data, created_at FROM events
       WHERE created_at > :since
       AND event_type NOT IN ('SessionStart', 'SessionEnd', 'DreamCycle', 'MobileSend')
       ORDER BY created_at ASC`,
      { ':since': since }
    );

    if (events.length < 5) {
      console.log(`[PAN Dream] Only ${events.length} events since last dream — skipping`);
      return;
    }

    // Extract clean text from events
    const entries = [];
    for (const e of events) {
      let data = {};
      try { data = JSON.parse(e.data); } catch { continue; }

      let text = null;
      if (e.event_type === 'RouterCommand') {
        const q = data.text || '';
        const a = data.result || data.response_text || '';
        if (q) text = `Voice Q: ${q}\nA: ${a}`;
      } else if (e.event_type === 'UserPromptSubmit') {
        const p = data.prompt || '';
        if (p.length >= 20 && !p.startsWith('{')) text = `User: ${p}`;
      } else if (e.event_type === 'Stop') {
        const m = data.last_assistant_message || '';
        if (m.length >= 30) text = `Claude: ${m}`;
      } else if (e.event_type === 'VisionAnalysis') {
        const d = data.description || '';
        if (d) text = `Saw: ${d}`;
      }

      if (text) entries.push(`[${e.created_at}] ${text.slice(0, 500)}`);
    }

    if (entries.length < 3) {
      console.log(`[PAN Dream] Only ${entries.length} meaningful entries — skipping`);
      return;
    }

    // Build context — cap at ~40K chars (~10K tokens)
    let context = '';
    for (const entry of entries) {
      if (context.length + entry.length > 40000) break;
      context += entry + '\n\n';
    }

    // Read existing state file
    const currentState = readCurrentState();

    // Ask Haiku to rewrite the state document
    const result = await claude(
      `You are PAN's memory system. You maintain a LIVING STATE DOCUMENT that tracks what's going on across the project.

${currentState ? `CURRENT STATE DOCUMENT:\n${currentState}\n\n` : 'No state document exists yet.\n\n'}RECENT EVENTS:\n${context}

REWRITE the state document based on what happened. The document should have these sections:

## What Works
Things that are confirmed working. Remove items from here if events show they broke.

## Known Issues
Bugs and problems that are CURRENTLY broken. REMOVE issues that were FIXED in the recent events. Only keep things that are actually still broken.

## Current Priorities
What the user is actively working on or wants done next. Update based on what they said.

## Key Decisions
Important architectural or design decisions that affect future work. Keep these stable unless explicitly changed.

## User Preferences
How the user likes to work, what they've told Claude to do/not do.

CRITICAL RULES:
- If something was FIXED in recent events, REMOVE it from Known Issues and ADD it to What Works.
- If the user said something is wrong with this document, fix it.
- Do NOT keep old bugs that were resolved — this is the #1 problem to avoid.
- Keep it concise. Each item should be 1 line.
- This document should be SHORT — under 80 lines total.

Output ONLY the markdown document, nothing else.`,
      { maxTokens: 3000, timeout: 60000, caller: 'dream' }
    );

    if (!result || result.length < 50) {
      console.log('[PAN Dream] Haiku response too short, skipping state update');
      return;
    }

    // Write the new state file to project root (where inject-context.cjs reads it)
    writeFileSync(STATE_FILE, result, 'utf8');
    // Also write to service dir (where server reads it via process.cwd())
    try { writeFileSync(SERVICE_STATE_FILE, result, 'utf8'); } catch {}
    console.log(`[PAN Dream] State file updated (${result.length} chars) from ${entries.length} events → ${STATE_FILE}`);

    // Consolidate vector memories from recent events
    try {
      await consolidateMemory({ useLLM: false });
      console.log('[PAN Dream] Memory consolidation complete');
    } catch (memErr) {
      console.error('[PAN Dream] Memory consolidation failed:', memErr.message);
    }

    // Run evolution pipeline if enabled (default OFF)
    try {
      let evolutionEnabled = false;
      try {
        const toggleRow = get("SELECT value FROM settings WHERE key = 'feature_toggles'");
        if (toggleRow) {
          const toggles = JSON.parse(toggleRow.value);
          evolutionEnabled = toggles.evolution === true;
        }
      } catch {}

      if (evolutionEnabled) {
        console.log('[PAN Dream] Triggering evolution cycle...');
        const evoResult = await evolve();
        console.log(`[PAN Dream] Evolution result: ${evoResult.status} (applied: ${evoResult.applied?.join(', ') || 'none'})`);
      } else {
        console.log('[PAN Dream] Evolution disabled by toggle — skipping');
      }
    } catch (evoErr) {
      console.error('[PAN Dream] Evolution failed:', evoErr.message);
    }

    // Log the dream cycle
    insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
      ':sid': 'system-dream',
      ':type': 'DreamCycle',
      ':data': JSON.stringify({
        events_reviewed: events.length,
        entries_processed: entries.length,
        state_file_size: result.length,
        since,
        timestamp: Date.now()
      })
    });

  } catch (err) {
    console.error('[PAN Dream] Error:', err.message);
  }
}

function startDream(intervalMs = 6 * 60 * 60 * 1000) {
  // Run first dream after 2 minutes (let other systems settle)
  setTimeout(() => {
    dream();
    dreamInterval = setInterval(dream, intervalMs);
  }, 120000);
  console.log(`[PAN Dream] Scheduled every ${Math.round(intervalMs / 3600000)}h`);
}

function stopDream() {
  if (dreamInterval) clearInterval(dreamInterval);
  dreamInterval = null;
}

export { dream, startDream, stopDream };

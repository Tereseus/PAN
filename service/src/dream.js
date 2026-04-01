// PAN Dream Cycle — evolution pipeline + state maintenance
//
// Runs periodically (every 6h). Two phases:
//   1. Evolution pipeline — observe/critique/generate/validate/apply config changes
//   2. State update — rewrite the living .pan-state.md document
//
// The evolution pipeline also triggers memory consolidation (episodic/semantic/procedural).

import { all, get, logEvent } from './db.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evolve } from './evolution/engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let dreamInterval = null;
let lastDreamTime = 0;
const MIN_DREAM_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours minimum between dreams

// State file lives in the PAN project root (service/../), not process.cwd()
const STATE_FILE = join(__dirname, '..', '..', '.pan-state.md');

function readCurrentState() {
  try {
    if (existsSync(STATE_FILE)) return readFileSync(STATE_FILE, 'utf8');
  } catch {}
  return '';
}

async function dream() {
  // Guard against restart storms — minimum 4h between dream cycles
  const now = Date.now();
  if (now - lastDreamTime < MIN_DREAM_INTERVAL) {
    console.log(`[PAN Dream] Skipping — last dream was ${Math.round((now - lastDreamTime) / 60000)}m ago (min ${MIN_DREAM_INTERVAL / 3600000}h)`);
    return;
  }

  console.log('[PAN Dream] Starting dream cycle...');

  try {
    // === Phase 1: Evolution Pipeline ===
    // Runs observe/critique/generate/validate/apply + memory consolidation
    const evolutionResult = await evolve();
    console.log(`[PAN Dream] Evolution: ${evolutionResult.status}${evolutionResult.applied?.length ? ` (${evolutionResult.applied.join(', ')})` : ''}`);

    // === Phase 2: State Document Update ===
    const { claude } = await import('./claude.js');

    // Get events since last dream (or last 12 hours)
    const lastDream = get("SELECT MAX(created_at) as t FROM events WHERE event_type = 'DreamCycle'");
    const since = lastDream?.t || new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const events = all(
      `SELECT id, event_type, data, created_at FROM events
       WHERE created_at > :since
       AND event_type NOT IN ('SessionStart', 'SessionEnd', 'DreamCycle', 'EvolutionCycle', 'MobileSend')
       ORDER BY created_at ASC`,
      { ':since': since }
    );

    if (events.length < 5) {
      console.log(`[PAN Dream] Only ${events.length} events since last dream — skipping state update`);
      lastDreamTime = Date.now();
      logDreamCycle(events.length, 0, evolutionResult);
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
      console.log(`[PAN Dream] Only ${entries.length} meaningful entries — skipping state update`);
      lastDreamTime = Date.now();
      logDreamCycle(events.length, entries.length, evolutionResult);
      return;
    }

    // Build context — cap at ~40K chars (~10K tokens)
    let context = '';
    for (const entry of entries) {
      if (context.length + entry.length > 40000) break;
      context += entry + '\n\n';
    }

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
      { model: 'claude-haiku-4-5-20251001', maxTokens: 3000, timeout: 60000, caller: 'dream' }
    );

    if (!result || result.length < 50) {
      console.log('[PAN Dream] Haiku response too short, skipping state update');
      lastDreamTime = Date.now();
      return;
    }

    writeFileSync(STATE_FILE, result, 'utf8');
    lastDreamTime = Date.now();
    console.log(`[PAN Dream] State file updated (${result.length} chars) from ${entries.length} events`);

    logDreamCycle(events.length, entries.length, evolutionResult, result.length);

  } catch (err) {
    console.error('[PAN Dream] Error:', err.message);
  }
}

function logDreamCycle(eventsCount, entriesCount, evolutionResult, stateSize = 0) {
  logEvent('system-dream', 'DreamCycle', {
    events_reviewed: eventsCount,
    entries_processed: entriesCount,
    state_file_size: stateSize,
    evolution: evolutionResult,
    timestamp: Date.now()
  });
}

function startDream(intervalMs = 6 * 60 * 60 * 1000) {
  // Initialize lastDreamTime from DB so we respect interval across restarts
  try {
    const lastDreamRow = get("SELECT MAX(created_at) as t FROM events WHERE event_type = 'DreamCycle'");
    if (lastDreamRow?.t) {
      lastDreamTime = new Date(lastDreamRow.t).getTime();
      const ago = Math.round((Date.now() - lastDreamTime) / 60000);
      console.log(`[PAN Dream] Last dream was ${ago}m ago`);
    }
  } catch {}

  // Run first dream after 2 minutes (let other systems settle)
  setTimeout(() => {
    dream();
    dreamInterval = setInterval(dream, intervalMs);
  }, 120000);
  console.log(`[PAN Dream] Scheduled every ${Math.round(intervalMs / 3600000)}h, state file: ${STATE_FILE}`);
}

function stopDream() {
  if (dreamInterval) clearInterval(dreamInterval);
  dreamInterval = null;
}

export { dream, startDream, stopDream };

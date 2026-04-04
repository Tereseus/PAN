// PAN Memory Consolidation — extracts memories from session events
//
// After each session (or periodically), processes recent events and
// extracts episodic memories, semantic facts, and procedural patterns.
// Uses LLM for deep extraction, with heuristic fallback.

import { all, get } from '../db.js';
import { claude } from '../claude.js';
import * as episodic from './episodic.js';
import * as semantic from './semantic.js';
import * as procedural from './procedural.js';

// Heuristic patterns for extracting facts without LLM
// IMPORTANT: These must be STRICT to avoid capturing casual speech/voice transcriptions.
// Only match when the user is clearly stating a rule, preference, or correction.
const CORRECTION_PATTERNS = [
  /no,?\s+(?:actually|it's|it is|that's)\s+(.{10,80})$/i,
  /(?:don't|do not)\s+(?:ever|use|add|change|modify|delete|remove)\s+(.{10,80})$/i,
  /(?:stop|quit)\s+(?:doing|adding|changing|using)\s+(.{10,80})$/i,
  /never\s+(?:use|do|add|change|modify|ask|suggest)\s+(.{10,80})$/i,
  /always\s+(?:use|do|check|make|run|start|test)\s+(.{10,80})$/i,
  /(?:I|we)\s+prefer\s+(?:to\s+)?(?:use|have|keep)\s+(.{10,80})$/i,
  /(?:from now on|going forward),?\s+(.{10,80})$/i,
];

const PREFERENCE_PATTERNS = [
  /(?:the rule is|the pattern is)\s+(.{10,80})$/i,
  /(?:make sure|ensure)\s+(?:to\s+)?(?:always|never)\s+(.{10,80})$/i,
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

      // Check for corrections/preferences — only short, clear statements
      // Skip voice-to-text noise (long rambling prompts are rarely clean preferences)
      if (prompt.length < 300) {
        for (const pattern of CORRECTION_PATTERNS) {
          const match = prompt.match(pattern);
          if (match && match[1].length >= 10 && match[1].length <= 80) {
            facts.push({
              subject: 'user_correction',
              predicate: 'stated',
              object: match[1].trim(),
              category: 'user_preference',
              confidence: 0.9,
            });
            break; // one fact per prompt max
          }
        }
        for (const pattern of PREFERENCE_PATTERNS) {
          const match = prompt.match(pattern);
          if (match && match[1].length >= 10 && match[1].length <= 80) {
            facts.push({
              subject: 'user_preference',
              predicate: 'wants',
              object: match[1].trim(),
              category: 'user_preference',
              confidence: 0.8,
            });
            break; // one fact per prompt max
          }
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
    const result = await claude(prompt, { model: 'claude-haiku-4-5-20251001', maxTokens: 2000, timeout: 45000, caller: 'consolidation' });
    return JSON.parse(result);
  } catch (err) {
    console.error('[PAN Memory] LLM extraction failed:', err.message);
    return { episodes: [], facts: [], procedures: [] };
  }
}

// Consolidate — run after session end or periodically
async function consolidate({ since = null, useLLM = true } = {}) {
  // Get the last consolidation timestamp
  const lastConsolidation = get("SELECT MAX(created_at) as t FROM episodic_memories");
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

  console.log(`[PAN Memory] Consolidated: ${storedEpisodes} episodes, ${storedFacts} facts, ${storedProcs} procedures`);
  return { episodes: storedEpisodes, facts: storedFacts, procedures: storedProcs };
}

export { consolidate, heuristicExtract, llmExtract };

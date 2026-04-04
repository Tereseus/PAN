// PAN Evolution Engine — self-improvement pipeline
//
// After each dream cycle, runs a 6-step pipeline:
//   1. Observe  — extract corrections, preferences, errors from recent events
//   2. Critique — separate LLM call assesses what worked/failed
//   3. Generate — produce atomic config deltas
//   4. Validate — safety gates (constitution check, regression, size limits)
//   5. Apply    — write changes, bump version
//   6. Consolidate — compress observations into principles (periodic)
//
// Config files live in pan-config/ as versioned markdown.
// Constitution is IMMUTABLE — the engine cannot modify it.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { all, get, insert, logEvent } from '../db.js';
import { claude } from '../claude.js';
import { consolidate as consolidateMemory } from '../memory/consolidation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', '..', 'pan-config');
const IMMUTABLE_FILES = ['constitution.md']; // NEVER modify these

// Read a config file
function readConfig(name) {
  const path = join(CONFIG_DIR, `${name}.md`);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

// Write a config file (with version tracking)
function writeConfig(name, content, validationResult = null) {
  if (IMMUTABLE_FILES.includes(`${name}.md`)) {
    console.log(`[PAN Evolution] BLOCKED: attempted to modify immutable file ${name}.md`);
    return false;
  }

  const path = join(CONFIG_DIR, `${name}.md`);
  const oldContent = existsSync(path) ? readFileSync(path, 'utf8') : '';

  if (oldContent === content) return false; // no change

  // Get current version
  const lastVersion = get(
    `SELECT MAX(version) as v FROM evolution_versions WHERE config_file = :file`,
    { ':file': name }
  );
  const newVersion = (lastVersion?.v || 0) + 1;

  // Compute simple diff
  const diff = computeDiff(oldContent, content);

  // Store version in DB
  insert(
    `INSERT INTO evolution_versions (config_file, version, content, diff_from_previous, validation_result)
     VALUES (:file, :version, :content, :diff, :validation)`,
    {
      ':file': name,
      ':version': newVersion,
      ':content': content,
      ':diff': diff,
      ':validation': validationResult ? JSON.stringify(validationResult) : null,
    }
  );

  // Write to disk
  writeFileSync(path, content, 'utf8');
  console.log(`[PAN Evolution] Updated ${name}.md v${newVersion} (${diff.length} chars diff)`);
  return true;
}

// Simple line-level diff
function computeDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diffs = [];

  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] !== newLines[i]) {
      if (oldLines[i] && !newLines[i]) diffs.push(`-${i + 1}: ${oldLines[i]}`);
      else if (!oldLines[i] && newLines[i]) diffs.push(`+${i + 1}: ${newLines[i]}`);
      else diffs.push(`~${i + 1}: ${oldLines[i]} → ${newLines[i]}`);
    }
  }
  return diffs.join('\n');
}

// Get all config files (excluding constitution)
function getEvolvableConfigs() {
  const configs = {};
  if (!existsSync(CONFIG_DIR)) return configs;

  for (const file of readdirSync(CONFIG_DIR)) {
    if (!file.endsWith('.md') || IMMUTABLE_FILES.includes(file)) continue;
    const name = file.replace('.md', '');
    configs[name] = readFileSync(join(CONFIG_DIR, file), 'utf8');
  }
  return configs;
}

// === STEP 1: OBSERVE ===
async function observe(events) {
  const observations = {
    corrections: [],
    preferences: [],
    errors: [],
    successes: [],
    patterns: [],
  };

  for (const e of events) {
    let data = {};
    try { data = JSON.parse(e.data); } catch { continue; }

    if (e.event_type === 'UserPromptSubmit') {
      const prompt = (data.prompt || '').toLowerCase();
      // Detect corrections
      if (/\b(no|wrong|don't|stop|not that|fix|broken|bug)\b/.test(prompt)) {
        observations.corrections.push({
          text: data.prompt,
          timestamp: e.created_at,
          sessionId: e.session_id,
        });
      }
      // Detect preferences
      if (/\b(prefer|want|always|never|make sure|from now on)\b/.test(prompt)) {
        observations.preferences.push({
          text: data.prompt,
          timestamp: e.created_at,
        });
      }
    }

    if (e.event_type === 'Stop') {
      if (data.stop_reason === 'error' || data.num_turns === 0) {
        observations.errors.push({
          error: data.error || data.last_assistant_message?.slice(0, 200) || 'unknown',
          timestamp: e.created_at,
          sessionId: e.session_id,
        });
      } else if (data.stop_reason === 'end_turn') {
        observations.successes.push({
          summary: data.last_assistant_message?.slice(0, 150) || '',
          timestamp: e.created_at,
        });
      }
    }

    if (e.event_type === 'RouterCommand') {
      const isError = !!data.error;
      if (isError) {
        observations.errors.push({
          error: `Voice command failed: ${data.text} → ${data.error}`,
          timestamp: e.created_at,
        });
      }
    }
  }

  return observations;
}

// === STEP 2: CRITIQUE ===
async function critique(observations, configs) {
  if (observations.corrections.length === 0 && observations.errors.length === 0 &&
      observations.preferences.length === 0) {
    return { assessment: 'no_issues', suggestions: [] };
  }

  const prompt = `You are PAN's self-assessment system. Review these observations and critique PAN's current behavior.

CURRENT CONFIG:
${Object.entries(configs).map(([name, content]) => `### ${name}\n${content}`).join('\n\n')}

OBSERVATIONS:
Corrections (user told PAN it was wrong):
${observations.corrections.map(c => `- [${c.timestamp}] ${c.text}`).join('\n') || 'None'}

Errors:
${observations.errors.map(e => `- [${e.timestamp}] ${e.error}`).join('\n') || 'None'}

Preferences (user stated what they want):
${observations.preferences.map(p => `- [${p.timestamp}] ${p.text}`).join('\n') || 'None'}

Successes: ${observations.successes.length} successful interactions

CRITIQUE what went wrong and what should change. Return JSON:
{
  "assessment": "brief overall assessment",
  "suggestions": [
    {"file": "config file name", "action": "append|replace|remove", "target": "section or line to modify", "content": "new content", "reason": "why this change"}
  ]
}

Rules:
- NEVER suggest modifying constitution.md
- Only suggest changes that address observed problems
- Be conservative — don't change what's working
- Each suggestion should be atomic (one change per suggestion)
- Return ONLY JSON`;

  try {
    const result = await claude(prompt, { model: 'claude-haiku-4-5-20251001', maxTokens: 2000, timeout: 45000, caller: 'evolution-critique' });
    return JSON.parse(result);
  } catch (err) {
    console.error('[PAN Evolution] Critique failed:', err.message);
    return { assessment: 'critique_failed', suggestions: [] };
  }
}

// === STEP 3: GENERATE DELTAS ===
function generateDeltas(critiqueResult, configs) {
  const deltas = [];

  for (const suggestion of critiqueResult.suggestions || []) {
    if (IMMUTABLE_FILES.includes(`${suggestion.file}.md`)) continue;
    if (!suggestion.content || !suggestion.file) continue;

    const currentContent = configs[suggestion.file] || '';

    let newContent;
    if (suggestion.action === 'append') {
      newContent = currentContent.trimEnd() + '\n\n' + suggestion.content + '\n';
    } else if (suggestion.action === 'replace' && suggestion.target) {
      newContent = currentContent.replace(suggestion.target, suggestion.content);
      if (newContent === currentContent) {
        // Target not found — append instead
        newContent = currentContent.trimEnd() + '\n\n' + suggestion.content + '\n';
      }
    } else if (suggestion.action === 'remove' && suggestion.target) {
      newContent = currentContent.replace(suggestion.target, '').replace(/\n{3,}/g, '\n\n');
    } else {
      continue;
    }

    deltas.push({
      file: suggestion.file,
      oldContent: currentContent,
      newContent,
      reason: suggestion.reason,
    });
  }

  return deltas;
}

// === STEP 4: VALIDATE ===
function validate(deltas, configs) {
  const results = [];

  for (const delta of deltas) {
    const gates = {
      constitution: true,
      sizeLimit: true,
      noRegression: true,
      contentSafety: true,
    };

    // Gate 1: Constitution check — never modify immutable files
    if (IMMUTABLE_FILES.includes(`${delta.file}.md`)) {
      gates.constitution = false;
    }

    // Gate 2: Size limit — config files shouldn't grow unbounded
    if (delta.newContent.length > 10000) {
      gates.sizeLimit = false;
    }

    // Gate 3: No regression — new content shouldn't be empty or drastically shorter
    if (delta.newContent.trim().length < 20) {
      gates.noRegression = false;
    }
    if (delta.oldContent.length > 100 && delta.newContent.length < delta.oldContent.length * 0.3) {
      gates.noRegression = false; // lost more than 70% of content
    }

    // Gate 4: Content safety — no secrets, no dangerous commands
    const dangerPatterns = [/sk-ant-/i, /password\s*[:=]/i, /rm\s+-rf/i, /DROP\s+TABLE/i];
    for (const pattern of dangerPatterns) {
      if (pattern.test(delta.newContent)) {
        gates.contentSafety = false;
        break;
      }
    }

    const passed = Object.values(gates).every(v => v);
    results.push({ ...delta, gates, passed });
  }

  return results;
}

// === STEP 5: APPLY ===
function apply(validatedDeltas) {
  const applied = [];

  for (const delta of validatedDeltas) {
    if (!delta.passed) {
      console.log(`[PAN Evolution] Rejected change to ${delta.file}: ${JSON.stringify(delta.gates)}`);
      continue;
    }

    const success = writeConfig(delta.file, delta.newContent, delta.gates);
    if (success) {
      applied.push(delta.file);
    }
  }

  return applied;
}

// === STEP 6: CONSOLIDATE (periodic) ===
async function consolidateObservations() {
  // This runs less frequently — compresses accumulated observations into principles
  // Also triggers memory consolidation
  await consolidateMemory({ useLLM: true });
}

// === MAIN PIPELINE ===
async function evolve() {
  console.log('[PAN Evolution] Starting evolution cycle...');

  try {
    // Get events since last evolution
    const lastEvolution = get("SELECT MAX(created_at) as t FROM evolution_versions");
    const since = lastEvolution?.t || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const events = all(
      `SELECT id, session_id, event_type, data, created_at FROM events
       WHERE created_at > :since
       AND event_type IN ('UserPromptSubmit', 'Stop', 'RouterCommand', 'VisionAnalysis')
       ORDER BY created_at ASC LIMIT 200`,
      { ':since': since }
    );

    if (events.length < 5) {
      console.log(`[PAN Evolution] Only ${events.length} events — skipping evolution`);
      return { status: 'skipped', reason: 'insufficient_events' };
    }

    // Step 1: Observe
    const observations = await observe(events);
    console.log(`[PAN Evolution] Observed: ${observations.corrections.length} corrections, ${observations.errors.length} errors, ${observations.preferences.length} preferences`);

    // Skip if nothing interesting happened
    if (observations.corrections.length === 0 && observations.errors.length === 0 &&
        observations.preferences.length === 0) {
      console.log('[PAN Evolution] Nothing to evolve — all quiet');
      // Still consolidate memory even if no config changes
      await consolidateMemory({ useLLM: false });
      return { status: 'skipped', reason: 'no_observations' };
    }

    // Step 2: Critique
    const configs = getEvolvableConfigs();
    const critiqueResult = await critique(observations, configs);
    console.log(`[PAN Evolution] Critique: ${critiqueResult.assessment} (${critiqueResult.suggestions?.length || 0} suggestions)`);

    // Step 3: Generate deltas
    const deltas = generateDeltas(critiqueResult, configs);
    console.log(`[PAN Evolution] Generated ${deltas.length} deltas`);

    // Step 4: Validate
    const validated = validate(deltas, configs);
    const passedCount = validated.filter(v => v.passed).length;
    console.log(`[PAN Evolution] Validated: ${passedCount}/${validated.length} passed`);

    // Step 5: Apply
    const applied = apply(validated);
    console.log(`[PAN Evolution] Applied ${applied.length} changes: ${applied.join(', ') || 'none'}`);

    // Step 6: Consolidate memory
    const memoryResult = await consolidateMemory({ useLLM: true });

    // Log the evolution cycle
    logEvent('system-evolution', 'EvolutionCycle', {
      events_reviewed: events.length,
      observations: {
        corrections: observations.corrections.length,
        errors: observations.errors.length,
        preferences: observations.preferences.length,
        successes: observations.successes.length,
      },
      critique: critiqueResult.assessment,
      deltas_generated: deltas.length,
      deltas_passed: passedCount,
      applied,
      memory: memoryResult,
      timestamp: Date.now(),
    });

    return {
      status: 'completed',
      applied,
      observations: {
        corrections: observations.corrections.length,
        errors: observations.errors.length,
        preferences: observations.preferences.length,
      },
      memory: memoryResult,
    };
  } catch (err) {
    console.error('[PAN Evolution] Pipeline error:', err.message);
    return { status: 'error', error: err.message };
  }
}

// Get evolution history
function getHistory(limit = 20) {
  return all(
    `SELECT * FROM evolution_versions ORDER BY created_at DESC LIMIT :limit`,
    { ':limit': limit }
  );
}

// Rollback a config file to a previous version
function rollback(configFile, toVersion) {
  const version = get(
    `SELECT * FROM evolution_versions WHERE config_file = :file AND version = :version`,
    { ':file': configFile, ':version': toVersion }
  );
  if (!version) return false;

  writeConfig(configFile, version.content, { rollback: true, from_version: toVersion });
  console.log(`[PAN Evolution] Rolled back ${configFile} to v${toVersion}`);
  return true;
}

export { evolve, getHistory, rollback, readConfig, getEvolvableConfigs };

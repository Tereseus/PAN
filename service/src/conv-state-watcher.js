// Conv-State Watcher — sibling of webcam-watcher / screen-watcher, but stream-paced.
//
// Purpose: maintain a per-org "Conversation State" doc that the router can
// read on every turn WITHOUT having to think about the full conversation
// itself. Solves the endpointing problem (#NEW-???) — instead of relying
// on silence timers or regex to decide "is the user done talking?", the
// router gets a precomputed snapshot of:
//
//   • current topic              ("PAN endpointing design")
//   • phase                       ("discussing options" | "wrapping up" | "command")
//   • pending question PAN asked  ("which option A/B/C/D?")
//   • user phrasing tempo         ("verbose, self-correcting, long pauses mid-thought")
//   • recent partials (last ~5)   raw STT fragments
//   • last complete utterance     timestamp + text
//
// Cadence: not on a fixed timer like intuition. Re-distills:
//   1. ~500ms after each Final  (debounced — turn settled)
//   2. Every 30s if any partial activity since last distill (idle fallback)
//
// Why separate from intuition: intuition is ambient (where/who/mood, 30-60s
// cadence). Conv-state is utterance-paced (sub-second on Finals). Different
// clocks. But conv-state IS conceptually part of "what PAN knows right now"
// — so the router reads it through the same getCurrentSnapshot() merge.
//
// Storage: in-memory ring buffer per orgId. No DB writes in v1 — the
// distilled state lives only in RAM. Survives Craft swaps (Carrier holds
// nothing voice-related). Persistence to `conversation_states` table can
// come later if we need replay/Atlas timeline.
//
// AI: cerebras qwen via askAI(caller='conv-state'). One small call,
// ~200-400ms. Configurable via `job_models.conv-state` setting.

import { askAI } from './llm.js';

// orgId → { utterances: [...], state: {...}, distilling: bool, distillTimer, lastDistillAt }
const _orgs = new Map();

const MAX_UTTERANCES = 20;          // ring buffer size per org
const DEBOUNCE_AFTER_FINAL_MS = 500;
const IDLE_REDISTILL_MS = 30_000;
const DISTILL_MAX_TOKENS = 250;
const DISTILL_TIMEOUT_MS = 8000;

let _idleTimer = null;
let _started = false;

function _orgSlot(orgId) {
  const key = orgId || 'org_personal';
  let slot = _orgs.get(key);
  if (!slot) {
    slot = {
      orgId: key,
      utterances: [],
      state: null,            // distilled blob (see below)
      distilling: false,
      distillTimer: null,
      lastDistillAt: 0,
      lastUtteranceAt: 0,
    };
    _orgs.set(key, slot);
  }
  return slot;
}

/**
 * Public hook: called by /api/v1/voice/result, /api/v1/chat, phone STT pipe,
 * or anywhere an STT partial/final is observed.
 *
 *   noteUtterance({ orgId, text, isFinal, source, deviceId })
 *
 * Triggers a debounced distill ~500ms after each Final. Partials just
 * append to the buffer (cheap) so the next distill has them.
 */
export function noteUtterance({ orgId = 'org_personal', text, isFinal = true, source = 'unknown', deviceId = null } = {}) {
  if (!text || typeof text !== 'string') return;
  const trimmed = text.trim();
  if (!trimmed) return;

  const slot = _orgSlot(orgId);
  slot.utterances.push({
    text: trimmed.slice(0, 500),
    isFinal: !!isFinal,
    source,
    deviceId,
    at: Date.now(),
  });
  // Ring trim
  if (slot.utterances.length > MAX_UTTERANCES) {
    slot.utterances.splice(0, slot.utterances.length - MAX_UTTERANCES);
  }
  slot.lastUtteranceAt = Date.now();

  // Only Finals trigger a distill. Partials accumulate.
  if (isFinal) {
    if (slot.distillTimer) clearTimeout(slot.distillTimer);
    slot.distillTimer = setTimeout(() => {
      slot.distillTimer = null;
      _distill(orgId).catch(err => {
        console.warn('[conv-state] distill failed:', err?.message || err);
      });
    }, DEBOUNCE_AFTER_FINAL_MS);
  }
}

/**
 * Build the prompt and call cerebras. Returns the merged state on the slot.
 * Single-flight per org — if already distilling, skip this call (the
 * in-flight one will pick up the new utterances since it reads the buffer
 * after the call returns).
 */
async function _distill(orgId) {
  const slot = _orgSlot(orgId);
  if (slot.distilling) return slot.state;
  slot.distilling = true;
  const startedAt = Date.now();

  // Lazy import to avoid pulling intuition into the module graph until
  // first distill (cold-start hygiene — server boot stays light).
  let snapshot = null;
  try {
    const intuition = await import('./intuition.js');
    snapshot = intuition.getCurrentSnapshot ? intuition.getCurrentSnapshot(orgId) : null;
  } catch {}

  // Recent thoughts (mind context) — optional, best-effort.
  let recentThoughts = [];
  try {
    const thoughts = await import('./thoughts.js');
    if (thoughts.recentThoughts) {
      recentThoughts = thoughts.recentThoughts({ orgId, limit: 6 }) || [];
    }
  } catch {}

  // Build prompt
  const recent = slot.utterances.slice(-12);
  const partials = recent.filter(u => !u.isFinal).map(u => `(partial) ${u.text}`);
  const finals = recent.filter(u => u.isFinal).map(u => u.text);

  const situationLine = snapshot
    ? `Where: ${snapshot.where || '?'} · Activity: ${snapshot.activity || '?'} · Focus: ${snapshot.focus || '?'} · Mood: ${snapshot.mood || '?'}`
    : '(no intuition snapshot yet)';

  const thoughtsLine = recentThoughts.length
    ? recentThoughts.map(t => `[${t.source || '?'}] ${t.thought || t.text || ''}`.slice(0, 140)).join('\n')
    : '(no recent thoughts)';

  const prompt = `You are PAN's Conversation State distiller. Reading the recent voice/chat utterances plus ambient context, output a JSON object that captures the live state of the conversation. The router will read this on every turn — it must be terse and accurate.

SITUATION
${situationLine}

RECENT THOUGHTS
${thoughtsLine}

RECENT UTTERANCES (oldest → newest, ${finals.length} final, ${partials.length} partial)
${finals.map((t, i) => `${i + 1}. ${t}`).join('\n') || '(none)'}
${partials.length ? '\nIN-FLIGHT PARTIALS:\n' + partials.join('\n') : ''}

Output strict JSON (no prose, no markdown fences) with these fields:
{
  "topic": "one short noun phrase — what the conversation is about right now",
  "phase": "one of: opening | discussing | deciding | command | wrapping_up | idle",
  "pending_question": "if PAN (or commander) asked something not yet answered, the question — else null",
  "user_pattern": "one short clause describing how the user is talking (verbose | terse | self-correcting | long-pauses-mid-thought | etc.)",
  "likely_turn_complete": true/false (does the LAST utterance look like a complete thought, or mid-sentence?),
  "summary": "one sentence — what just happened in this conversation, for the router to ground its reply"
}`;

  let parsed = null;
  let raw = null;
  let err = null;
  try {
    raw = await askAI(prompt, {
      caller: 'conv-state',
      maxTokens: DISTILL_MAX_TOKENS,
      timeout: DISTILL_TIMEOUT_MS,
      source: 'conv-state-watcher',
    });
    // Strip code fences if model added them
    const cleaned = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    err = e?.message || String(e);
  }

  const finishedAt = Date.now();
  slot.state = {
    org_id: orgId,
    topic: parsed?.topic || null,
    phase: parsed?.phase || null,
    pending_question: parsed?.pending_question || null,
    user_pattern: parsed?.user_pattern || null,
    likely_turn_complete: typeof parsed?.likely_turn_complete === 'boolean' ? parsed.likely_turn_complete : null,
    summary: parsed?.summary || null,
    recent_finals: finals.slice(-5),
    recent_partials: partials.slice(-3),
    last_utterance_at: slot.lastUtteranceAt,
    distilled_at: finishedAt,
    latency_ms: finishedAt - startedAt,
    error: err,
  };
  slot.lastDistillAt = finishedAt;
  slot.distilling = false;
  return slot.state;
}

/**
 * Router (and dashboard) read this. Cheap — pure in-memory.
 * Returns null if no utterances have been observed for this org yet.
 */
export function getConversationState(orgId = 'org_personal') {
  const slot = _orgs.get(orgId || 'org_personal');
  if (!slot) return null;
  return slot.state;
}

/**
 * Inspect — returns the raw ring buffer for debugging.
 */
export function getConversationBuffer(orgId = 'org_personal') {
  const slot = _orgs.get(orgId || 'org_personal');
  if (!slot) return [];
  return slot.utterances.slice();
}

/**
 * List active orgs (have buffers).
 */
export function listActiveOrgs() {
  return Array.from(_orgs.keys());
}

/**
 * Start the idle redistill timer. Doesn't poll constantly — only fires
 * if there have been utterances since the last distill.
 */
export function startConvStateWatcher() {
  if (_started) return;
  _started = true;
  _idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [orgId, slot] of _orgs.entries()) {
      if (slot.distilling) continue;
      if (slot.lastUtteranceAt <= slot.lastDistillAt) continue; // nothing new
      if ((now - slot.lastUtteranceAt) < IDLE_REDISTILL_MS) continue; // still hot, debounce handles it
      _distill(orgId).catch(() => {});
    }
  }, IDLE_REDISTILL_MS);
  if (_idleTimer.unref) _idleTimer.unref();
  console.log('[conv-state] watcher started (idle redistill every 30s, debounce 500ms after Final)');
}

export function stopConvStateWatcher() {
  if (_idleTimer) clearInterval(_idleTimer);
  _idleTimer = null;
  _started = false;
  for (const slot of _orgs.values()) {
    if (slot.distillTimer) clearTimeout(slot.distillTimer);
    slot.distillTimer = null;
  }
}

export function getConvStateStatus() {
  const orgs = [];
  for (const [orgId, slot] of _orgs.entries()) {
    orgs.push({
      org_id: orgId,
      utterance_count: slot.utterances.length,
      last_utterance_at: slot.lastUtteranceAt,
      last_distill_at: slot.lastDistillAt,
      distilling: slot.distilling,
      state: slot.state,
    });
  }
  return { started: _started, orgs };
}

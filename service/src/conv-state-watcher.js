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
//   1. on each Final, at once (rules, well under a millisecond)
//   2. every 30s if partials arrived since the last distill (idle fallback)
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
// No AI (2026-11-03). The distill was a model call after every answered turn (gemma4:e2b on
// the hub's CPU, the one the voice turn needs, with a summary that could invent things). It
// is now intuition/conversation.js: rules over the lines themselves, same fields, plus the
// last few topics, the things just named, and his tone.

import { readConversation } from './intuition/conversation.js';

// orgId → { utterances: [...], state: {...}, lastDistillAt, lastUtteranceAt }
const _orgs = new Map();

const MAX_UTTERANCES = 20;          // ring buffer size per org
const IDLE_REDISTILL_MS = 30_000;
const IDLE_PHASE_MS = 5 * 60_000;   // read as idle after this long with nothing said

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
 * Every Final is distilled at once. Partials just append to the buffer so the next distill
 * has them.
 */
// `distill` is kept for the callers: when the distill was a model call, false filed PAN's
// own reply or an overheard line without paying for one. Rules cost nothing, so every Final
// is read; PAN's question is what makes a pending one.
export function noteUtterance({ orgId = 'org_personal', text, isFinal = true, source = 'unknown', deviceId = null, distill = isFinal } = {}) {
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
  if (isFinal) _distill(orgId);
}

/**
 * Read the buffer into the conversation state (intuition/conversation.js). Synchronous: rules
 * over at most 20 lines. The previous state carries the topic's start and the topic history.
 */
function _distill(orgId) {
  const slot = _orgSlot(orgId);
  const startedAt = Date.now();
  let read = null;
  let err = null;
  try {
    read = readConversation({ utterances: slot.utterances, prev: slot.state, now: startedAt });
  } catch (e) {
    err = e?.message || String(e);
    console.warn('[conv-state] distill failed:', err);
  }

  // Voice turns label who spoke: PAN's replies, speech PAN overheard and let pass, and what
  // he was dictating to Claude (noteClaudePrompt).
  const recent = slot.utterances.slice(-12);
  const partials = recent.filter(u => !u.isFinal).map(u => `(partial) ${u.text}`);
  const finals = recent.filter(u => u.isFinal).map(u =>
    u.toClaude ? `(to Claude on his computer, not to PAN) ${u.text}`
      : u.source === 'pan' ? `PAN: ${u.text}` : u.source === 'room' ? `(overheard, not to PAN) ${u.text}` : u.text);

  const finishedAt = Date.now();
  const kept = read || slot.state || {};
  slot.state = {
    ...kept,
    org_id: orgId,
    recent_finals: finals.slice(-5),
    recent_partials: partials.slice(-3),
    last_utterance_at: slot.lastUtteranceAt,
    distilled_at: finishedAt,
    latency_ms: finishedAt - startedAt,
    reader: 'rules',
    error: err,
  };
  slot.lastDistillAt = finishedAt;
  return slot.state;
}

// ── Speech meant for Claude ─────────────────────────────────────────────────
// He dictates to Claude on the laptop with the phone in his pocket, so the phone hears
// every word, and PAN answered what he was telling Claude (2026-11-03). Nothing in the
// words says who they were for. The prompt that reaches Claude a moment later does: when
// a UserPromptSubmit carries most of the words of a line the phone heard in the last few
// minutes, he was talking to Claude, and for the next few minutes PAN stays quiet unless
// he says its name (router.js). Each matching prompt extends the window.
const CLAUDE_MATCH_WINDOW_MS = 4 * 60_000;
const CLAUDE_DICTATION_HOLD_MS = 8 * 60_000;
const STOPWORDS = new Set(('the and you that this for are was with have but not what can all just its '
  + 'it\'s i\'m don\'t then there they them their about would could should will your from been were '
  + 'when where which how why who also some like into than out get got one now yeah okay').split(' '));
let _claudeDictation = { at: 0, until: 0, lines: 0 };

function _contentWords(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/** hooks.js calls this with every Claude prompt. Returns how many heard lines it matched. */
export function noteClaudePrompt(text, orgId = 'org_personal') {
  const prompt = new Set(_contentWords(text));
  if (prompt.size < 3) return 0;
  const slot = _orgs.get(orgId || 'org_personal');
  if (!slot) return 0;
  const since = Date.now() - CLAUDE_MATCH_WINDOW_MS;
  let n = 0;
  for (const u of slot.utterances) {
    if (u.at < since || !u.isFinal || (u.source !== 'him' && u.source !== 'room')) continue;
    const words = _contentWords(u.text);
    if (words.length < 3) continue;
    // Half the content words, not all: the phone and Claude's dictation mishear differently.
    if (words.filter(w => prompt.has(w)).length / words.length >= 0.5) { u.toClaude = true; n++; }
  }
  if (n) {
    _claudeDictation = { at: Date.now(), until: Date.now() + CLAUDE_DICTATION_HOLD_MS, lines: n };
    console.log(`[conv-state] ${n} heard line(s) went to Claude: quiet unless named for ${CLAUDE_DICTATION_HOLD_MS / 60_000} min`);
  }
  return n;
}

/** Non-null while he is dictating to Claude: { at, until, lines }. */
export function dictatingToClaude() {
  return Date.now() < _claudeDictation.until ? _claudeDictation : null;
}

/** True if PAN said something to him in the last `ms`. Replies to lines that turned out to
 *  be for Claude do not count: those were PAN talking over his dictation. */
export function panSpokeWithin(ms, orgId = 'org_personal') {
  const slot = _orgs.get(orgId || 'org_personal');
  if (!slot) return false;
  const now = Date.now();
  return slot.utterances.some(u => u.source === 'pan' && now - u.at < ms && u.at > _claudeDictation.at);
}

/** Lines PAN let pass in the last `ms`, minus his dictation to Claude: other people talking,
 *  the TV, or him talking to someone else. */
export function overheardWithin(ms, orgId = 'org_personal') {
  const slot = _orgs.get(orgId || 'org_personal');
  if (!slot) return 0;
  const now = Date.now();
  return slot.utterances.filter(u => u.source === 'room' && !u.toClaude && now - u.at < ms).length;
}

/**
 * Router (and dashboard) read this. Cheap — pure in-memory.
 * Returns null if no utterances have been observed for this org yet.
 */
export function getConversationState(orgId = 'org_personal') {
  const slot = _orgs.get(orgId || 'org_personal');
  if (!slot) return null;
  // Nothing new comes in to re-read a conversation that stopped, so idle is read here.
  if (slot.state && Date.now() - slot.lastUtteranceAt > IDLE_PHASE_MS && slot.state.phase !== 'idle') {
    return { ...slot.state, phase: 'idle', pending_question: null };
  }
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
      if (slot.lastUtteranceAt <= slot.lastDistillAt) continue; // nothing new
      if ((now - slot.lastUtteranceAt) < IDLE_REDISTILL_MS) continue; // still coming in
      _distill(orgId);   // synchronous, catches its own errors
    }
  }, IDLE_REDISTILL_MS);
  if (_idleTimer.unref) _idleTimer.unref();
  console.log('[conv-state] watcher started (rules, read on every Final; partials re-read every 30s)');
}

export function stopConvStateWatcher() {
  if (_idleTimer) clearInterval(_idleTimer);
  _idleTimer = null;
  _started = false;
}

export function getConvStateStatus() {
  const orgs = [];
  for (const [orgId, slot] of _orgs.entries()) {
    orgs.push({
      org_id: orgId,
      utterance_count: slot.utterances.length,
      last_utterance_at: slot.lastUtteranceAt,
      last_distill_at: slot.lastDistillAt,
      distilling: false,
      state: getConversationState(orgId),
    });
  }
  return { started: _started, orgs };
}

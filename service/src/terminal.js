// PAN Terminal — WebSocket-backed PTY sessions
// Spawns real shell processes, streams I/O to dashboard via WebSocket.
// Each project gets its own terminal session. Phone can switch between them.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
import { WebSocketServer, WebSocket } from 'ws';
import { hostname, homedir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { all, insert, get, run } from './db.js';
import { injectSessionContext } from './routes/hooks.js';
import { subscribeToTranscript, writeSystemEvent } from './transcript-watcher.js';
import { captureInput, captureOutput, subscribeToSession, writeSystemMessage, flushSession, destroySession, readTranscript, setSessionName, renameTranscript } from './pty-transcript.js';
import { getTerminalLogDir, getShell, getDataDir } from './platform.js';
import { createAlert } from './routes/dashboard.js';
import { ClaudeAdapter } from './llm-adapter-claude.js';
import { GeminiAdapter } from './llm-adapter-gemini.js';
// ScreenBuffer is needed by BOTH the browser WS terminal server AND pipe-mode
// sessions (createPipeSession → new ScreenBufferClass). It used to be lazy-
// loaded inside startTerminalServer(), which meant the phone's pipe path
// silently depended on the browser terminal server having started. The
// `wearable` profile gates that WS server off (terminal_server flag), so we
// load it up front here — pipe mode then stands on its own. screen-buffer.js is
// side-effect-free (pure class defs), so eager loading is free.
import { ScreenBuffer } from './screen-buffer.js';

// Terminal log directory — persists ScreenBuffer logs across server restarts
const TERMINAL_LOG_DIR = getTerminalLogDir();
try { mkdirSync(TERMINAL_LOG_DIR, { recursive: true }); } catch {}

// Active terminal sessions: Map<sessionId, { pty, term, clients, ... }>
const sessions = new Map();

// Crash history for ConPTY fallback + backoff: Map<sessionId, { code, at, count }>
const ptySessionCrashMap = new Map();

// Windows STATUS_FATAL_APP_EXIT — ConPTY/node-pty hard abort
const STATUS_FATAL_APP_EXIT = -1073741510;

// Cap per-session transcript messages to prevent memory leak
const MAX_STREAM_MESSAGES = 500;

// Send a message to a session's LLM adapter.
// Uses the Agent SDK (no PTY, no subprocess, no TUI).
function pipeSend(sessionId, userText) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error(`[PAN LLM] Session not found: ${sessionId}`);
    return false;
  }
  userText = (userText || '').trim();
  if (!userText) return false;

  // Create adapter on first use — uses the configured provider (Claude vs Gemini vs others)
  if (!session._llmAdapter) {
    // 1. Determine provider from settings
    let provider = 'claude';
    try {
      const row = get("SELECT value FROM settings WHERE key = 'terminal_ai_provider'");
      if (row) provider = row.value.replace(/^"|"$/g, '').toLowerCase() || 'claude';
    } catch {}

    // Always resume the last Claude session if one exists — even after a PTY restart or
    // adapter reset. If the session was mid-tool-call, the adapter's no_output fallback
    // will emit a banner and clear claudeSessionId so the NEXT send starts fresh cleanly.
    // Previously _sessionFresh blocked resume when session.messages was empty, but that
    // caused the broken-adapter recovery path to silently lose all context.
    const resumeId = session.claudeSessionIds?.length
      ? session.claudeSessionIds[session.claudeSessionIds.length - 1]
      : null;

    // 2. Instantiate the correct adapter
    let _adapterMsgCount = 0; // tracks how many adapter messages we've already appended
    const onMessage = (messages, trimOffset = 0) => {
      // Always resolve the LIVE session from the Map — never use the closed-over `session`
      // reference for writes. If sessions.set() was called (e.g. after PTY respawn or adapter
      // reset) the closed-over reference would be stale and all appends would go to an orphaned
      // object that the API never reads. Using sessions.get() here is the root-cause fix for
      // the session.messages freeze bug.
      const live = sessions.get(sessionId);
      if (!live) return; // session was cleaned up — discard
      // Append only new messages since last callback — adapter passes its full array each time.
      // trimOffset > 0 means the adapter trimmed old messages from the front — adjust counter
      // so we don't skip new messages that landed after the trim.
      if (trimOffset > 0) {
        _adapterMsgCount = Math.max(0, _adapterMsgCount - trimOffset);
      }
      live.lastOutputTs = Date.now();
      const adapterBusy = live._llmAdapter?.busy || false;
      live.claudeRunning = adapterBusy; // legacy compat
      if (adapterBusy) {
        transitionState(live, SessionState.WORKING, 'adapter onMessage busy');
      } else {
        // Adapter finished — transition back to IDLE so the next send isn't blocked.
        // This is a belt-and-suspenders recovery alongside the .then()/.catch() below.
        transitionState(live, SessionState.IDLE, 'adapter onMessage idle');
      }
      const newMsgs = messages.slice(_adapterMsgCount);
      _adapterMsgCount = messages.length;
      for (const msg of newMsgs) {
        appendMessage(live, { ...msg, source: 'adapter' });
      }
      // Persist the session ID back to the session + token (for resume)
      const csid = live._llmAdapter?.getSessionId?.();
      if (csid && !(live.claudeSessionIds || []).includes(csid)) {
        live.claudeSessionIds = [...(live.claudeSessionIds || []), csid];
        for (const c of live.clients) {
          if (c._reconnectToken) updateTokenClaudeSessions(c._reconnectToken, live.claudeSessionIds);
        }
      }
    };

    if (provider === 'gemini') {
      session._llmAdapter = new GeminiAdapter(sessionId, session.cwd, onMessage, resumeId);
      console.log(`[PAN LLM] Created Gemini adapter for session ${sessionId}`);
    } else {
      // Default to Claude (built-in SDK)
      session._llmAdapter = new ClaudeAdapter(sessionId, session.cwd, onMessage, resumeId);
      console.log(`[PAN LLM] Created Claude adapter for session ${sessionId}`);
    }

    // Apply model preference for this adapter:
    //   1. Prefer the per-session override (session.model) — set by the dashboard's
    //      tab dropdown via pipeSetModel. This is what makes each tab independent.
    //   2. Fall back to the global terminal_ai_model setting (default for new tabs).
    try {
      let savedModel = null;
      if (session.model) {
        savedModel = session.model;
      } else {
        const modelRow = get("SELECT value FROM settings WHERE key = 'terminal_ai_model'");
        if (modelRow) savedModel = modelRow.value.replace(/^"|"$/g, '').trim() || null;
      }
      if (savedModel) {
        session._llmAdapter.setModel(savedModel);
        console.log(`[PAN LLM] Applied model preference: ${savedModel} (per-session=${!!session.model})`);
      }
    } catch {}
  }

  session.claudeRunning = true; // legacy compat
  session.pipeMode = true;      // legacy compat
  // If stuck in INTERRUPTED, recover to IDLE first so WORKING transition is legal
  if (session.state === SessionState.INTERRUPTED) {
    transitionState(session, SessionState.IDLE, 'pipeSend recovery from INTERRUPTED');
  }
  transitionState(session, SessionState.WORKING, 'pipeSend start');
  session._llmAdapter.send(userText)
    .then(() => {
      const live = sessions.get(sessionId);
      if (!live) return;
      live.claudeRunning = false; // legacy compat
      transitionState(live, SessionState.IDLE, 'pipeSend complete');
      // Log adapter exit to DB so we can diagnose future silent deaths
      const exitReason = live._llmAdapter?.lastExitReason || 'natural';
      const isAbnormal = exitReason.startsWith('timeout') || exitReason.startsWith('error') || exitReason === 'no_output';
      try {
        insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
          ':sid': sessionId,
          ':type': 'AdapterExit',
          ':data': JSON.stringify({
            session_id: sessionId,
            project: live.project,
            exit_reason: exitReason,
            abnormal: isAbnormal,
            claude_session_id: live._llmAdapter?.claudeSessionId || null,
            total_cost: live._llmAdapter?.totalCost || 0,
            timestamp: Date.now(),
          }),
        });
      } catch {}
      // Notify ready
      for (const c of live.clients) {
        if (c.readyState === WebSocket.OPEN) {
          try { c.send(JSON.stringify({ type: 'pipe_ready' })); } catch {}
        }
      }
      // Drain any pending completion callbacks (e.g. delegateToPhoneToolsSession
      // registers a panNotify hook so the phone hears the result).
      drainPipeCompleteCallbacks(live, null);
    })
    .catch((err) => {
      const live = sessions.get(sessionId);
      if (!live) return;
      // Send failed — must return to IDLE or the session is stuck WORKING forever
      live.claudeRunning = false; // legacy compat
      console.error(`[PAN LLM] pipeSend error for ${sessionId}: ${err?.message}`);
      transitionState(live, SessionState.IDLE, `pipeSend error: ${err?.message}`);
      // Log to DB
      try {
        insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
          ':sid': sessionId,
          ':type': 'AdapterExit',
          ':data': JSON.stringify({
            session_id: sessionId,
            project: live.project,
            exit_reason: `pipeSend_error:${err?.message?.substring(0, 120)}`,
            abnormal: true,
            claude_session_id: live._llmAdapter?.claudeSessionId || null,
            timestamp: Date.now(),
          }),
        });
      } catch {}
      // Notify clients of the error so the UI can recover
      for (const c of live.clients) {
        if (c.readyState === WebSocket.OPEN) {
          try { c.send(JSON.stringify({ type: 'error', message: `Send failed: ${err?.message}` })); } catch {}
        }
      }
      drainPipeCompleteCallbacks(live, err);
    });
  return true;
}

// One-shot pipe-complete callback queue. Used by delegateToPhoneToolsSession
// (and any other caller that needs to react to "this specific send finished").
// Callbacks receive (err) — null on success, Error on failure.
function drainPipeCompleteCallbacks(session, err) {
  const queue = session._onPipeComplete;
  if (!queue || queue.length === 0) return;
  session._onPipeComplete = [];
  for (const cb of queue) {
    try { cb(err); }
    catch (e) { console.error('[PAN LLM] _onPipeComplete callback threw:', e?.message); }
  }
}

// Phone → headless Claude session delegate (task #453).
// Picks a target session and pipeSend()s the user's text into its LLM adapter.
// Lookup order:
//   1. settings.phone_tools_session_id (explicit user choice in dashboard)
//   2. most-recent session by lastInputTs (fall back to createdAt)
// Returns { ok, sessionId, reason? }. Fire-and-forget for the caller — the
// phone gets an immediate ack from the router. When the adapter finishes,
// drainPipeCompleteCallbacks() fires our hook which panNotify()s the user
// with the assistant's final response so the phone hears the result.
function delegateToPhoneToolsSession(userText) {
  let sessionId = null;
  try {
    const row = get("SELECT value FROM settings WHERE key = 'phone_tools_session_id'");
    if (row) sessionId = (row.value || '').replace(/^"|"$/g, '').trim() || null;
  } catch {}

  // Configured but stale — fall through to auto-pick
  if (sessionId && !sessions.has(sessionId)) sessionId = null;

  if (!sessionId) {
    let best = null;
    for (const [id, s] of sessions) {
      const score = s.lastInputTs || s.createdAt || 0;
      if (!best || score > best.score) best = { id, score };
    }
    sessionId = best?.id || null;
  }

  if (!sessionId) return { ok: false, reason: 'no_session' };

  const session = sessions.get(sessionId);
  // Snapshot baseline message count BEFORE pipeSend so the completion hook
  // knows which messages were produced by THIS request vs prior history.
  const baselineMsgCount = (session.messages || []).length;

  // Register the completion hook BEFORE pipeSend so there's no race where the
  // adapter resolves before our callback is queued. drainPipeCompleteCallbacks
  // runs in pipeSend's .then()/.catch() once the adapter is idle.
  session._onPipeComplete = session._onPipeComplete || [];
  session._onPipeComplete.push(async (err) => {
    try {
      if (err) {
        const { panNotify } = await import('./pan-notify.js');
        panNotify('Π · ⚡',
          `Task failed: "${userText.slice(0, 80)}"`,
          `The delegated task errored: ${err.message || err}`,
          { severity: 'error', metadata: { delegated: true, sessionId, error: String(err?.message || err) } });
        return;
      }
      // Slice messages produced since this send started, keep only assistant
      // text content (skip tool-use rows, system rows, and user echoes).
      const allMsgs = session.messages || [];
      const newMsgs = allMsgs.slice(baselineMsgCount);
      const assistantText = newMsgs
        .filter(m => m.role === 'assistant' && (m.type === 'text' || !m.type))
        .map(m => (m.text || m.content || '').trim())
        .filter(Boolean)
        .join('\n\n');

      if (!assistantText) return; // nothing to report — adapter produced no text
      const summary = assistantText.length > 1500
        ? assistantText.slice(0, 1500) + '…'
        : assistantText;
      const { panNotify } = await import('./pan-notify.js');
      panNotify('Π · ⚡',
        `✅ Done: "${userText.slice(0, 80)}"`,
        summary,
        { severity: 'info', metadata: { delegated: true, sessionId, originalRequest: userText } });
    } catch (e) {
      console.error('[PAN delegate] completion hook failed:', e?.message);
    }
  });

  const ok = pipeSend(sessionId, userText);
  if (!ok) {
    // Roll back our registered callback — pipeSend never started, so the
    // .then()/.catch() chain that drains it will never fire. Pop the last
    // entry (which is the one we just pushed).
    if (session._onPipeComplete && session._onPipeComplete.length > 0) {
      session._onPipeComplete.pop();
    }
    return { ok: false, reason: 'pipeSend_failed' };
  }
  return { ok: true, sessionId };
}

// Interrupt a session's LLM adapter (Escape key in pipe mode)
function pipeInterrupt(sessionId) {
  const session = sessions.get(sessionId);
  if (!session?._llmAdapter) return false;
  session._llmAdapter.interrupt();
  session.claudeRunning = false; // legacy compat
  transitionState(session, SessionState.INTERRUPTED, 'pipeInterrupt');
  writeSystemMessage(sessionId, 'interrupt', 'Interrupted (Escape)');
  // Immediately return to IDLE — INTERRUPTED is a momentary signal, not a stable resting state.
  // Without this, INTERRUPTED → WORKING is illegal and the next pipeSend would be blocked.
  // The recovery in pipeSend handles the edge case where this timer fires too late.
  setTimeout(() => {
    if (session.state === SessionState.INTERRUPTED) {
      transitionState(session, SessionState.IDLE, 'pipeInterrupt cleanup');
    }
  }, 500);
  return true;
}

// Reset a session's LLM adapter — clears broken state so the NEXT pipeSend creates a fresh
// adapter and resumes from JSONL. Safe to call without restarting PAN or killing the PTY.
// Use this when a session gets stuck (session.messages frozen, claudeRunning stuck, etc.).
function pipeResetAdapter(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.error(`[PAN LLM] pipeResetAdapter: session not found: ${sessionId}`);
    return false;
  }
  console.log(`[PAN LLM] Resetting adapter for session ${sessionId}`);
  // Abort any in-flight query first
  if (session._llmAdapter) {
    try { session._llmAdapter.interrupt?.(); } catch {}
  }
  session._llmAdapter = null;
  session.claudeRunning = false;
  if (session.state === SessionState.WORKING || session.state === SessionState.INTERRUPTED) {
    transitionState(session, SessionState.IDLE, 'pipeResetAdapter');
  }
  // Tell the frontend it can send again
  for (const c of session.clients) {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(JSON.stringify({ type: 'pipe_ready' })); } catch {}
    }
  }
  return true;
}

// Set the model for a session's LLM adapter — takes effect on next message.
// Persists the choice on session.model so:
//   • subsequent adapter creations for the same session honor it
//   • each tab can have its own model without affecting other tabs
//   • the global terminal_ai_model setting is no longer touched per switch
function pipeSetModel(sessionId, modelId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  // Per-session override — survives adapter recreation within this server's lifetime.
  session.model = modelId || null;

  // Pipe mode (Agent SDK): set model on the adapter directly
  if (session._llmAdapter?.setModel) {
    session._llmAdapter.setModel(modelId);
    return true;
  }

  // PTY mode (Claude TUI): send /model command directly into the terminal.
  // Claude Code's /model command switches model in the live session — no restart needed.
  if (session.pty && modelId) {
    // Normalize model name: strip provider prefix if present (e.g. "anthropic:claude-sonnet-4-6" → "claude-sonnet-4-6")
    const modelName = modelId.includes(':') ? modelId.split(':').pop() : modelId;
    session.pty.write(`/model ${modelName}\r`);
    console.log(`[PAN Terminal] Sent /model ${modelName} to PTY session ${sessionId}`);
    return true;
  }

  // No adapter, no PTY — model is still recorded on the session for when one is created.
  return true;
}

// Get all transcript messages for a session (for HTTP fallback on page load)
// Now returns the unified message log — single source of truth.
function getSessionMessages(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return [];
  return session.messages || [];
}

// Trim _streamMessages to prevent unbounded memory growth.
// Keeps the most recent messages, drops the oldest.
function _trimStreamMessages(sess) {
  const max = sess._maxStreamMessages || 500;
  if (sess._streamMessages && sess._streamMessages.length > max) {
    sess._streamMessages = sess._streamMessages.slice(-max);
  }
  if (sess.systemMessages && sess.systemMessages.length > 200) {
    sess.systemMessages = sess.systemMessages.slice(-200);
  }
}

// Push stream transcript messages to all connected clients for a session.
// Debounced: rapid-fire tool calls won't serialize 500 messages × 20 times/sec.
function _pushStreamTranscript(sess) {
  if (sess._transcriptTimer) return; // already scheduled
  sess._transcriptTimer = setTimeout(() => {
    sess._transcriptTimer = null;
    _flushStreamTranscript(sess);
  }, 100); // 100ms debounce — fast enough to feel live, slow enough to batch
}

function _flushStreamTranscript(sess) {
  // #439: if the LLM adapter is active, it owns all broadcasting — skip PTY path
  // to prevent duplicate transcript_messages when both paths fire simultaneously.
  if (sess._llmAdapter?.getMessages?.()?.length > 0) return;
  _trimStreamMessages(sess);
  const messages = [...(sess.systemMessages || []), ...(sess._streamMessages || [])];
  messages.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const payload = JSON.stringify({ type: 'transcript_messages', messages });
  for (const client of sess.clients) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch {}
    }
  }
}

// ==================== Session State Machine ====================
// Single state field replaces claudeRunning + claudeExited + pipeMode booleans.
// Every transition is logged. Illegal transitions are rejected and logged as bugs.

const SessionState = {
  STARTING:     'starting',     // PTY spawning or adapter initializing
  IDLE:         'idle',         // Connected, waiting for input
  WORKING:      'working',      // AI actively responding
  INTERRUPTED:  'interrupted',  // User pressed Esc, cleanup in progress
  EXITED:       'exited',       // PTY died or adapter ended, no recovery
  RECONNECTING: 'reconnecting', // Carrier restart, waiting for reattach
};

const LEGAL_TRANSITIONS = {
  [SessionState.STARTING]:     [SessionState.IDLE, SessionState.EXITED],
  [SessionState.IDLE]:         [SessionState.WORKING, SessionState.EXITED, SessionState.RECONNECTING],
  [SessionState.WORKING]:      [SessionState.IDLE, SessionState.INTERRUPTED, SessionState.EXITED],
  [SessionState.INTERRUPTED]:  [SessionState.IDLE, SessionState.EXITED],
  [SessionState.RECONNECTING]: [SessionState.IDLE, SessionState.EXITED],
  [SessionState.EXITED]:       [],
};

function transitionState(session, newState, reason) {
  const current = session.state || SessionState.STARTING;
  if (current === newState) return true;
  const allowed = LEGAL_TRANSITIONS[current] || [];
  if (!allowed.includes(newState)) {
    console.error(`[Session] ILLEGAL transition ${session.id || session.sessionId || '?'}: ${current} → ${newState} (${reason})`);
    return false;
  }
  console.log(`[Session] ${session.id || session.sessionId || '?'} state: ${current} → ${newState} (${reason})`);
  session.state = newState;
  // Broadcast state so frontend binding is always server-authoritative
  for (const client of session.clients) {
    if (client.readyState === 1) {
      try { client.send(JSON.stringify({ type: 'state', state: newState })); } catch {}
    }
  }
  return true;
}

// ==================== Session Mode ====================
// Controls which input path is active. Backend enforces — frontend must not guess.

const SessionMode = {
  PTY_ONLY:          'pty',      // raw PTY shell, no AI
  PTY_WITH_CLAUDE:   'pty-tui',  // claude TUI running inside PTY
  ADAPTER:           'adapter',  // Agent SDK pipe mode, no direct PTY writes
};

function transitionMode(session, newMode, reason) {
  const old = session.mode || SessionMode.PTY_ONLY;
  if (old === newMode) return;
  console.log(`[Session] ${session.id || session.sessionId} mode: ${old} → ${newMode} (${reason})`);
  session.mode = newMode;
  appendMessage(session, {
    role: 'system', type: 'mode_change',
    text: `Session mode: ${old} → ${newMode}`,
    source: 'system',
  });
  // Broadcast mode change so frontend stays in sync
  for (const client of session.clients) {
    if (client.readyState === 1) {
      try { client.send(JSON.stringify({ type: 'mode', mode: newMode })); } catch {}
    }
  }
}

// ==================== Unified Message Log ====================
// Single source of truth for all session messages.
// appendMessage is the ONLY way to add messages. flushBroadcast is the ONLY way to push to clients.
// _streamMessages, systemMessages, and adapter internal arrays are legacy — stop writing to them.

function appendMessage(session, message) {
  if (!session.messages) session.messages = [];
  if (!message.ts) message.ts = new Date().toISOString();
  if (!message.source) message.source = 'system';

  // Dedup: same source + same text within 50ms → drop silently
  const last = session.messages[session.messages.length - 1];
  if (last
      && last.source === message.source
      && last.text === message.text
      && Math.abs(new Date(last.ts) - new Date(message.ts)) < 50) {
    return;
  }

  // Assign a stable per-session sequence number to tool messages so the
  // frontend dedup key (role|type|text|_seq) treats each invocation as
  // distinct — even when the same file is Read multiple times.
  // Non-tool messages get no _seq so the echo/JSONL dedup (role|type|text)
  // still collapses echo+JSONL pairs correctly.
  if (message.role === 'assistant' && message.type === 'tool') {
    session._toolMsgSeq = (session._toolMsgSeq || 0) + 1;
    message._seq = session._toolMsgSeq;
  }

  session.messages.push(message);
  session._messageVersion = (session._messageVersion || 0) + 1;

  if (session.messages.length > MAX_STREAM_MESSAGES) {
    session.messages = session.messages.slice(-MAX_STREAM_MESSAGES);
  }

  scheduleBroadcast(session);
}

function scheduleBroadcast(session) {
  if (session._broadcastTimer) return;
  session._broadcastTimer = setTimeout(() => {
    session._broadcastTimer = null;
    flushBroadcast(session);
  }, 100);
}

function flushBroadcast(session) {
  const payload = JSON.stringify({
    type: 'transcript_messages',
    messages: session.messages || [],
    version: session._messageVersion || 0,
  });
  // Bug #768: silently swallowing send errors + leaving non-OPEN clients in
  // the set meant a transcript could "broadcast" to zero usable clients and
  // the message was effectively lost (the JSONL still had it, but the
  // dashboard never saw it). Drop dead/closing clients eagerly so reconnect
  // logic kicks in and so the next broadcast attempt skips them cleanly.
  const dead = [];
  for (const client of session.clients) {
    if (client.readyState === 1) {
      try { client.send(payload); }
      catch (e) {
        dead.push(client);
        console.warn(`[PAN #768] flushBroadcast send failed for session ${session.id || session.sessionId}: ${e?.message}`);
      }
    } else {
      // readyState 0=CONNECTING (rare, leave it), 2=CLOSING, 3=CLOSED.
      if (client.readyState === 2 || client.readyState === 3) dead.push(client);
    }
  }
  for (const c of dead) {
    session.clients.delete(c);
    try { c.terminate?.(); } catch {}
  }
  if (dead.length > 0) {
    console.log(`[PAN #768] flushBroadcast pruned ${dead.length} dead client(s) from session ${session.id || session.sessionId}; ${session.clients.size} remain`);
  }
}

// ==================== Process Registry ====================
// Tracks ALL PIDs spawned by PAN: PTY shells, Claude CLI inside PTY, agent-sdk calls.
// Keyed by PID. Each entry: { pid, type, sessionId, command, spawnedAt, exitedAt?, exitCode?, parentPid? }
// Types: 'pty' (shell), 'claude_cli' (Claude inside PTY), 'agent_sdk' (agent-sdk calls)
const processRegistry = new Map();

function registerProcess({ pid, type, sessionId, command, parentPid }) {
  if (!pid) return;
  processRegistry.set(pid, {
    pid,
    type,
    sessionId: sessionId || null,
    command: command || '',
    parentPid: parentPid || null,
    spawnedAt: Date.now(),
    exitedAt: null,
    exitCode: null,
  });
  console.log(`[PAN Registry] Registered ${type} PID ${pid} (session: ${sessionId || 'none'})`);
}

function deregisterProcess(pid, exitCode) {
  const entry = processRegistry.get(pid);
  if (entry) {
    entry.exitedAt = Date.now();
    entry.exitCode = exitCode ?? null;
    console.log(`[PAN Registry] Deregistered PID ${pid} (exit: ${exitCode})`);
    // Keep dead entries for 10 minutes for post-mortem, then prune
    setTimeout(() => processRegistry.delete(pid), 10 * 60 * 1000);
  }
}

function getProcessRegistry() {
  const result = [];
  for (const [pid, entry] of processRegistry) {
    const alive = entry.exitedAt === null;
    result.push({
      ...entry,
      alive,
      uptimeMs: alive ? Date.now() - entry.spawnedAt : entry.exitedAt - entry.spawnedAt,
    });
  }
  return result;
}

// Discover the LLM CLI process running inside a PTY and register it.
// Walks the process tree down from the bash PID to find node/python processes
// running CLI tools (Claude, OpenCode, any LLM CLI). LLM-agnostic.
async function discoverAndRegisterCliProcess(session, sessionId, bashPid) {
  try {
    const { execSync } = await import('child_process');
    // Get all descendants of the bash process
    const out = execSync(
      `wmic process get ProcessId,ParentProcessId,CommandLine /FORMAT:CSV`,
      { encoding: 'utf-8', timeout: 5000, windowsHide: true }
    ).trim();

    // Build parent→children map from all processes
    const lines = out.split('\n').filter(l => l.trim() && !l.startsWith('Node,'));
    const procs = [];
    for (const line of lines) {
      const cols = line.trim().split(',');
      if (cols.length < 3) continue;
      const cmd = cols.slice(1, -2).join(','); // CommandLine may contain commas
      const ppid = parseInt(cols[cols.length - 2], 10);
      const pid = parseInt(cols[cols.length - 1], 10);
      if (pid && ppid) procs.push({ pid, ppid, cmd });
    }

    // BFS from bash PID to find all descendants
    const descendants = new Set();
    const queue = [bashPid];
    while (queue.length) {
      const parent = queue.shift();
      for (const p of procs) {
        if (p.ppid === parent && !descendants.has(p.pid)) {
          descendants.add(p.pid);
          queue.push(p.pid);
        }
      }
    }

    // Find the CLI process among descendants — look for known LLM CLI patterns
    const cliPatterns = ['claude-code/cli.js', 'claude-code\\cli.js', 'gemini', 'opencode', 'aider', 'continue'];
    for (const p of procs) {
      if (!descendants.has(p.pid)) continue;
      const matchedPattern = cliPatterns.find(pat => p.cmd.toLowerCase().includes(pat));
      if (matchedPattern) {
        session._claudeCliPid = p.pid;
        let type = 'llm_cli';
        if (matchedPattern.includes('claude')) type = 'claude_cli';
        if (matchedPattern === 'gemini') type = 'gemini_cli';
        registerProcess({ pid: p.pid, type, sessionId, command: p.cmd.slice(0, 200), parentPid: bashPid });
        return;
      }
    }
    // Fallback: register the first node.exe descendant that isn't the bash itself
    for (const p of procs) {
      if (!descendants.has(p.pid)) continue;
      if (p.cmd.includes('node') && !p.cmd.includes('bash')) {
        session._claudeCliPid = p.pid;
        registerProcess({ pid: p.pid, type: 'llm_cli', sessionId, command: p.cmd.slice(0, 200), parentPid: bashPid });
        return;
      }
    }
  } catch (e) {
    console.error(`[PAN Terminal] Failed to discover CLI PID:`, e.message);
  }
}

// ==================== Reconnect Token Registry ====================
// Phase 3: tokens survive server restarts via disk persistence.
// token → { sessionId, project, cwd, claudeSessionIds, issuedAt }
const reconnectTokens = new Map();
const TOKENS_FILE = join(getDataDir(), 'reconnect-tokens.json');

function loadTokens() {
  try {
    if (existsSync(TOKENS_FILE)) {
      const data = JSON.parse(readFileSync(TOKENS_FILE, 'utf-8'));
      for (const [token, entry] of Object.entries(data)) {
        reconnectTokens.set(token, entry);
      }
      console.log(`[PAN Terminal] Loaded ${reconnectTokens.size} reconnect tokens`);
    }
  } catch (err) {
    console.error('[PAN Terminal] Failed to load reconnect tokens:', err.message);
  }
}

function saveTokens() {
  try {
    const obj = Object.fromEntries(reconnectTokens);
    writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('[PAN Terminal] Failed to save reconnect tokens:', err.message);
  }
}

function issueToken(sessionId, project, cwd, claudeSessionIds) {
  const token = randomUUID();
  reconnectTokens.set(token, {
    sessionId,
    project,
    cwd,
    claudeSessionIds: claudeSessionIds || [],
    issuedAt: Date.now(),
  });
  // Prune tokens older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [t, entry] of reconnectTokens) {
    if (entry.issuedAt < cutoff) reconnectTokens.delete(t);
  }
  saveTokens();
  return token;
}

function resolveToken(token) {
  return reconnectTokens.get(token) || null;
}

function updateTokenClaudeSessions(token, claudeSessionIds) {
  const entry = reconnectTokens.get(token);
  if (entry) {
    entry.claudeSessionIds = claudeSessionIds;
    saveTokens();
  }
}

// Load tokens on module init
loadTokens();

// In-flight tool tracker — keyed by Claude session ID so multiple tabs
// on the same cwd each track their own tool status independently.
// Updated by PreToolUse / PostToolUse / SubagentStart / SubagentStop hooks.
//   key = claudeSessionId (unique per Claude CLI instance)
//   value = { tool, summary, startedAt, claudeSessionId, isSubagent, cwd }
const inFlightTools = new Map();

function _cwdKey(cwd) {
  if (!cwd) return '';
  return cwd.replace(/\\/g, '/').toLowerCase();
}

function setInFlightTool(cwd, info) {
  // Key by claudeSessionId if available, fall back to cwd for backwards compat
  const key = info?.claudeSessionId || _cwdKey(cwd);
  if (!key) return;
  inFlightTools.set(key, { ...info, cwd, startedAt: Date.now() });
}

function clearInFlightTool(cwd, claudeSessionId) {
  // Clear by claudeSessionId (preferred) or by cwd (fallback)
  if (claudeSessionId && inFlightTools.has(claudeSessionId)) {
    inFlightTools.delete(claudeSessionId);
    return;
  }
  // Fallback: find entry matching this cwd + claudeSessionId
  const cwdNorm = _cwdKey(cwd);
  for (const [key, cur] of inFlightTools) {
    if (claudeSessionId && cur.claudeSessionId && cur.claudeSessionId !== claudeSessionId) continue;
    if (_cwdKey(cur.cwd) === cwdNorm || key === cwdNorm) {
      inFlightTools.delete(key);
      return;
    }
  }
}

function getInFlightTool(cwd, claudeSessionIds) {
  // In-flight tools are keyed by Claude session ID (set in setInFlightTool).
  // The ONLY way to confidently say "this tool belongs to this dashboard tab"
  // is to match by claudeSessionId — that's the unique fingerprint of a
  // claude -p process that we registered as belonging to this tab via the
  // chat_update WS event handshake.
  //
  // The previous fallback ("match any inFlightTool whose cwd === session.cwd")
  // looked plausible but was wrong-by-design: session.cwd is set from the
  // reconnect token, which can carry stale cwd state from a prior tab life
  // (e.g. user switched the tab's project at some point, the token persisted
  // the OLD cwd, the next reconnect inherits it). Combined with an empty
  // claudeSessionIds (which is the normal state for a tab that hasn't seen
  // its first chat_update yet), the fallback would happily return a tool
  // belonging to a *different* project that happened to share the same cwd.
  // Field evidence (2026-05-30): PAN tab whose reconnect token had cwd set
  // to WoE/Dev — bottom status bar persistently showed WoE Bash tool calls
  // while the actual conversation (top) was PAN. Removing the fallback fixes
  // the leak.
  //
  // Cost: a freshly-attached tab won't show a tool indicator until the first
  // chat_update WS event populates claudeSessionIds. That's the right
  // trade-off — empty status bar is correct, wrong-project status bar is not.
  if (!claudeSessionIds || claudeSessionIds.length === 0) return null;
  for (const csid of claudeSessionIds) {
    const tool = inFlightTools.get(csid);
    if (tool) return tool;
  }
  return null;
}

// Default shell — platform.js handles Git Bash detection + Linux/Mac
const { shell: SHELL, args: SHELL_ARGS } = getShell();

let wss = null;
let ScreenBufferClass = ScreenBuffer; // eager (see import note above) — pipe mode needs it even when the WS server is gated off

async function startTerminalServer(httpServer) {
  wss = new WebSocketServer({ noServer: true });

  // Single upgrade handler for all PAN WebSocket paths
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/ws/terminal' || pathname === '/ws/terminal-dev') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/whisper') {
      // Proxy to Whisper streaming server on port 7783
      proxyWhisperWs(request, socket, head);
    } else if (pathname === '/ws/client') {
      // Handled by client-manager — do not interfere
      return;
    } else if (pathname === '/ws/panels') {
      // Phase 3: dashboard tabs subscribe here for periodic panel data
      // pushes. See panel-broadcaster.js for the full design.
      import('./panel-broadcaster.js').then(m => {
        m.handlePanelWsUpgrade(request, socket, head);
      }).catch((err) => {
        console.error('[PAN Terminal] panel-broadcaster import failed:', err.message);
        try { socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n'); socket.destroy(); } catch {}
      });
    } else {
      // Unknown paths: reject fast so misconfigured probes/clients don't
      // eat their timeout budget. Previously we let the socket hang which
      // silently burned the perf engine's ws.handshake 2s window.
      try {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
      } catch {}
    }
  });

  wss.on('connection', (ws, req) => {
    // Bug #768: server-side ping/pong heartbeat. Without this, a dashboard
    // tab that backgrounded for hours (or a NAT that silently dropped the
    // flow) leaves the socket in OPEN state on the server forever — and
    // flushBroadcast happily sends transcripts into a black hole. Pong
    // restores liveness; missing 2 pongs terminates the socket so the
    // dashboard's reconnect path runs.
    ws._isAlive = true;
    ws._missedPongs = 0;
    ws.on('pong', () => { ws._isAlive = true; ws._missedPongs = 0; });

    try { _handleTerminalConnection(ws, req); } catch (err) {
      console.error(`[PAN Terminal] FATAL connection handler error:`, err);
      try { ws.send(JSON.stringify({ type: 'error', message: err.message })); } catch {}
    }
  });

  // Heartbeat sweep — every 30s ping every client; after 2 missed pongs (~60s)
  // terminate. clearInterval on wss close so test/dev restarts don't leak.
  const heartbeatInterval = setInterval(() => {
    if (!wss || !wss.clients) return;
    for (const ws of wss.clients) {
      if (ws._isAlive === false) {
        ws._missedPongs = (ws._missedPongs || 0) + 1;
        if (ws._missedPongs >= 2) {
          console.warn(`[PAN #768] terminating dead WS after ${ws._missedPongs} missed pongs`);
          try { ws.terminate(); } catch {}
          continue;
        }
      }
      ws._isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeatInterval));

  async function _handleTerminalConnection(ws, req) {
    // Parse query params: ?session=<id>&project=<name>&cwd=<path>&cols=80&rows=24
    const url = new URL(req.url, 'http://localhost');
    const isDev = url.pathname === '/ws/terminal-dev';
    ws._panDev = true;  // All clients get screen-v2 with append-only log
    ws._logPosition = 0;  // Track log cursor for incremental sync

    // Phase 3: Check for reconnect token first
    const reconnectToken = url.searchParams.get('token');
    let tokenEntry = reconnectToken ? resolveToken(reconnectToken) : null;
    const tokenExpired = reconnectToken && !tokenEntry; // client sent a token but it was expired/invalid

    const sessionId = tokenEntry?.sessionId || url.searchParams.get('session') || 'default';
    const projectName = tokenEntry?.project || url.searchParams.get('project') || '';
    const cwd = tokenEntry?.cwd || url.searchParams.get('cwd') || '%USERPROFILE%\\Desktop';
    const tabName = url.searchParams.get('tab_name') || '';
    const cols = parseInt(url.searchParams.get('cols')) || 120;
    const rows = parseInt(url.searchParams.get('rows')) || 30;

    // Register tab name for per-tab transcript file naming
    if (tabName) {
      setSessionName(sessionId, tabName);
    }

    let session = sessions.get(sessionId);

    // Dedup guard: if this is a NEW session ID but the project already has an active
    // session with connected clients, redirect the client to that session instead of
    // spawning a duplicate PTY.  This kills the race condition where two windows both
    // load simultaneously, both see "no live session", and both create one.
    // Only applies to named dashboard sessions (dash-* / dev-dash-*) with a project name.
    // Skip if force_new=1 — intentional new-tab creation (e.g. "+" button) must NOT be
    // deduplicated, otherwise every new tab attaches to the first tab's PTY session.
    const forceNew = url.searchParams.get('force_new') === '1';
    if (!session && projectName && sessionId.startsWith('dash-') && !forceNew) {
      const existingForProject = Array.from(sessions.values()).find(s =>
        s.project === projectName && s.clients.size > 0
      );
      if (existingForProject) {
        const existingId = [...sessions.entries()].find(([, v]) => v === existingForProject)?.[0];
        if (existingId) {
          console.log(`[PAN Terminal] Dedup: redirecting new ${sessionId} → existing ${existingId} for project ${projectName}`);
          try {
            ws.send(JSON.stringify({ type: 'session_redirect', session_id: existingId }));
          } catch {}
          ws.close();
          return;
        }
      }
    }

    if (!session) {
      // Create ScreenBuffer for server-side rendering
      const term = new ScreenBufferClass(cols, rows);

      // Persist terminal log across restarts — keyed by sessionId
      const logFile = join(TERMINAL_LOG_DIR, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl');
      term.setLogFile(logFile);
      const restored = term.loadLogFile();
      if (restored > 0) {
        console.log(`[PAN Terminal] Restored ${restored} log entries from prior session: ${sessionId}`);
        // Persist restart marker to per-tab transcript
        writeSystemMessage(sessionId, 'server_restart', `Server restarted — restored ${restored} log entries from prior session`);
      }

      // Spawn new PTY
      try {
        // ── ConPTY crash recovery (Part 1 + 2) ─────────────────────────
        const crashEntry = ptySessionCrashMap.get(sessionId);
        const recentCrash = crashEntry && (Date.now() - crashEntry.at < 60_000);
        const useConptyFalse = process.platform === 'win32' && recentCrash && crashEntry.code === STATUS_FATAL_APP_EXIT;
        if (useConptyFalse) {
          console.log(`[PAN Terminal] PTY crash detected (STATUS_FATAL_APP_EXIT) — spawning with useConpty: false`);
        }
        // Backoff: if crashed more than 2 times within the last 5 minutes, wait 5s
        if (crashEntry && crashEntry.count > 2 && (Date.now() - crashEntry.at < 5 * 60_000)) {
          console.warn(`[PAN Terminal] Rapid PTY crashes detected (${crashEntry.count} times) — waiting 5s before respawn`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        // ────────────────────────────────────────────────────────────────

        const ptyOptions = {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: cwd.replace(/\//g, '\\'),
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            PAN_PROJECT: projectName,
            PAN_TERMINAL: 'dashboard',
          },
        };
        if (useConptyFalse) ptyOptions.useConpty = false;

        const ptyProcess = pty.spawn(SHELL, SHELL_ARGS, ptyOptions);

        session = {
          pty: ptyProcess,
          term,
          clients: new Set(),
          project: projectName,
          cwd,
          createdAt: Date.now(),
          renderTimer: null,
          lastRendered: '',
          // Session state machine (see SessionState/transitionState)
          state: SessionState.STARTING,
          // Session mode — controls which input path is active (see SessionMode/transitionMode)
          mode: SessionMode.PTY_ONLY,
          // Unified message log — single source of truth (see appendMessage/flushBroadcast)
          messages: [],
          _messageVersion: 0,
          // Legacy arrays — kept for read compat, no longer written to directly
          systemMessages: [],
          // Liveness tracking — used by listSessions() so the dashboard can
          // derive a real "thinking" state from input-vs-output recency,
          // not local UI state that desyncs across refreshes/tabs.
          lastInputTs: 0,
          lastOutputTs: Date.now(),
          claudeRunning: false, // true while a query is actively processing
          claudeExited: false, // set true when Claude CLI exits inside the PTY
          pipeMode: true, // always true — pipe mode means Claude is available on-demand
          claudeSessionIds: [], // Claude session IDs belonging to this tab (updated via set_claude_sessions)
          // Per-session model override — set via pipeSetModel. Null = use global default.
          // This is what makes each dashboard tab able to run a different model.
          model: null,
        };
        sessions.set(sessionId, session);

        // Register PTY shell in process registry
        registerProcess({
          pid: ptyProcess.pid,
          type: 'pty',
          sessionId,
          command: `${SHELL} ${SHELL_ARGS.join(' ')}`,
        });

        // PTY is spawned and shell is ready — transition from STARTING to IDLE
        transitionState(session, SessionState.IDLE, 'pty spawned');

        // ── AUTO-LAUNCH AI CLI ───────────────────────────────────────
        // If the provider is 'gemini', send the command to the PTY.
        // We use a small delay to ensure the shell is ready for input.
        try {
          const row = get("SELECT value FROM settings WHERE key = 'terminal_ai_provider'");
          const provider = row ? row.value.replace(/^"|"$/g, '').toLowerCase() : 'claude';
          if (provider === 'gemini') {
            setTimeout(() => {
              console.log(`[PAN Terminal] Auto-launching Gemini CLI in session ${sessionId}`);
              ptyProcess.write('gemini\r');
            }, 1000);
          }
        } catch (err) {
          console.error('[PAN Terminal] Auto-launch check failed:', err.message);
        }

        // PTY output → parse stream-json events from Claude pipe mode.
        // In pipe mode, Claude outputs one JSON event per line on stdout.
        // PTY wraps long lines at column width and adds ANSI cursor sequences,
        // so we strip ANSI first, then buffer, then extract JSON objects.
        let _jsonBuf = '';
        session._streamMessages = []; // Parsed transcript messages for this session
        session._claudeSessionId = null; // Claude session UUID from stream init

        // Strip ALL ANSI escape sequences from raw PTY data
        function _stripAnsi(s) {
          return s
            .replace(/\x1b\[[\x20-\x3f]*[\x30-\x3f]*[\x40-\x7e]/g, '')
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
            .replace(/\x1b[^[\]P\x1b]/g, '')
            .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
            .replace(/\x1b/g, '')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
            .replace(/\x07/g, '');
        }

        ptyProcess.onData((data) => {
          session.lastOutputTs = Date.now();
          term.write(data);

          // Strip ANSI, buffer, and extract complete JSON objects
          const clean = _stripAnsi(data);
          _jsonBuf += clean;

          // Try to extract JSON objects — they start with { and end with }
          // followed by a newline or end of buffer
          const extracted = [];
          let searchFrom = 0;
          while (searchFrom < _jsonBuf.length) {
            const start = _jsonBuf.indexOf('{', searchFrom);
            if (start < 0) break;
            // Find matching closing brace (simple depth tracking)
            let depth = 0;
            let inString = false;
            let escaped = false;
            let end = -1;
            for (let i = start; i < _jsonBuf.length; i++) {
              const ch = _jsonBuf[i];
              if (escaped) { escaped = false; continue; }
              if (ch === '\\' && inString) { escaped = true; continue; }
              if (ch === '"') { inString = !inString; continue; }
              if (inString) continue;
              if (ch === '{') depth++;
              if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
            }
            if (end < 0) break; // Incomplete JSON — wait for more data
            const candidate = _jsonBuf.substring(start, end + 1);
            try {
              const obj = JSON.parse(candidate);
              extracted.push(obj);
            } catch { /* not valid JSON, skip */ }
            searchFrom = end + 1;
          }
          // Keep only unprocessed data in buffer (after last extracted object)
          if (searchFrom > 0) _jsonBuf = _jsonBuf.substring(searchFrom);
          // Prevent buffer from growing unbounded
          if (_jsonBuf.length > 100000) _jsonBuf = _jsonBuf.substring(_jsonBuf.length - 10000);

          if (extracted.length > 0) {
            console.log(`[PAN Terminal] Extracted ${extracted.length} JSON events from PTY: ${extracted.map(e => e.type + (e.subtype ? ':' + e.subtype : '')).join(', ')}`);
          }
          for (const evt of extracted) {

            // Parse stream-json event types
            if (evt.type === 'system' && evt.subtype === 'init') {
              // Session init — capture Claude session ID + mark as running
              session._claudeSessionId = evt.session_id;
              session.claudeRunning = true;  // legacy compat
              session.claudeExited = false;  // legacy compat
              transitionState(session, SessionState.WORKING, 'stream init');
              console.log(`[PAN Terminal] Stream init: claude_session=${evt.session_id} in ${sessionId}`);

            } else if (evt.type === 'assistant' && evt.message?.content) {
              // Track cumulative token usage from assistant messages
              const mu = evt.message?.usage;
              if (mu) {
                if (!session._tokenTotals) session._tokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
                session._tokenTotals.input += mu.input_tokens || 0;
                session._tokenTotals.output += mu.output_tokens || 0;
                session._tokenTotals.cacheRead += mu.cache_read_input_tokens || 0;
                session._tokenTotals.cacheCreate += mu.cache_creation_input_tokens || 0;
              }
              // Assistant message — extract clean text and tool use
              for (const block of evt.message.content) {
                if (block.type === 'text' && block.text?.trim()) {
                  appendMessage(session, {
                    role: 'assistant', type: 'text',
                    text: block.text,
                    ts: new Date().toISOString(),
                    model: evt.message.model || null,
                    source: 'pty',
                  });
                } else if (block.type === 'tool_use') {
                  const name = block.name || 'unknown';
                  const input = block.input || {};
                  let summary = name;
                  if (name === 'Bash' && input.command) summary = `Bash: ${input.command.substring(0, 120)}`;
                  else if (name === 'Edit' && input.file_path) summary = `Edit: ${input.file_path.split(/[/\\]/).pop()}`;
                  else if (name === 'Read' && input.file_path) summary = `Read: ${input.file_path.split(/[/\\]/).pop()}`;
                  else if (name === 'Write' && input.file_path) summary = `Write: ${input.file_path.split(/[/\\]/).pop()}`;
                  else if (name === 'Grep' && input.pattern) summary = `Grep: ${input.pattern.substring(0, 60)}`;
                  else if (name === 'Glob' && input.pattern) summary = `Glob: ${input.pattern}`;
                  else if (name === 'Agent' && (input.description || input.prompt)) summary = `Agent: ${(input.description || input.prompt).substring(0, 80)}`;
                  appendMessage(session, {
                    role: 'assistant', type: 'tool',
                    text: summary,
                    ts: new Date().toISOString(),
                    source: 'pty',
                  });
                }
              }
              // appendMessage handles dedup, trim, and broadcast scheduling

            } else if (evt.type === 'result') {
              // Turn complete — Claude exited back to bash
              session.claudeRunning = false; // legacy compat
              transitionState(session, SessionState.IDLE, 'stream result');
              console.log(`[PAN Terminal] Stream result: turns=${evt.num_turns} cost=$${evt.total_cost_usd?.toFixed(4)} in ${sessionId}`, JSON.stringify(Object.keys(evt)));
              // Push turn stats with cumulative cost + tokens
              const tt = session._tokenTotals || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
              appendMessage(session, {
                role: 'system', type: 'turn_stats',
                ts: new Date().toISOString(),
                source: 'pty',
                tokens: {
                  total_input: tt.input,
                  total_output: tt.output,
                  total_cache_read: tt.cacheRead,
                  total_cache_create: tt.cacheCreate,
                  total_cost: evt.total_cost_usd ?? null,
                },
              });
              // appendMessage handles trim and broadcast scheduling
            }
          }

          // Detect bash prompt return ($ at end without JSON)
          // This catches the case between claude -p invocations
          const rawStripped = data.replace(/[\r\n]/g, '').trim();
          if (/\$\s*$/.test(rawStripped) && !rawStripped.startsWith('{')) {
            if (session.claudeRunning) {
              session.claudeRunning = false; // legacy compat
              transitionState(session, SessionState.IDLE, 'bash prompt detected');
            }
          }

          // Debounce screen rendering (for raw terminal view)
          if (!session.renderTimer) {
            session.renderTimer = setTimeout(() => {
              session.renderTimer = null;
              broadcastRenderedScreen(session);
            }, 33);
          }
        });

        // Push is handled by module-level _pushStreamTranscript

        ptyProcess.onExit(({ exitCode }) => {
          const uptimeMs = Date.now() - (session.createdAt || Date.now());
          // Log to events DB so the exit is permanent + recoverable after refresh.
          const planned = !!session._plannedShutdown;
          try {
            insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
              ':sid': sessionId,
              ':type': planned ? 'PtyShutdown' : 'PtyExit',
              ':data': JSON.stringify({
                session_id: sessionId,
                project: session.project,
                cwd: session.cwd,
                exit_code: exitCode,
                uptime_ms: uptimeMs,
                pid: ptyProcess.pid,
                planned,
                timestamp: Date.now(),
              }),
            });
          } catch (err) {
            console.error(`[PAN Terminal] Failed to log PtyExit:`, err.message);
          }
          console.log(`[PAN Terminal] PTY ${planned ? 'shutdown' : 'exited'}: ${sessionId} code=${exitCode} uptime=${Math.round(uptimeMs/1000)}s`);
          // Deregister PTY and any child Claude CLI from process registry
          deregisterProcess(ptyProcess.pid, exitCode);
          if (session._claudeCliPid) deregisterProcess(session._claudeCliPid, exitCode);
          // Fire a persistent alert only for unexpected crashes, not planned shutdowns
          if (!session._plannedShutdown) {
            try {
              createAlert({
                alert_type: 'pty_crash',
                severity: 'critical',
                title: `PTY crashed: ${session.project || sessionId}`,
                detail: `Exit code ${exitCode}, uptime ${Math.round(uptimeMs/1000)}s, PID ${ptyProcess.pid}`,
              });
            } catch {}
          } else {
            console.log(`[PAN Terminal] Planned shutdown — skipping crash alert for ${sessionId}`);
          }
          // Persist PTY exit to per-tab transcript file
          transitionState(session, SessionState.EXITED, `pty exit code=${exitCode}`);
          flushSession(sessionId);
          writeSystemMessage(sessionId, 'pty_exit', `PTY exited (code ${exitCode}, uptime ${Math.round(uptimeMs/1000)}s)`);
          // Also write to old Claude JSONL transcript (for backwards compat)
          writeSystemEvent(session.cwd, 'pty_exit', `PTY exited (code ${exitCode}, uptime ${Math.round(uptimeMs/1000)}s)`, {
            exit_code: exitCode,
            uptime_ms: uptimeMs,
            pid: ptyProcess.pid,
            session_id: sessionId,
            project: session.project,
          });
          // Add PTY exit as system message so it shows in transcript
          appendMessage(session, {
            role: 'system', type: 'banner',
            text: `PTY exited (code ${exitCode}, uptime ${Math.round(uptimeMs/1000)}s)`,
            ts: new Date().toISOString(),
            source: 'system',
          });
          for (const client of session.clients) {
            if (client.readyState === 1) {
              client.send(JSON.stringify({
                type: 'exit',
                code: exitCode,
                uptime_ms: uptimeMs,
                project: session.project,
              }));
              // Flush unified message log so PTY exit appears in transcript immediately
              try {
                client.send(JSON.stringify({
                  type: 'transcript_messages',
                  messages: session.messages || [],
                  version: session._messageVersion || 0,
                }));
              } catch {}
            }
          }
          // Record crash info for ConPTY fallback + backoff on next spawn
          if (!planned && exitCode !== 0) {
            const prev = ptySessionCrashMap.get(sessionId);
            ptySessionCrashMap.set(sessionId, {
              code: exitCode,
              at: Date.now(),
              count: prev ? prev.count + 1 : 1,
            });
          }
          sessions.delete(sessionId);
        });

        // Inject session context into CLAUDE.md BEFORE Claude starts.
        // Pass this tab's Claude session IDs so Part 1 is tab-scoped.
        if (cwd) {
          try {
            const tabIds = session?.claudeSessionIds || [];
            injectSessionContext(cwd, 'org_personal', tabIds);
            console.log(`[PAN Terminal] Pre-injected session context for ${projectName || sessionId} (tabIds: ${tabIds.length})`);
          } catch (err) {
            console.error(`[PAN Terminal] Context injection failed:`, err.message);
          }
        }

        console.log(`[PAN Terminal] New session: ${sessionId} (${projectName || 'shell'}) in ${cwd}`);

        // Claude auto-launch is handled by the FRONTEND (not here).
        // The frontend's onopen/reconnect handler calls /api/v1/inject-context
        // first, then sends `claude --permission-mode auto "Π remembers..."`.
        // A server-side launch here races with the frontend's launch, causing
        // the second command to be typed INTO the already-loading Claude session
        // as user input — which swallows the user's first real message.
        // See +page.svelte:876-922 (onopen) and :840-858 (reconnect).
      } catch (err) {
        console.error(`[PAN Terminal] Failed to spawn PTY:`, err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to create terminal: ' + err.message }));
        ws.close();
        return;
      }
    }

    // Add this client to the session
    session.clients.add(ws);

    // Phase 3: Issue reconnect token for this client
    // If reconnecting with a valid token, reuse claude session IDs from it
    let claudeSessionIdsFromToken = tokenEntry?.claudeSessionIds || [];
    // Phase 4: Restore Claude session IDs onto the session so pipeSend() can resume
    if (claudeSessionIdsFromToken.length > 0 && session) {
      const merged = new Set([...(session.claudeSessionIds || []), ...claudeSessionIdsFromToken]);
      session.claudeSessionIds = [...merged];
      console.log(`[PAN Terminal] Restored Claude session IDs from token: ${claudeSessionIdsFromToken.join(', ')}`);
    }
    const newToken = issueToken(sessionId, projectName, cwd, claudeSessionIdsFromToken);
    ws._reconnectToken = newToken;

    // Send session info + reconnect token. Frontend reads mode as authoritative — no local opinion.
    ws.send(JSON.stringify({
      type: 'info',
      session: sessionId,
      project: session.project,
      cwd: session.cwd,
      host: hostname(),
      reconnectToken: newToken,
      restoredFromToken: !!tokenEntry,
      tokenExpired,
      mode: session.mode || SessionMode.PTY_ONLY,
    }));

    // Push authoritative session state immediately on connect/reconnect.
    // Without this, reconnecting clients inherit their pre-reconnect local state
    // (claudeReady=false from the disconnect) and never recover until the next
    // state transition. The sync_request handler also returns this, but push it
    // proactively so there's no round-trip delay.
    try {
      ws.send(JSON.stringify({
        type: 'state',
        state: session.state || SessionState.IDLE,
      }));
    } catch {}

    if (tokenExpired) {
      console.log(`[PAN Terminal] Reconnect token expired/invalid for session ${sessionId} — falling back to fresh params`);
    }

    // Send current screen state immediately (for new/reconnecting clients)
    broadcastRenderedScreen(session, ws);

    // NOTE: No session-start banner here — Claude's own "Π Remembers:" response
    // (triggered by the dashboard auto-launch) IS the briefing. A separate system
    // banner was rendering as a red warning box which looked wrong.

    // On connect/reconnect, push unified message log immediately.
    {
      const msgs = session.messages || [];
      if (msgs.length > 0) {
        try {
          ws.send(JSON.stringify({
            type: 'transcript_messages',
            messages: msgs,
            version: session._messageVersion || 0,
          }));
        } catch {}
      }
    }

    // Handle incoming messages from client
    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());

        switch (parsed.type) {
          case 'input':
            // Guard: raw PTY input is only valid in PTY modes.
            // If session is in ADAPTER mode, the frontend sent to the wrong path —
            // reject it explicitly so input isn't silently lost.
            if (session.mode === SessionMode.ADAPTER) {
              console.warn(`[Session] Dropped 'input' in ADAPTER mode for ${sessionId} — frontend should send pipe_send`);
              try { ws.send(JSON.stringify({ type: 'error', message: 'Session is in adapter mode, use pipe_send' })); } catch {}
              break;
            }
            if (session.pty) {
              session.lastInputTs = Date.now();
              // #982 — WS 'input' frame = keystroke from dashboard terminal client.
              // Allow the client to override (e.g. test harness can self-tag) but
              // default to 'user_keyboard' since this is the typed-input path.
              const wsSource = parsed.source || 'user_keyboard';
              logPtyInput(session.id, parsed.data, wsSource, { route: 'ws:input', via: 'dashboard_ws' });
              session.pty.write(parsed.data);
              // Extract user message for transcript when PTY sends pipe-mode commands
              const pipeMatch = parsed.data.match(/claude\s+-p\s+--continue\s+.*--permission-mode\s+\w+\s+'((?:[^'\\]|\\.)*)'/);
              if (pipeMatch) {
                const userText = pipeMatch[1].replace(/'\\''/g, "'");
                if (userText.trim() && !/Π remembers/i.test(userText)) {
                  appendMessage(session, {
                    role: 'user', type: 'prompt',
                    text: userText.trim(),
                    ts: new Date().toISOString(),
                    source: 'pty',
                  });
                }
              }
            }
            break;

          case 'interrupt':
            // User pressed Escape — interrupt Claude
            session.lastInputTs = Date.now();
            if (session._llmAdapter && session._llmAdapter.busy) {
              // Pipe mode (SDK): abort the active SDK query
              pipeInterrupt(sessionId);
            }
            if (session.pty) {
              // PTY mode: send Ctrl+C (\x03) — this is the actual SIGINT/interrupt
              // signal in terminal emulators. ESC alone only works in Claude's TUI
              // input field; Ctrl+C interrupts mid-generation reliably.
              session.pty.write('\x03');
              writeSystemMessage(sessionId, 'interrupt', 'Interrupted (Escape)');
            }
            break;

          case 'resize':
            if (parsed.cols && parsed.rows) {
              if (session.pty) session.pty.resize(parsed.cols, parsed.rows);
              session.term.resize(parsed.cols, parsed.rows);
            }
            break;

          case 'set_claude_sessions':
            // Client discovered new Claude session IDs — update transcript filter + token
            if (Array.isArray(parsed.sessions)) {
              // Update the JSONL watcher filter so it reads only this tab's files
              if (ws._transcriptSubscription) {
                ws._transcriptSubscription.setClaudeSessions(parsed.sessions);
              }
              if (ws._reconnectToken) {
                updateTokenClaudeSessions(ws._reconnectToken, parsed.sessions);
              }
              if (session) {
                const merged = new Set([...(session.claudeSessionIds || []), ...parsed.sessions]);
                session.claudeSessionIds = [...merged];
              }
            }
            break;

          case 'pipe_send':
            // Auto-transition to ADAPTER mode on first pipe_send if not already there
            if (session.mode !== SessionMode.ADAPTER) {
              transitionMode(session, SessionMode.ADAPTER, 'pipe_send received');
            }
            pipeSend(sessionId, parsed.text);
            break;

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;

          case 'sync':
            // Dev client requesting log from a position
            ws._logPosition = parsed.logPosition || 0;
            broadcastRenderedScreen(session, ws);
            break;

          case 'sync_request': {
            // Client reconnected and wants current state snapshot.
            // Respond immediately with state — no need to wait for next poll cycle.
            const kinds = Array.isArray(parsed.kinds) ? parsed.kinds : [];
            const snap = { type: 'sync_response' };
            if (kinds.includes('session')) {
              snap.state = session.state || SessionState.IDLE;
              snap.mode = session.mode || SessionMode.PTY_ONLY;
              snap.messages = session.messages || [];
              snap.version = session._messageVersion || 0;
            }
            try { ws.send(JSON.stringify(snap)); } catch {}
            break;
          }
        }
      } catch {}
    });

    ws.on('close', () => {
      if (session) {
        session.clients.delete(ws);
        // Don't kill the PTY when last client disconnects — keep it alive
      }
      // Tear down the transcript subscription so the watcher can free its fd
      if (ws._unsubscribeTranscript) {
        try { ws._unsubscribeTranscript(); } catch {}
        ws._unsubscribeTranscript = null;
      }
    });
  } // end _handleTerminalConnection

  console.log(`[PAN Terminal] Server-side rendered terminal ready at /ws/terminal`);
}

// Broadcast rendered screen from ScreenBuffer to connected clients
function broadcastRenderedScreen(session, singleClient) {
  const t0 = performance.now();
  const screen = session.term.renderScreen();
  const tRender = performance.now();
  const screenStr = screen.join('\n');

  // Check if screen changed
  const screenChanged = screenStr !== session.lastRendered;
  // Check if log has new entries for any dev client
  const currentLogSeq = session.term.logSeq;

  // Skip if nothing changed (unless sending to a specific new client)
  if (!singleClient && !screenChanged && currentLogSeq === (session.lastLogSeq || 0)) return;
  if (screenChanged) session.lastRendered = screenStr;
  session.lastLogSeq = currentLogSeq;

  // Only send scrollback when it changes or to new clients — not every frame
  const scrollbackLen = session.term.scrollback.length;
  const scrollbackChanged = scrollbackLen !== (session.lastScrollbackLen || 0);
  session.lastScrollbackLen = scrollbackLen;

  // Build v1 payload for production clients
  const payload = {
    type: 'screen',
    lines: screen,
    cursor: { x: session.term.cx, y: session.term.cy },
    rows: session.term.rows,
    cols: session.term.cols,
    _ts: Date.now(),
    _perf: { render: +(tRender - t0).toFixed(2) },
  };

  if (singleClient || scrollbackChanged) {
    payload.scrollback = session.term.getScrollback();
  }

  const msg = JSON.stringify(payload);

  // Log slow frames
  const tDone = performance.now();
  if (tDone - t0 > 10) {
    console.log(`[PAN Terminal] Slow frame: render=${(tRender-t0).toFixed(1)}ms total=${(tDone-t0).toFixed(1)}ms size=${msg.length}`);
  }

  function sendToClient(client) {
    if (client.readyState !== 1) return;
    if (client._panDev) {
      // Dev client: send screen-v2 with incremental log
      const logData = session.term.getLogSince(client._logPosition || 0);
      const devPayload = {
        type: 'screen-v2',
        lines: screen,
        cursor: { x: session.term.cx, y: session.term.cy },
        rows: session.term.rows,
        cols: session.term.cols,
        altScreen: session.term.isAltScreen,
        logLength: logData.length,
        logSince: logData.fromSeq,
        logLines: logData.lines,
        _ts: Date.now(),
      };
      client.send(JSON.stringify(devPayload));
      client._logPosition = logData.nextSeq;
    } else {
      client.send(msg);
    }
  }

  if (singleClient) {
    sendToClient(singleClient);
  } else {
    for (const client of session.clients) {
      sendToClient(client);
    }
  }
}

// List active terminal sessions (for dashboard UI)
function listSessions() {
  const result = [];
  const now = Date.now();
  for (const [id, session] of sessions) {
    // Derive a real "thinking" signal: input was last AND no output for >300ms.
    // The 300ms grace prevents flicker from echo. The dashboard should bind
    // its "Claude is thinking" indicator to this, not local WS state.
    const lastIn = session.lastInputTs || 0;
    const lastOut = session.lastOutputTs || 0;
    // "Working" = user sent input AND we haven't been idle long enough to call it done.
    // Two signals merged:
    //   (a) classic "thinking": input is newer than output, and >300ms since last output
    //       (the 300ms grace prevents flicker from echo).
    //   (b) "still working": input happened, and output is still streaming within 2s
    //       (covers long tool calls — output bytes flow continuously, but we're not idle).
    // Either signal flips the indicator on. It only goes false when output has been
    // quiet for >2s AND input is older than output (i.e. genuinely waiting on the user).
    const inputNewer = lastIn > lastOut && now - lastOut > 300;
    const stillStreaming = lastIn > 0 && now - lastOut < 2000 && lastIn > lastOut - 60000;
    // Derive thinking from state machine — WORKING means AI is actively responding.
    // Fall back to legacy heuristics only if state hasn't been set yet (old sessions).
    const stateMachineWorking = session.state === SessionState.WORKING || session.state === SessionState.INTERRUPTED;
    const thinking = stateMachineWorking || !!session.claudeRunning || inputNewer || stillStreaming;
    const inFlight = getInFlightTool(session.cwd, session.claudeSessionIds);
    result.push({
      id,
      project: session.project,
      cwd: session.cwd,
      clients: session.clients.size,
      createdAt: session.createdAt,
      pid: session.pty?.pid,
      lastInputTs: lastIn,
      lastOutputTs: lastOut,
      thinking,
      // State machine values (authoritative)
      state: session.state || SessionState.IDLE,
      mode: session.mode || SessionMode.PTY_ONLY,
      // Legacy compat — derived from state machine, not from scattered booleans
      claudeRunning: stateMachineWorking || !!session.claudeRunning,
      pipeMode: (session.mode === SessionMode.ADAPTER) || !!session.pipeMode,
      messageCount: (session.messages || []).length,
      currentTool: inFlight ? {
        tool: inFlight.tool,
        summary: inFlight.summary,
        startedAt: inFlight.startedAt,
        isSubagent: !!inFlight.isSubagent,
      } : null,
    });
  }
  return result;
}

// Return live PTY pids (used by process kill protection + diagnostics).
function getActivePtyPids() {
  const pids = [];
  for (const [, session] of sessions) {
    if (session.pty?.pid) pids.push(session.pty.pid);
  }
  return pids;
}

// Kill every tracked PTY (called on graceful shutdown)
// Returns a Promise — caller must await to ensure WS broadcast lands before kill.
async function killAllSessions() {
  // Notify ALL connected WebSocket clients that the server is restarting
  // BEFORE killing PTYs. This sets the frontend's `serverRestarting` flag
  // so the reconnect handler knows to relaunch Claude after reconnecting.
  for (const [, session] of sessions) {
    for (const ws of session.clients) {
      try {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'server_restarting',
            reconnectToken: ws._reconnectToken || null,
          }));
        }
      } catch {}
    }
  }

  // Wait 200ms for WebSocket messages to flush to clients.
  // Without this, the socket is killed before the server_restarting message
  // reaches the frontend, causing wasServerRestart to be false and Claude
  // never auto-relaunches after restart.
  await new Promise(r => setTimeout(r, 200));

  let n = 0;
  for (const [id, session] of sessions) {
    // Persist shutdown event to per-tab transcript BEFORE killing anything
    try {
      const uptimeMs = Date.now() - (session.createdAt || Date.now());
      flushSession(id);
      writeSystemMessage(id, 'server_shutdown', `Server shutting down — session ${id} killed (uptime ${Math.round(uptimeMs/1000)}s)`);
    } catch {}
    // Flush current screen content to disk BEFORE killing the PTY.
    // This ensures anything visible in the terminal at shutdown time
    // is preserved and will appear when the session reconnects.
    try {
      if (session.term?.flushScreenToLog) {
        session.term.flushScreenToLog();
      }
    } catch (err) {
      console.error(`[PAN Terminal] Failed to flush log for ${id}:`, err.message);
    }
    try {
      session._plannedShutdown = true;  // suppress crash alert in onExit handler
      session.pty?.kill();
      n++;
    } catch {}
    sessions.delete(id);
  }
  return n;
}

// Kill a specific session
function killSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session._plannedShutdown = true;  // suppress crash alert in onExit handler
    if (session.pty) session.pty.kill();  // pipe sessions have pty:null — skip
    sessions.delete(sessionId);
    return true;
  }
  return false;
}

// Get projects available for terminal sessions
function getTerminalProjects() {
  const projects = all("SELECT id, name, path FROM projects ORDER BY name");
  return projects;
}

// #982 — every byte written to a PTY's stdin gets logged with a provenance tag
// so phantom prompts ("send a message to Alex" arriving in the user's chat with
// no breadcrumb) can be traced to the actual source. event_type='pty_input'.
function logPtyInput(sessionId, text, source, extra = {}) {
  try {
    // Skip noisy control-only writes (single \r, \x03, escape sequences)
    const t = String(text || '');
    if (!t.trim() || /^[\r\n\x03\x1b]+$/.test(t)) return;
    const dataStr = JSON.stringify({
      session_id: sessionId,
      text: t.slice(0, 200),
      text_len: t.length,
      source: source || 'unknown',
      ts: Date.now(),
      ...extra,
    });
    insert(`INSERT INTO events (session_id, event_type, data, org_id) VALUES (:sid, :type, :data, :oid)`, {
      ':sid': sessionId || 'pty-unknown',
      ':type': 'pty_input',
      ':data': dataStr,
      ':oid': 'org_personal',
    });
    if (source === 'unknown') {
      console.warn(`[PAN PTY] UNKNOWN-source input → ${sessionId}: ${JSON.stringify(t.slice(0, 80))}`);
    }
  } catch (e) {
    // Never let logging break a PTY write
    console.warn(`[PAN PTY] logPtyInput failed: ${e.message}`);
  }
}

// Send text to a terminal session (used by phone voice commands)
// If no sessionId given, sends to the most recently active session
// #982 — `source` is REQUIRED provenance: 'user_keyboard', 'voice_pipeline',
// 'test_harness', 'agent_handoff', 'mcp_tool', 'steward', 'carrier_handoff', 'system'.
// `label` is the legacy 3rd arg (rarely used) preserved for compat.
function sendToSession(sessionId, text, label, source = 'unknown') {
  console.log(`[PAN Terminal] sendToSession(${sessionId}, ${JSON.stringify(text)}, source=${source}) bytes: ${[...text].map(c => c.charCodeAt(0).toString(16)).join(' ')}`);
  let session;
  if (sessionId) {
    session = sessions.get(sessionId);
  } else {
    // Find the most recently created session with clients, or any session
    let best = null;
    for (const [id, s] of sessions) {
      if (!best || s.clients.size > best.clients.size || s.createdAt > best.createdAt) {
        best = s;
      }
    }
    session = best;
  }

  if (session && session.pty) {
    session.lastInputTs = Date.now();
    logPtyInput(session.id, text, source, { label: label || null, route: 'sendToSession' });
    session.pty.write(text);
    return true;
  }
  return false;
}

// Pending permission prompts — for mobile polling and hook-based permission flow
let pendingPermissions = [];

function addPendingPermission(data) {
  const permId = data.id || Date.now();
  pendingPermissions.push({ ...data, id: permId, response: data.response || null });
  // Safety net — auto-expire after 5 minutes if nobody responds
  setTimeout(() => {
    pendingPermissions = pendingPermissions.filter(p => p.id !== permId);
  }, 300000);
}

function getPendingPermissions() {
  // Filter out stale permissions (>30s old with no response — likely handled via terminal)
  const cutoff = Date.now() - 30000;
  pendingPermissions = pendingPermissions.filter(p => p.id > cutoff || p.response);
  return pendingPermissions.filter(p => !p.response);
}

function clearPermission(id) {
  pendingPermissions = pendingPermissions.filter(p => p.id !== id);
}

// Set the response on a pending permission (called when mobile user taps Allow/Deny)
function respondToPermission(id, response) {
  console.log(`[PAN Perm] respondToPermission called: id=${id} (type=${typeof id}), response=${response}`);
  console.log(`[PAN Perm] Pending permissions: ${pendingPermissions.map(p => `${p.id}(type=${typeof p.id})`).join(', ')}`);
  // Match by number or string — mobile might send either
  const perm = pendingPermissions.find(p => p.id === id || p.id === String(id) || String(p.id) === String(id));
  if (perm) {
    perm.response = response; // 'allow' or 'deny'
    console.log(`[PAN Perm] Set response=${response} on perm ${perm.id}`);
    return true;
  }
  console.log(`[PAN Perm] Permission ${id} NOT FOUND in pending list`);
  return false;
}

// Broadcast a notification to ALL connected WebSocket clients (across all sessions)
// Used by hooks to notify dashboard of new events
function broadcastNotification(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const [, session] of sessions) {
    for (const client of session.clients) {
      if (client.readyState === 1) {
        try { client.send(msg); } catch {}
      }
    }
  }
}

// Find the PTY session that owns a given Claude session ID.
// Returns the PTY sessionId string, or null if no match.
function findSessionByClaudeId(claudeSessionId) {
  if (!claudeSessionId) return null;
  for (const [id, session] of sessions) {
    if (session.claudeSessionIds && session.claudeSessionIds.includes(claudeSessionId)) {
      return id;
    }
  }
  return null;
}

// Broadcast a chat_update to ONLY the tab that owns this Claude session.
// Uses cwd-based routing for new sessions (before any tab has claimed the Claude ID)
// to prevent cross-tab contamination when multiple tabs share the same project.
function broadcastChatUpdate(data) {
  const claudeSessionId = data?.session_id;
  const cwd = data?.cwd || '';

  // 1. Known owner — fast path
  const ownerSessionId = findSessionByClaudeId(claudeSessionId);
  if (ownerSessionId) {
    broadcastToSession(ownerSessionId, 'chat_update', data);
    return;
  }

  // 2. New session — route to the most-recently-created tab with matching cwd
  //    that hasn't claimed a Claude session yet. This pinpoints the brand-new
  //    tab that just launched Claude, avoiding the broadcast-to-all race.
  if (cwd) {
    const normCwd = cwd.toLowerCase().replace(/\\/g, '/');
    let bestSid = null;
    let bestCreatedAt = 0;
    for (const [sid, session] of sessions) {
      const sessionCwd = (session.cwd || '').toLowerCase().replace(/\\/g, '/');
      if (sessionCwd !== normCwd) continue;
      if ((session.claudeSessionIds || []).length > 0) continue; // already owns a Claude session
      if ((session.createdAt || 0) > bestCreatedAt) {
        bestCreatedAt = session.createdAt || 0;
        bestSid = sid;
      }
    }
    if (bestSid) {
      broadcastToSession(bestSid, 'chat_update', data);
      return;
    }
  }

  // 3. True fallback: unknown cwd or no unclaimed session — broadcast to all
  //    so at least one tab can claim it. Should be rare after the cwd fix.
  broadcastNotification('chat_update', data);
}

// Broadcast to a SPECIFIC session's WebSocket clients
function broadcastToSession(sessionId, type, data) {
  let session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    // Fallback: find most active session (same logic as sendToSession)
    let best = null;
    for (const [, s] of sessions) {
      if (!best || s.clients.size > best.clients.size || s.createdAt > best.createdAt) best = s;
    }
    session = best;
  }
  if (!session) return;
  const msg = JSON.stringify({ type, ...data });
  for (const client of session.clients) {
    if (client.readyState === 1) {
      try { client.send(msg); } catch {}
    }
  }
}

// Legacy aliases — dev terminal now uses the same server-side renderer
function listDevSessions() { return listSessions(); }
function killDevSession(id) { return killSession(id); }

async function startDevTerminalServer(httpServer) {
  // Dev uses the same terminal server — identical PTY, WebSocket, ScreenBuffer.
  // The only difference is the HTTP server instance (dev port vs prod port).
  return startTerminalServer(httpServer);
}

// Proxy WebSocket to Whisper streaming server (port 7783)
// This lets the dashboard connect to ws://<same-origin>/ws/whisper instead of cross-origin ws://127.0.0.1:7783
function proxyWhisperWs(request, socket, head) {
  const upstream = new WebSocket('ws://127.0.0.1:7783');

  upstream.on('open', () => {
    const proxyWss = new WebSocketServer({ noServer: true });
    proxyWss.handleUpgrade(request, socket, head, (clientWs) => {
      clientWs.on('message', (data, isBinary) => {
        if (upstream.readyState === 1) upstream.send(data, { binary: isBinary });
      });
      clientWs.on('close', () => upstream.close());
      upstream.on('message', (data, isBinary) => {
        if (clientWs.readyState === 1) clientWs.send(data, { binary: isBinary });
      });
      upstream.on('close', () => { if (clientWs.readyState === 1) clientWs.close(); });
    });
  });

  upstream.on('error', () => {
    socket.destroy();
  });
}

// Create a lightweight pipe-only session (no PTY) for mobile new-tab flow.
// The ClaudeAdapter is created lazily on first pipeSend — no PTY needed.
function createPipeSession(sessionId, { cwd = null, projectName = '' } = {}) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const resolvedCwd = cwd || process.env.USERPROFILE || '%USERPROFILE%\\Desktop';
  const term = new ScreenBufferClass(120, 30);
  const logFile = join(TERMINAL_LOG_DIR, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.jsonl');
  term.setLogFile(logFile);
  term.loadLogFile();
  const session = {
    pty: null,
    term,
    clients: new Set(),
    project: projectName,
    cwd: resolvedCwd,
    createdAt: Date.now(),
    renderTimer: null,
    lastRendered: '',
    state: SessionState.IDLE, // pipe sessions are immediately ready (no PTY spawn wait)
    mode: SessionMode.ADAPTER, // pipe sessions are always in adapter mode
    messages: [],
    _messageVersion: 0,
    systemMessages: [],
    lastInputTs: 0,
    lastOutputTs: Date.now(),
    claudeRunning: false,
    claudeExited: false,
    pipeMode: true,
    claudeSessionIds: [],
    // Per-session model override (see pipeSetModel) — keeps tabs independent.
    model: null,
    _streamMessages: [],
    _jsonBuf: '',
    _claudeSessionId: null,
  };
  sessions.set(sessionId, session);
  console.log(`[PAN Terminal] Created pipe session: ${sessionId} cwd=${resolvedCwd}`);
  return session;
}

// Debug: expose per-session stream buffer size for regression testing (#437)
function getSessionBufferSize(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return null;
  return {
    streamMessages: sess._streamMessages?.length ?? 0,
    systemMessages: sess.systemMessages?.length ?? 0,
    maxStreamMessages: sess._maxStreamMessages || 500,
  };
}

// ── Stuck-WORKING watchdog ────────────────────────────────────────────────────
// If a pipe session stays in WORKING state for >60s with no output, recover to IDLE.
// Two cases:
//   A. Adapter is NOT busy — .catch() was missed or adapter silently died.
//      Threshold: 60s no output.
//   B. Adapter IS busy but hung — internal deadlock, network stall, etc.
//      Threshold: 90s no output (extra grace, since real long responses are possible).
// Previously the watchdog bailed on adapter.busy — meaning a hung-but-busy adapter
// would keep the session stuck WORKING forever. Fixed: time threshold overrides busy.
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.state !== SessionState.WORKING) continue;
    const lastOut = session.lastOutputTs || 0;
    const stuckMs = now - lastOut;
    const adapterBusy = !!session._llmAdapter?.busy;
    // Grace period: busy adapters get 90s, non-busy get 60s
    const threshold = adapterBusy ? 90_000 : 60_000;
    if (stuckMs > threshold) {
      console.warn(`[Terminal] Session ${id} stuck WORKING for ${Math.round(stuckMs/1000)}s (adapterBusy=${adapterBusy}) — recovering to IDLE`);
      session.claudeRunning = false;
      // Force-cancel the adapter if it claims to be busy but is clearly hung
      if (adapterBusy) {
        try { session._llmAdapter?.cancel?.(); } catch {}
      }
      transitionState(session, SessionState.IDLE, `watchdog recovery: stuck ${Math.round(stuckMs/1000)}s adapterBusy=${adapterBusy}`);
      // Tell clients we recovered so they re-enable the input immediately
      for (const c of session.clients) {
        if (c.readyState === WebSocket.OPEN) {
          try { c.send(JSON.stringify({ type: 'pipe_ready' })); } catch {}
        }
      }
    }
  }
}, 15_000); // check every 15s — catches stuck state within ~105s worst case (busy adapter)

// ── Dead-claude-inside-live-PTY watchdog ──────────────────────────────────────
// PTY sessions spawn `bash → claude`. If claude exits but bash keeps running,
// ptyProcess.onExit never fires, _claudeCliPid points to a dead PID, and
// session.state stays WORKING. Frontend "Claude is thinking" latches forever.
// Detection: poll _claudeCliPid liveness; if dead, recover state + tell user.
setInterval(() => {
  for (const [id, session] of sessions) {
    const pid = session._claudeCliPid;
    if (!pid) continue;
    // Adapter mode (pipe sessions) has no real PTY-child claude — skip.
    if (session.mode === SessionMode.ADAPTER) continue;
    // Liveness probe: signal 0 is a no-op that throws ESRCH if pid is gone.
    // EPERM means the pid exists but we lack permission — still alive.
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (e) { alive = (e.code === 'EPERM'); }
    if (alive) continue;

    const deadPid = pid;
    session._claudeCliPid = null;
    try { deregisterProcess(deadPid, -1); } catch {}

    // Only escalate if the frontend would otherwise be locked (WORKING / legacy claudeRunning).
    // If state is already IDLE, the bash-prompt detector already cleaned up — stay quiet.
    const wasLocked =
      session.state === SessionState.WORKING ||
      session.state === SessionState.INTERRUPTED ||
      !!session.claudeRunning;

    session.claudeRunning = false;
    if (!wasLocked) {
      console.log(`[Terminal] Session ${id}: claude CLI pid ${deadPid} gone (state=${session.state}) — quiet cleanup`);
      continue;
    }

    console.warn(`[Terminal] Session ${id}: claude CLI pid ${deadPid} exited but PTY still alive — recovering session`);
    transitionState(session, SessionState.IDLE, `claude cli pid ${deadPid} gone, PTY alive`);

    // Persist + broadcast a clear system message so the user knows what happened
    // and how to recover (instead of staring at a stuck spinner).
    const resumeHint =
      (session.claudeSessionIds && session.claudeSessionIds.length)
        ? `Run \`claude -r ${session.claudeSessionIds[session.claudeSessionIds.length - 1]}\` in this shell to resume the conversation.`
        : `Run \`claude\` in this shell to start a new session, or check \`~/.claude/projects/\` for the JSONL transcript.`;
    const msg = `Claude exited (PID ${deadPid} no longer running). The shell is still alive. ${resumeHint}`;
    try {
      appendMessage(session, {
        role: 'system', type: 'banner',
        text: msg,
        ts: new Date().toISOString(),
        source: 'system',
      });
    } catch {}
    try { writeSystemMessage(id, 'claude_exit', msg); } catch {}
    try {
      insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
        ':sid': id,
        ':type': 'ClaudeCliExitDetected',
        ':data': JSON.stringify({
          session_id: id,
          project: session.project,
          dead_pid: deadPid,
          claude_session_ids: session.claudeSessionIds || [],
          timestamp: Date.now(),
        }),
      });
    } catch {}
    for (const c of session.clients) {
      if (c.readyState === 1) {
        try {
          c.send(JSON.stringify({
            type: 'claude_exit',
            session: id,
            pid: deadPid,
            message: msg,
            resumable_session_ids: session.claudeSessionIds || [],
          }));
          c.send(JSON.stringify({
            type: 'transcript_messages',
            messages: session.messages || [],
            version: session._messageVersion || 0,
          }));
        } catch {}
      }
    }
  }
}, 5_000); // 5s cadence — fast enough to feel responsive, light enough to be cheap

// ── Claude-session-UUID capture watchdog ──────────────────────────────────────
// When `claude` runs inside a PTY (PTY_WITH_CLAUDE mode), it writes its
// transcript to `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`. PAN needs to
// know that UUID so it can:
//   1. Persist it on open_tabs.claude_session_ids → tab is searchable later
//   2. Show transcript history on resume
//   3. Pass `claude -r <uuid>` when re-attaching
// The adapter (ADAPTER mode) captures this via getSessionId(); PTY_WITH_CLAUDE
// has no such hook, so we scan the filesystem.
//
// Strategy: every 10s, for each PTY_WITH_CLAUDE session with a live
// _claudeCliPid, list the project dir, find JSONLs modified within the last
// 5 min, read first line, check the `cwd` field. If it matches AND the UUID
// isn't already in session.claudeSessionIds, add it + persist to open_tabs.
function cwdToProjectSlug(cwd) {
  // Replicates how Claude Code mangles a cwd into its projects folder name.
  // Observed: `%USERPROFILE%\Desktop\PAN` → `C--Users-owner-Desktop-PAN`
  // Rule: replace any of  : \ / .  with `-`
  return String(cwd || '').replace(/[\\/:.]/g, '-');
}

function findClaudeJsonlForSession(cwd) {
  try {
    const slug = cwdToProjectSlug(cwd);
    const projectDir = join(homedir(), '.claude', 'projects', slug);
    if (!existsSync(projectDir)) return null;
    const cutoff = Date.now() - 5 * 60 * 1000; // last 5 min
    const candidates = [];
    for (const fname of readdirSync(projectDir)) {
      if (!fname.endsWith('.jsonl')) continue;
      const full = join(projectDir, fname);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      candidates.push({ uuid: fname.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, path: full });
    }
    if (!candidates.length) return null;
    // Newest first — most likely the live session
    candidates.sort((a, b) => b.mtime - a.mtime);
    // Verify the first line's cwd matches (defensive — slug collisions are rare but possible)
    for (const c of candidates) {
      try {
        const head = readFileSync(c.path, 'utf-8').split('\n', 1)[0];
        if (!head) continue;
        const obj = JSON.parse(head);
        const fileCwd = obj?.cwd || obj?.message?.cwd || null;
        if (!fileCwd) {
          // No cwd field — accept by slug match alone
          return c.uuid;
        }
        if (String(fileCwd).toLowerCase() === String(cwd).toLowerCase()) return c.uuid;
      } catch {}
    }
    // Fallback: just return the newest UUID if cwd verification didn't match
    return candidates[0].uuid;
  } catch (e) {
    console.warn(`[Terminal] findClaudeJsonlForSession failed:`, e.message);
    return null;
  }
}

function persistClaudeSessionIdsToOpenTabs(panSessionId, claudeSessionIds) {
  try {
    // Read existing row (any org) — we update by session_id which is globally unique per tab
    const row = get(`SELECT id, claude_session_ids FROM open_tabs WHERE session_id = :sid`, { ':sid': panSessionId });
    if (!row) return false;
    let existing = [];
    try { existing = JSON.parse(row.claude_session_ids || '[]'); } catch {}
    const merged = Array.from(new Set([...(existing || []), ...claudeSessionIds]));
    if (merged.length === existing.length && merged.every((v, i) => v === existing[i])) {
      return false; // no change
    }
    run(
      `UPDATE open_tabs SET claude_session_ids = :ids, last_active = datetime('now','localtime') WHERE id = :id`,
      { ':ids': JSON.stringify(merged), ':id': row.id }
    );
    console.log(`[Terminal] open_tabs.claude_session_ids ← [${merged.join(', ')}] for ${panSessionId}`);
    // Mirror event so this is queryable historically
    try {
      insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
        ':sid': panSessionId,
        ':type': 'ClaudeSessionLinked',
        ':data': JSON.stringify({ pan_session_id: panSessionId, claude_session_ids: merged, ts: Date.now() }),
      });
    } catch {}
    return true;
  } catch (e) {
    console.warn(`[Terminal] persistClaudeSessionIdsToOpenTabs failed:`, e.message);
    return false;
  }
}

setInterval(() => {
  for (const [id, session] of sessions) {
    // Only PTY-with-claude sessions need this — adapter sessions already have
    // their UUID via _llmAdapter.getSessionId().
    if (session.mode === SessionMode.ADAPTER) continue;
    if (!session._claudeCliPid) continue;
    if (!session.cwd) continue;

    const uuid = findClaudeJsonlForSession(session.cwd);
    if (!uuid) continue;

    const known = session.claudeSessionIds || [];
    if (known.includes(uuid)) continue;

    session.claudeSessionIds = [...known, uuid];
    console.log(`[Terminal] Linked claude session ${uuid} → tab ${id}`);

    // Mirror to reconnect tokens so a refresh/reconnect carries the UUID
    for (const c of session.clients) {
      if (c._reconnectToken) {
        try { updateTokenClaudeSessions(c._reconnectToken, session.claudeSessionIds); } catch {}
      }
    }
    // Persist to DB
    persistClaudeSessionIdsToOpenTabs(id, session.claudeSessionIds);
    // Broadcast so the frontend can update its tab metadata in-place
    for (const c of session.clients) {
      if (c.readyState === 1) {
        try {
          c.send(JSON.stringify({
            type: 'claude_session_linked',
            session: id,
            claude_session_ids: session.claudeSessionIds,
          }));
        } catch {}
      }
    }
  }
}, 10_000); // 10s — JSONLs are created/written immediately on claude startup

export { startTerminalServer, startDevTerminalServer, listSessions, killSession, killAllSessions, getActivePtyPids, getTerminalProjects, sendToSession, broadcastToSession, broadcastNotification, broadcastChatUpdate, findSessionByClaudeId, getPendingPermissions, clearPermission, addPendingPermission, respondToPermission, listDevSessions, killDevSession, setInFlightTool, clearInFlightTool, getInFlightTool, registerProcess, deregisterProcess, getProcessRegistry, pipeSend, pipeInterrupt, pipeSetModel, pipeResetAdapter, getSessionMessages, createPipeSession, getSessionBufferSize, delegateToPhoneToolsSession };

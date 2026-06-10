// PAN Claude Control — dedicated always-on Claude PTY for computer control.
//
// User design 2026-06-09: "Claude as a terminal as a service, some background
// service that always allows me to send messages to it. That can always be
// the terminal that's always running. We're just gonna type Claude in there
// to start it. The only specific thing that one is gonna do is computer
// control. Right? That's that's that's main purpose, just computer control."
//
// Why this exists:
//   The dashboard terminal UI is brittle (model picker shows stale values,
//   PTY tabs don't refresh, fresh sessions are slow to spawn). The user has
//   given up on it. But there's still a real need: a Claude Code agent that
//   PAN's voice loop can dispatch computer-control tasks to without paying
//   the spawn cost every time.
//
// Design:
//   - One PTY, owned by this service, spawning `claude` on this host (the
//     "Hub" — always-on PC). It uses whatever model Claude Code defaults to,
//     so model updates flow through naturally.
//   - Well-known session id 'claude-control' so the skill dispatcher can
//     address it without lookup.
//   - Ring-buffered output (last ~16 KB) for short-window awareness.
//     The voice loop can speak the most recent N lines after sending.
//   - Auto-respawn on exit. Steward owns the restart cadence.
//   - Completely outside the dashboard terminal stack — no Carrier PTY
//     ownership, no Tabs UI. This is a backend service, not a user surface.
//
// Public API:
//   startClaudeControl(opts?)   — spawn the PTY (idempotent)
//   stopClaudeControl()          — kill the PTY (used by Steward shutdown)
//   sendCommand(text)            — write text + Enter to the PTY
//   getRecentOutput(maxBytes?)   — last N bytes of stdout
//   getStatus()                  — { running, pid, restarts, last_send_at }
//
// Routing: a `send-to-claude` skill catches voice phrases like "tell claude
// to open notepad" or "ask claude to rename these files" and calls
// sendCommand() via the router action handler.

import pty from 'node-pty';
import { hostname, platform } from 'os';

const IS_WINDOWS = platform() === 'win32';

// Ring buffer for recent stdout. 16 KB is enough to read back the last
// 200-300 lines (typical claude code response is 1-3 KB). Larger and we
// risk holding stale context the voice path might mistake for current.
const OUTPUT_RING_SIZE = 16 * 1024;

const state = {
  proc:        /** @type {import('node-pty').IPty | null} */ (null),
  outputRing:  Buffer.alloc(0),
  startedAt:   0,
  lastSendAt:  0,
  restarts:    0,
  // Restart backoff so a broken `claude` install doesn't spin-loop the host.
  // 1m, 2m, 4m, 8m (cap). Reset on a 10-minute clean run.
  backoffMs:   60_000,
};

function _appendOutput(chunk) {
  const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  const combined = Buffer.concat([state.outputRing, buf]);
  state.outputRing = combined.length > OUTPUT_RING_SIZE
    ? combined.slice(combined.length - OUTPUT_RING_SIZE)
    : combined;
}

// The claude binary lives in different places per OS / install. Probe order:
//   1. CLAUDE_BIN env var (escape hatch for non-standard installs)
//   2. PATH lookup ("claude")
// We use the shell to resolve so npx-style wrappers, Windows .cmd shims, and
// nvm-managed installs all work without per-platform branches.
function _commandShape() {
  if (IS_WINDOWS) {
    return { file: 'cmd.exe', args: ['/c', process.env.CLAUDE_BIN || 'claude'] };
  }
  return { file: 'sh', args: ['-c', process.env.CLAUDE_BIN || 'claude'] };
}

export function startClaudeControl() {
  if (state.proc) return state.proc;
  const { file, args } = _commandShape();
  try {
    state.proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' }, // disable ANSI so the ring is readable as plain text
    });
    state.startedAt = Date.now();
    console.log(`[ClaudeControl] spawned (pid=${state.proc.pid})`);

    state.proc.onData((data) => { _appendOutput(data); });
    state.proc.onExit(({ exitCode, signal }) => {
      console.warn(`[ClaudeControl] exited code=${exitCode} signal=${signal}; restarting in ${state.backoffMs}ms`);
      state.proc = null;
      state.restarts += 1;
      // If the previous run lasted >10 min, treat as clean — reset backoff.
      // Otherwise grow it so a busted install doesn't burn the host.
      const lifetime = Date.now() - state.startedAt;
      if (lifetime > 10 * 60_000) state.backoffMs = 60_000;
      else state.backoffMs = Math.min(state.backoffMs * 2, 8 * 60_000);
      setTimeout(() => { try { startClaudeControl(); } catch {} }, state.backoffMs);
    });
  } catch (err) {
    console.error('[ClaudeControl] spawn failed:', err.message);
    state.proc = null;
  }
  return state.proc;
}

export function stopClaudeControl() {
  if (!state.proc) return;
  try { state.proc.kill(); } catch {}
  state.proc = null;
}

export function sendCommand(text) {
  if (!state.proc) return { ok: false, error: 'claude-control PTY not running' };
  if (typeof text !== 'string' || !text.length) return { ok: false, error: 'empty text' };
  try {
    // claude reads stdin like a normal REPL — newline submits. We trim
    // any trailing whitespace from the caller's input, then append exactly
    // one \r so the PTY interprets it as Enter.
    state.proc.write(text.replace(/[\r\n]+$/, '') + '\r');
    state.lastSendAt = Date.now();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Strip common ANSI escape sequences. Even with FORCE_COLOR=0 some control
// sequences (cursor moves, screen clears) sneak in. We don't need them in
// the voice path so this keeps the ring readable as plain text.
function _stripAnsi(s) {
  return String(s).replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1B[@-_]/g, '');
}

export function getRecentOutput(maxBytes = OUTPUT_RING_SIZE) {
  const text = _stripAnsi(state.outputRing.toString('utf8'));
  if (text.length <= maxBytes) return text;
  return text.slice(text.length - maxBytes);
}

// Convenience for the voice path — wait briefly for output after a send so
// we have something to speak back as confirmation. Returns the new bytes
// that arrived after `sinceTs`. Polls cheaply since there's no event.
export async function waitForOutput(sinceTs, timeoutMs = 6_000) {
  const start = Date.now();
  let lastLen = state.outputRing.length;
  while (Date.now() - start < timeoutMs) {
    if (state.outputRing.length > lastLen) {
      // Give the PTY ~250ms to finish the current chunk so we don't return
      // a half-line response that's incomplete for TTS.
      await new Promise(r => setTimeout(r, 250));
      const slice = state.outputRing.slice(lastLen);
      return _stripAnsi(slice.toString('utf8'));
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

export function getStatus() {
  return {
    running:        !!state.proc,
    pid:            state.proc?.pid || null,
    started_at:     state.startedAt,
    last_send_at:   state.lastSendAt,
    restarts:       state.restarts,
    backoff_ms:     state.backoffMs,
    host:           hostname(),
    output_bytes:   state.outputRing.length,
  };
}

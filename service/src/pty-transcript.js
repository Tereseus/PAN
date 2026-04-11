// PTY Transcript — LLM-agnostic transcript capture from PTY I/O.
//
// Captures user input and PTY output as structured messages, stored in
// PAN's own transcript files per session. Works with any LLM or process
// running in the terminal — not tied to Claude's JSONL format.
//
// Architecture:
//   - User input: buffered keystrokes, flushed as {role:'user'} on Enter
//   - PTY output: buffered raw output, ANSI-stripped, flushed as {role:'assistant'}
//     after a quiet period (no new output for 300ms)
//   - System events: written directly (PTY exit, restart, interrupt, etc.)
//   - Each session gets its own file: {dataDir}/transcripts/{sessionId}.jsonl
//   - Subscribers get notified on every write (for real-time push to dashboard)

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { getDataDir } from './platform.js';

const TRANSCRIPT_DIR = join(getDataDir(), 'transcripts');
try { mkdirSync(TRANSCRIPT_DIR, { recursive: true }); } catch {}

// sessionId → { subscribers: Set<callback>, inputBuffer, outputBuffer, flushTimer }
const sessions = new Map();

// sessionId → tab name slug (for human-readable filenames)
// File is named after tab name: "PAN Main" → "pan-main.jsonl"
const sessionNames = new Map();

// Set the display name for a session (used as filename)
export function setSessionName(sessionId, tabName) {
  const oldSlug = sessionNames.get(sessionId);
  const newSlug = slugify(tabName);
  if (oldSlug && oldSlug !== newSlug) {
    // Rename the file on disk
    const oldPath = join(TRANSCRIPT_DIR, oldSlug + '.jsonl');
    const newPath = join(TRANSCRIPT_DIR, newSlug + '.jsonl');
    if (existsSync(oldPath) && !existsSync(newPath)) {
      try {
        renameSync(oldPath, newPath);
        console.log(`[pty-transcript] Renamed: ${oldSlug}.jsonl → ${newSlug}.jsonl`);
      } catch (err) {
        console.error('[pty-transcript] rename error:', err.message);
      }
    }
  }
  sessionNames.set(sessionId, newSlug);
}

function slugify(name) {
  return (name || 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
}

// Strip ALL ANSI/VT100 escape sequences from raw PTY output
function stripAnsi(str) {
  return str
    // CSI sequences: ESC [ (any intermediate/param bytes) final byte
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[\x20-\x3f]*[\x30-\x3f]*[\x40-\x7e]/g, '')
    // OSC sequences: ESC ] ... (terminated by BEL or ST)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Private/intermediate sequences: ESC > ESC = ESC < plus content
    .replace(/\x1b[>=<][^\x1b]*/g, '')
    // DCS sequences: ESC P ... ST
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    // Two-character ESC sequences: ESC + single char (charset, mode, etc.)
    .replace(/\x1b[^[\]P\x1b]/g, '')
    // Remaining bare ESC
    .replace(/\x1b/g, '')
    // Control chars (except \n \t)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // Bell
    .replace(/\x07/g, '')
    // Normalize line endings, then honor carriage returns:
    // \r means "go back to start of line", so anything before the last \r
    // on a line gets overwritten. This matters for Claude Code's spinner,
    // which rewrites a status line many times per second — treating each
    // frame as a new \n produced a wall of fragments like "{thinking}".
    .replace(/\r\n/g, '\n')
    .replace(/[^\n]*\r(?=[^\n])/g, '')
    .replace(/\r/g, '');
}

function getTranscriptPath(sessionId) {
  // Use tab name slug if set, otherwise fall back to session ID
  const slug = sessionNames.get(sessionId) || sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(TRANSCRIPT_DIR, slug + '.jsonl');
}

function appendMessage(sessionId, message) {
  const filepath = getTranscriptPath(sessionId);
  // Dedup: skip if last message has same role+type and identical text
  const entry = sessions.get(sessionId);
  if (entry && entry._lastMsg) {
    const last = entry._lastMsg;
    if (last.role === message.role && last.type === message.type && last.text === message.text) return;
  }
  if (entry) entry._lastMsg = { role: message.role, type: message.type, text: message.text };
  const line = JSON.stringify({ ...message, timestamp: new Date().toISOString() }) + '\n';
  try {
    appendFileSync(filepath, line);
  } catch (err) {
    console.error('[pty-transcript] write error:', err.message);
    return;
  }
  // Notify subscribers
  const subEntry = sessions.get(sessionId);
  if (subEntry) {
    console.log(`[pty-transcript] appendMessage ${sessionId}: ${subEntry.subscribers.size} subscribers, role=${message.role}`);
    for (const sub of subEntry.subscribers) {
      try { sub(readTranscript(sessionId)); } catch (err) { console.error('[pty-transcript] subscriber error:', err.message); }
    }
  }
}

// Read and parse a session's transcript file
export function readTranscript(sessionId) {
  const filepath = getTranscriptPath(sessionId);
  if (!existsSync(filepath)) return [];
  try {
    const raw = readFileSync(filepath, 'utf-8').trim();
    if (!raw) return [];
    const messages = [];
    for (const line of raw.split('\n')) {
      try {
        const obj = JSON.parse(line);
        messages.push(obj);
      } catch { continue; }
    }
    return messages;
  } catch (err) {
    console.error('[pty-transcript] read error:', err.message);
    return [];
  }
}

function getOrCreateSession(sessionId) {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = {
      subscribers: new Set(),
      inputBuffer: '',
      outputBuffer: '',
      outputFlushTimer: null,
      lastRole: null, // track last written role to coalesce output
    };
    sessions.set(sessionId, entry);
  }
  return entry;
}

// Called when user sends keystroke input via WebSocket
export function captureInput(sessionId, data) {
  const entry = getOrCreateSession(sessionId);

  // Flush any pending output before recording user input
  if (entry.outputBuffer.length > 0) {
    flushOutput(sessionId, entry);
  }

  // Buffer keystrokes — flush on Enter (\r or \n)
  entry.inputBuffer += data;

  if (data.includes('\r') || data.includes('\n')) {
    const text = entry.inputBuffer.replace(/[\r\n]+$/, '').trim();
    entry.inputBuffer = '';
    if (text) {
      // Don't record control sequences as user input (arrows, tab, etc.)
      const stripped = stripAnsi(text);
      if (stripped && stripped.length > 0 && !/^[\x00-\x1f]+$/.test(stripped)) {
        appendMessage(sessionId, { role: 'user', type: 'input', text: stripped });
        entry.lastRole = 'user';
      }
    }
  }
}

// Called on every PTY output chunk
export function captureOutput(sessionId, data) {
  const entry = getOrCreateSession(sessionId);
  entry.outputBuffer += data;

  // Debounce: flush after 1500ms of quiet (coalesce streaming LLM output into
  // complete messages rather than fragmenting across many small chunks)
  if (entry.outputFlushTimer) clearTimeout(entry.outputFlushTimer);
  entry.outputFlushTimer = setTimeout(() => {
    flushOutput(sessionId, entry);
  }, 1500);
}

// Characters that are purely TUI decoration / spinner noise
const TUI_NOISE_CHARS = /[✻✶✽✢●·▐▛▜▘▝█▀▄░▒▓─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬…*+]/g;

// Lines that are entirely TUI noise (after stripping noise chars + whitespace)
function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return true;
  // Strip all TUI noise chars — if nothing meaningful remains, it's noise
  const meaningful = t.replace(TUI_NOISE_CHARS, '').replace(/\s+/g, '').trim();
  if (meaningful.length < 2) return true;
  // Spinner status words (with or without repetition/concatenation)
  // Claude Code uses many spinner labels (Cooking, Smooshing, Bootstrapping, etc.)
  // Match repeated CapitalizedWords optionally followed by …/./ellipsis
  if (/^[A-Z][a-z]+[.\s…]*([A-Z][a-z]+[.\s…]*)*$/m.test(meaningful) && meaningful.length < 80) return true;
  // Spinner status line WITH a trailing stats parenthetical:
  //   "Cooking… (5s · ↑ 25 tokens · esc to interrupt)"
  //   "Smooshing… (12s · ↓ 1.2k tokens)"
  if (/^[A-Z][a-z]+[….]*\s*\(.*(tokens|interrupt|esc).*\)\s*$/i.test(t)) return true;
  // {thinking} / (thinking) tags, possibly repeated back-to-back
  //   "thinking", "{thinking}", "{thinking}{thinking}{thinking}", "(thinking)(thinking)"
  if (/^(?:[\{\(]?thinking[\}\)]?)+$/i.test(meaningful)) return true;
  // After removing every "thinking" occurrence and punctuation, if nothing
  // meaningful remains, it was a wall of thinking fragments.
  {
    const noThink = meaningful.replace(/[\{\(]?thinking[\}\)]?/gi, '');
    if (/thinking/i.test(meaningful) && noThink.replace(/[^a-z0-9]/gi, '').length === 0) return true;
  }
  // Claude Code prompt line: ❯ (empty or with text that duplicates user input)
  if (/^❯/.test(t)) return true;
  // Horizontal rule (box-drawing only)
  if (/^[─═┄┈╌]+$/.test(t)) return true;
  // Claude Code banner: ▐▛███▜▌ or ▝▜█████▛▘ etc.
  if (/^[▐▛▜▘▝█\s]*$/.test(t)) return true;
  if (/ClaudeCode\s*v[\d.]+/i.test(meaningful)) return true;
  if (/Opus.*context.*ClaudeMax/i.test(meaningful)) return true;
  // Status bar lines: "? for shortcuts", "esc to interrupt", session limit
  if (/^\??\s*for\s*shortcuts/i.test(meaningful)) return true;
  if (/^esc\s*to\s*interrupt/i.test(meaningful)) return true;
  if (/session\s*limit.*resets/i.test(meaningful)) return true;
  if (/Found\s*\d+\s*keybinding\s*error/i.test(meaningful)) return true;
  if (/\/doctor\s*for\s*details/i.test(meaningful)) return true;
  if (/\/upgrade\s*to\s*keep/i.test(meaningful)) return true;
  if (/running\s*stop\s*hook/i.test(meaningful)) return true;
  // Path-only lines like ~\Desktop\PAN
  if (/^~?\\[\w\\]+$/.test(meaningful)) return true;
  // Bash prompt
  if (/^[a-z]+@\S+\s+MINGW\d+\s+\S+\s*(\(.*\))?\s*\$?\s*$/.test(t)) return true;
  // CLI launch command echo (PTY echoes the command that launched the LLM)
  if (/^claude\s+(--|\S)/.test(t)) return true;
  if (/^opencode\s/i.test(t)) return true;
  if (/^aider\s/i.test(t)) return true;
  return false;
}

function flushOutput(sessionId, entry) {
  if (entry.outputFlushTimer) {
    clearTimeout(entry.outputFlushTimer);
    entry.outputFlushTimer = null;
  }
  if (!entry.outputBuffer) return;

  let text = stripAnsi(entry.outputBuffer);
  entry.outputBuffer = '';

  // Clean up: collapse excessive blank lines
  text = text.replace(/^\n+/, '').replace(/\n{4,}/g, '\n\n\n').trimEnd();
  if (!text) return;

  // Filter line by line — remove all TUI noise
  const lines = text.split('\n').filter(line => !isNoiseLine(line));
  text = lines.join('\n').trim();
  if (!text) return;

  // Strip ● prefix from Claude response lines (keep the text)
  text = text.split('\n').map(line => line.replace(/^●\s*/, '')).join('\n').trim();
  if (!text) return;

  // Final check: if after filtering, the remaining text is too short to be meaningful
  const meaningful = text.replace(TUI_NOISE_CHARS, '').replace(/\s+/g, '').trim();
  if (meaningful.length < 3) return;

  appendMessage(sessionId, { role: 'assistant', type: 'output', text });
  entry.lastRole = 'assistant';
}

// Write a system event (PTY exit, restart, interrupt, etc.)
export function writeSystemMessage(sessionId, event, text) {
  appendMessage(sessionId, { role: 'system', type: event, text });
}

// Subscribe to real-time transcript updates for a session.
// Callback receives the full message list on every change.
// Returns { unsubscribe }
export function subscribeToSession(sessionId, callback) {
  const entry = getOrCreateSession(sessionId);
  entry.subscribers.add(callback);
  console.log(`[pty-transcript] subscribeToSession ${sessionId}: now ${entry.subscribers.size} subscribers`);

  // Immediate fire with current state
  try { callback(readTranscript(sessionId)); } catch {}

  return {
    unsubscribe: () => {
      entry.subscribers.delete(callback);
      // Clean up session entry if no subscribers left
      if (entry.subscribers.size === 0 && !entry.outputBuffer && !entry.inputBuffer) {
        sessions.delete(sessionId);
      }
    }
  };
}

// Force flush any pending buffers for a session (e.g., before PTY exit)
export function flushSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  if (entry.outputBuffer) flushOutput(sessionId, entry);
  if (entry.inputBuffer.trim()) {
    const text = stripAnsi(entry.inputBuffer.trim());
    entry.inputBuffer = '';
    if (text) appendMessage(sessionId, { role: 'user', type: 'input', text });
  }
}

// Rename a session's transcript file (e.g. when tab is renamed).
// Moves the old file to the new name and updates in-memory session key.
export function renameTranscript(oldSessionId, newSessionId) {
  const oldPath = getTranscriptPath(oldSessionId);
  const newPath = getTranscriptPath(newSessionId);
  if (existsSync(oldPath) && oldPath !== newPath) {
    try {
      renameSync(oldPath, newPath);
      console.log(`[pty-transcript] Renamed transcript: ${oldSessionId} → ${newSessionId}`);
    } catch (err) {
      console.error('[pty-transcript] rename error:', err.message);
    }
  }
  // Move in-memory session entry
  const entry = sessions.get(oldSessionId);
  if (entry) {
    sessions.delete(oldSessionId);
    sessions.set(newSessionId, entry);
  }
}

// Get the transcript directory path (for external use)
export function getTranscriptDir() {
  return TRANSCRIPT_DIR;
}

// Clean up a session's in-memory state (call on PTY exit)
export function destroySession(sessionId) {
  const entry = sessions.get(sessionId);
  if (entry) {
    flushSession(sessionId);
    if (entry.outputFlushTimer) clearTimeout(entry.outputFlushTimer);
    sessions.delete(sessionId);
  }
}

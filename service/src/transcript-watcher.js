// Transcript watcher — uses fs.watch to monitor Claude Code's JSONL transcript
// files for a given project cwd. Pushes parsed messages to subscribers when
// files change. Replaces the broken "dashboard polls /api/transcript every
// second" model with real-time push.
//
// One watcher per project (keyed by cwd). Multiple WebSocket clients can
// subscribe; they all get the same updates. Watchers are torn down when
// the last subscriber disconnects.

import { watch as fsWatch, readFileSync, statSync, existsSync, readdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// cwd → { watcher, subscribers: Set<callback>, lastEmitted: Map<filepath, mtime> }
const watchers = new Map();

// Normalize cwd so backslash and forward-slash variants resolve to the same Map key.
// Without this, hooks (which send backslash cwds from Claude Code on Windows) can't
// find the watcher registered by the terminal (which uses forward-slash cwds).
function normalizeCwd(cwd) {
  return cwd.replace(/\\/g, '/').replace(/\/$/, '');
}

// Convert a project cwd to the Claude Code projects directory format.
// Claude Code stores transcripts under ~/.claude/projects/<slug>/<sessionId>.jsonl
// where the slug is the cwd with separators replaced by dashes.
function cwdToClaudeDir(cwd) {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const slug = normalized.replace(/[\/:]/g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}

// Write a system event (PTY exit, restart, disconnect, etc.) directly into the
// most recent JSONL session file for a project cwd. This makes system events
// persist across server restarts and appear in the transcript view permanently.
// Event format: { type: 'system', event: 'pty_exit'|'restart'|'disconnect'|..., text: '...', timestamp: ISO }
export function writeSystemEvent(cwd, event, text, meta = {}) {
  cwd = normalizeCwd(cwd);
  const dir = cwdToClaudeDir(cwd);
  if (!existsSync(dir)) return false;
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return false;
    // Find the most recent JSONL file
    const filesWithMtime = files.map(f => {
      const full = join(dir, f);
      try { return { full, mtime: statSync(full).mtimeMs }; }
      catch { return { full, mtime: 0 }; }
    }).sort((a, b) => b.mtime - a.mtime);
    const target = filesWithMtime[0].full;
    const record = JSON.stringify({
      type: 'system',
      event,
      text,
      timestamp: new Date().toISOString(),
      ...meta,
    });
    appendFileSync(target, '\n' + record);
    console.log(`[transcript-watcher] Wrote system event: ${event} → ${target.split(/[/\\]/).pop()}`);
    return true;
  } catch (err) {
    console.error('[transcript-watcher] writeSystemEvent error:', err.message);
    return false;
  }
}

// Parse a Claude Code JSONL transcript file into a flat list of messages.
// Returns { messages: [{role, type, text, ts}], path }.
function parseJsonlFile(filepath) {
  try {
    const raw = readFileSync(filepath, 'utf-8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    const messages = [];
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      // System events (PTY exit, restart, disconnect, etc.) — written by writeSystemEvent()
      if (obj.type === 'system' && obj.event) {
        messages.push({ role: 'system', type: obj.event, text: obj.text || obj.event, ts: obj.timestamp });
        continue;
      }

      // User prompt
      if (obj.type === 'user' && obj.message) {
        const content = obj.message.content;
        if (typeof content === 'string' && content.trim()) {
          messages.push({ role: 'user', type: 'prompt', text: content, ts: obj.timestamp });
        } else if (Array.isArray(content)) {
          let textParts = [];
          for (const block of content) {
            if (block.type === 'text' && block.text?.trim()) textParts.push(block.text);
          }
          if (textParts.length) {
            messages.push({ role: 'user', type: 'prompt', text: textParts.join('\n'), ts: obj.timestamp });
          }
        }
        continue;
      }

      // Assistant messages
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        const model = obj.message?.model || null;
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            messages.push({ role: 'assistant', type: 'text', text: block.text, ts: obj.timestamp, model });
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
            else if (name === 'Agent' && input.description) summary = `Agent: ${input.description}`;
            else if (name === 'Agent' && input.prompt) summary = `Agent: ${input.prompt.substring(0, 80)}`;
            messages.push({ role: 'assistant', type: 'tool', text: summary, ts: obj.timestamp });
          }
        }
      }
    }
    return messages;
  } catch (err) {
    console.error('[transcript-watcher] parse error:', filepath, err.message);
    return [];
  }
}

// Read all JSONL files in the project directory and return a sorted message list.
// If claudeSessionIds is provided (non-empty array), only read those specific session files.
// Otherwise falls back to reading the most recent session file.
function readAllForCwd(cwd, claudeSessionIds) {
  const dir = cwdToClaudeDir(cwd);
  if (!existsSync(dir)) return [];
  let allMessages = [];
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));

    let filesToRead;
    if (claudeSessionIds && claudeSessionIds.length > 0) {
      // Filter to only the JSONL files matching this tab's known Claude sessions
      const sessionSet = new Set(claudeSessionIds);
      filesToRead = files
        .filter(f => sessionSet.has(f.replace('.jsonl', '')))
        .map(f => join(dir, f));
    } else {
      // No known sessions yet — show only the most recent file (new tab)
      const filesWithMtime = files.map(f => {
        const full = join(dir, f);
        try { return { full, mtime: statSync(full).mtimeMs }; }
        catch { return { full, mtime: 0 }; }
      }).sort((a, b) => b.mtime - a.mtime).slice(0, 1);
      filesToRead = filesWithMtime.map(f => f.full);
    }

    for (const full of filesToRead) {
      allMessages.push(...parseJsonlFile(full));
    }
    // Sort merged messages by timestamp ascending
    allMessages.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    // Dedup by role+type+text+timestamp — timestamp prevents dropping
    // identical user messages sent at different times (e.g. "STOP" twice).
    const seen = new Set();
    const out = [];
    for (const m of allMessages) {
      const sig = `${m.role}|${m.type}|${m.ts || ''}|${(m.text || '').replace(/\s+/g, ' ').trim()}`;
      if (sig.length > 10 && seen.has(sig)) continue;
      seen.add(sig);
      out.push(m);
    }
    return out;
  } catch (err) {
    console.error('[transcript-watcher] readAllForCwd error:', err.message);
    return [];
  }
}

// Subscribe a callback to changes for a project cwd. Returns an object with
// unsubscribe() and setClaudeSessions(ids) to update the session filter.
// Callback signature: (messages: Message[]) => void. Called immediately with
// current state on subscribe, then on every file change in that project's dir.
// claudeSessionIds: optional array of Claude session IDs to filter transcripts to.
export function subscribeToTranscript(cwd, callback, claudeSessionIds) {
  if (!cwd || !callback) return { unsubscribe: () => {}, setClaudeSessions: () => {} };
  cwd = normalizeCwd(cwd);

  // Each subscriber has its own session filter — wrap the callback
  const subscriber = {
    claudeSessionIds: claudeSessionIds || [],
    callback,
    fire() {
      try {
        const messages = readAllForCwd(cwd, this.claudeSessionIds.length > 0 ? this.claudeSessionIds : null);
        this.callback(messages);
      } catch (err) { console.error('[transcript-watcher] subscriber error:', err.message); }
    }
  };

  let entry = watchers.get(cwd);
  if (!entry) {
    const dir = cwdToClaudeDir(cwd);
    let watcher = null;
    let debounceTimer = null;
    const emit = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const e = watchers.get(cwd);
        if (!e) return;
        for (const sub of e.subscribers) {
          sub.fire();
        }
      }, 100); // 100ms debounce — coalesce rapid file writes
    };
    if (existsSync(dir)) {
      try {
        watcher = fsWatch(dir, { persistent: true }, (eventType, filename) => {
          if (filename && filename.endsWith('.jsonl')) emit();
        });
      } catch (err) {
        console.error('[transcript-watcher] fs.watch failed for', dir, ':', err.message);
      }
    } else {
      // Directory doesn't exist yet — fall back to polling the parent for it to appear
      console.warn('[transcript-watcher] dir does not exist yet:', dir);
    }

    // Polling fallback: fs.watch on Windows does NOT fire events when a process
    // appends to a file with the handle held open (Claude Code does this). So
    // we also poll the directory's .jsonl mtimes every 500ms and emit when any
    // change. Cheap on Linux too — and harmless since emit() is debounced.
    const pollState = new Map(); // filepath → "mtimeMs:size"
    const poller = setInterval(() => {
      if (!existsSync(dir)) return;
      try {
        const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
        let changed = false;
        const seen = new Set();
        for (const f of files) {
          const full = join(dir, f);
          seen.add(full);
          let mt = 0, sz = 0;
          try { const st = statSync(full); mt = st.mtimeMs; sz = st.size; } catch { continue; }
          const key = `${mt}:${sz}`;
          if (pollState.get(full) !== key) {
            pollState.set(full, key);
            changed = true;
          }
        }
        // Detect deletions too
        for (const k of pollState.keys()) {
          if (!seen.has(k)) { pollState.delete(k); changed = true; }
        }
        if (changed) emit();
      } catch {}
    }, 500);

    entry = { watcher, poller, subscribers: new Set(), dir, emit };
    watchers.set(cwd, entry);
  }
  entry.subscribers.add(subscriber);

  // Immediate fire with current state
  subscriber.fire();

  return {
    unsubscribe: () => {
      const e = watchers.get(cwd);
      if (!e) return;
      e.subscribers.delete(subscriber);
      if (e.subscribers.size === 0) {
        try { e.watcher?.close(); } catch {}
        try { if (e.poller) clearInterval(e.poller); } catch {}
        watchers.delete(cwd);
      }
    },
    setClaudeSessions: (ids) => {
      subscriber.claudeSessionIds = ids || [];
      subscriber.fire(); // Re-read with new filter immediately
    }
  };
}

// Force a re-read and push of transcript data for a given cwd.
// Called by hooks when we KNOW new data exists (UserPromptSubmit, AssistantMessage, Stop)
// instead of waiting for the file poller to detect the change. This eliminates the
// race condition where Windows file metadata caching prevents the poller from seeing
// newly-written JSONL data while Claude holds the file handle open.
export function nudgeTranscript(cwd) {
  if (!cwd) return;
  cwd = normalizeCwd(cwd);
  const entry = watchers.get(cwd);
  if (!entry) return;
  // Use the watcher's emit (which debounces and reads fresh data)
  if (entry.emit) entry.emit();
}

// Transcript watcher — uses fs.watch to monitor Claude Code's JSONL transcript
// files for a given project cwd. Pushes parsed messages to subscribers when
// files change. Replaces the broken "dashboard polls /api/transcript every
// second" model with real-time push.
//
// One watcher per project (keyed by cwd). Multiple WebSocket clients can
// subscribe; they all get the same updates. Watchers are torn down when
// the last subscriber disconnects.

import { watch as fsWatch, readFileSync, statSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// cwd → { watcher, subscribers: Set<callback>, lastEmitted: Map<filepath, mtime> }
const watchers = new Map();

// Convert a project cwd to the Claude Code projects directory format.
// Claude Code stores transcripts under ~/.claude/projects/<slug>/<sessionId>.jsonl
// where the slug is the cwd with separators replaced by dashes.
function cwdToClaudeDir(cwd) {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const slug = normalized.replace(/[\/:]/g, '-');
  return join(homedir(), '.claude', 'projects', slug);
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
function readAllForCwd(cwd) {
  const dir = cwdToClaudeDir(cwd);
  if (!existsSync(dir)) return [];
  let allMessages = [];
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    // Sort by file mtime descending — most recent session first. Take last 5 sessions.
    const filesWithMtime = files.map(f => {
      const full = join(dir, f);
      try { return { full, mtime: statSync(full).mtimeMs }; }
      catch { return { full, mtime: 0 }; }
    }).sort((a, b) => b.mtime - a.mtime).slice(0, 5);
    for (const { full } of filesWithMtime) {
      allMessages.push(...parseJsonlFile(full));
    }
    // Sort merged messages by timestamp ascending
    allMessages.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    // Dedup by role+type+text (cross-session merge can produce duplicates)
    const seen = new Set();
    const out = [];
    for (const m of allMessages) {
      const sig = `${m.role}|${m.type}|${(m.text || '').replace(/\s+/g, ' ').trim()}`;
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

// Subscribe a callback to changes for a project cwd. Returns an unsubscribe fn.
// Callback signature: (messages: Message[]) => void. Called immediately with
// current state on subscribe, then on every file change in that project's dir.
export function subscribeToTranscript(cwd, callback) {
  if (!cwd || !callback) return () => {};
  let entry = watchers.get(cwd);
  if (!entry) {
    const dir = cwdToClaudeDir(cwd);
    let watcher = null;
    let debounceTimer = null;
    const emit = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const messages = readAllForCwd(cwd);
        const e = watchers.get(cwd);
        if (!e) return;
        for (const cb of e.subscribers) {
          try { cb(messages); } catch (err) { console.error('[transcript-watcher] subscriber error:', err.message); }
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
    const pollMtimes = new Map(); // filepath → mtimeMs
    const poller = setInterval(() => {
      if (!existsSync(dir)) return;
      try {
        const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
        let changed = false;
        const seen = new Set();
        for (const f of files) {
          const full = join(dir, f);
          seen.add(full);
          let mt = 0;
          try { mt = statSync(full).mtimeMs; } catch { continue; }
          if (pollMtimes.get(full) !== mt) {
            pollMtimes.set(full, mt);
            changed = true;
          }
        }
        // Detect deletions too
        for (const k of pollMtimes.keys()) {
          if (!seen.has(k)) { pollMtimes.delete(k); changed = true; }
        }
        if (changed) emit();
      } catch {}
    }, 500);

    entry = { watcher, poller, subscribers: new Set(), dir };
    watchers.set(cwd, entry);
  }
  entry.subscribers.add(callback);

  // Immediate fire with current state
  try {
    const messages = readAllForCwd(cwd);
    callback(messages);
  } catch {}

  return () => {
    const e = watchers.get(cwd);
    if (!e) return;
    e.subscribers.delete(callback);
    if (e.subscribers.size === 0) {
      try { e.watcher?.close(); } catch {}
      try { if (e.poller) clearInterval(e.poller); } catch {}
      watchers.delete(cwd);
    }
  };
}

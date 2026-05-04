// Claude LLM Adapter — uses the Agent SDK for structured JSON I/O.
// No PTY, no TUI, no CLI subprocess. Direct SDK call inside the PAN server process.
//
// API:
//   const adapter = new ClaudeAdapter(sessionId, cwd, onMessage);
//   adapter.send("What is 2+2?");        // sends a message, streams responses via onMessage
//   adapter.interrupt();                   // cancels current query
//   adapter.getMessages();                // returns transcript messages
//   adapter.getSessionId();               // Claude session UUID

import { query } from '@anthropic-ai/claude-agent-sdk';
import { anonymizeForAI } from './anonymize.js';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export class ClaudeAdapter {
  constructor(sessionId, cwd, onMessage, resumeClaudeSessionId = null) {
    this.sessionId = sessionId;           // PAN tab session ID (e.g., "dash-pan-main")
    this.cwd = cwd;                       // Working directory
    this.onMessage = onMessage;           // Callback: (messages: Message[]) => void
    this.messages = [];                   // Transcript: [{role, type, text, ts, model?}]
    this.MAX_MESSAGES = 500;              // Cap to prevent memory leak
    this.claudeSessionId = resumeClaudeSessionId; // Claude's internal session UUID (restored from token on restart)
    this.busy = false;                    // True while a query is running
    this.abortController = null;          // For interrupting
    this._queryCount = 0;
    this.model = null;                    // Override model — null = use CLI default
    this._turnInputTokens = 0;           // Token counters for current turn
    this._turnOutputTokens = 0;
    this._turnCacheRead = 0;
    this._turnCacheCreate = 0;
    this.totalInputTokens = 0;           // Session totals
    this.totalOutputTokens = 0;
    this.totalCost = 0;
    if (resumeClaudeSessionId) {
      // Pre-set query count so the resume logic kicks in on first send
      this._queryCount = 1;
      this._loadHistoryFromJSONL(resumeClaudeSessionId);
      console.log(`[Claude Adapter] Resuming session: ${resumeClaudeSessionId}`);
    }
  }

  // Send a message to Claude. Responses stream via onMessage callback.
  // PII is stripped before sending — emails, phones, SSNs, cards, GPS, addresses.
  async send(text) {
    if (!text?.trim()) return;
    text = anonymizeForAI(text.trim());
    const isFirst = this._queryCount === 0;
    this._queryCount++;

    // Reset per-turn token counters
    this._turnInputTokens = 0;
    this._turnOutputTokens = 0;
    this._turnCacheRead = 0;
    this._turnCacheCreate = 0;

    // Add user message to transcript
    this.messages.push({
      role: 'user', type: 'prompt',
      text,
      ts: new Date().toISOString(),
    });
    this._push();

    // Build query options
    const opts = {
      permissionMode: 'auto',
      cwd: this.cwd,
      enableAllProjectMcpServers: true,  // picks up .mcp.json from cwd
    };
    if (this.model) opts.model = this.model;

    // Resume previous session for multi-turn (or after server restart)
    const _attemptedResumeId = this.claudeSessionId || null;
    if (this.claudeSessionId) {
      opts.resume = this.claudeSessionId;
    }

    this.busy = true;
    this.abortController = new AbortController();

    try {
      console.log(`[Claude Adapter] Query: "${text.substring(0, 60)}" (${isFirst ? 'new' : 'resume'}) cwd=${this.cwd}`);

      const stream = query({
        prompt: text,
        options: opts,
        signal: this.abortController.signal,
      });

      for await (const msg of stream) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (_attemptedResumeId && msg.session_id && msg.session_id !== _attemptedResumeId) {
            console.warn(`[Claude Adapter] Resume FAILED silently — requested ${_attemptedResumeId} got ${msg.session_id}`);
          }
          this.claudeSessionId = msg.session_id;
          console.log(`[Claude Adapter] Init: session=${msg.session_id}`);

        } else if (msg.type === 'assistant' && msg.message?.content) {
          // Track token usage from this assistant response
          const usage = msg.message.usage;
          if (usage) {
            this._turnInputTokens += usage.input_tokens || 0;
            this._turnOutputTokens += usage.output_tokens || 0;
            this._turnCacheRead += usage.cache_read_input_tokens || 0;
            this._turnCacheCreate += usage.cache_creation_input_tokens || 0;
          }
          // Collect all text blocks from this assistant event into ONE message.
          // Previously each text block was pushed separately, causing a single
          // response to appear multiple times in the transcript when Claude
          // produced multi-block output.
          const textParts = [];
          const ts = new Date().toISOString();
          const model = msg.message.model || null;
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text?.trim()) {
              textParts.push(block.text);
            } else if (block.type === 'tool_use') {
              // Flush any accumulated text first so tools appear in order
              if (textParts.length > 0) {
                this.messages.push({ role: 'assistant', type: 'text', text: textParts.join('\n\n'), ts, model });
                textParts.length = 0;
              }
              const name = block.name || 'unknown';
              const input = block.input || {};
              let summary = name;
              if (name === 'Bash' && input.command) summary = `Bash: ${input.command.substring(0, 120)}`;
              else if (name === 'Edit' && input.file_path) summary = `Edit: ${input.file_path.split(/[/\\]/).pop()}`;
              else if (name === 'Read' && input.file_path) summary = `Read: ${input.file_path.split(/[/\\]/).pop()}`;
              else if (name === 'Write' && input.file_path) summary = `Write: ${input.file_path.split(/[/\\]/).pop()}`;
              else if (name === 'Grep' && input.pattern) summary = `Grep: ${input.pattern.substring(0, 60)}`;
              else if (name === 'Glob' && input.pattern) summary = `Glob: ${input.pattern}`;
              else if (name === 'Agent') summary = `Agent: ${(input.description || input.prompt || '').substring(0, 80)}`;
              this.messages.push({ role: 'assistant', type: 'tool', text: summary, ts: new Date().toISOString() });
            }
          }
          if (textParts.length > 0) {
            this.messages.push({ role: 'assistant', type: 'text', text: textParts.join('\n\n'), ts, model });
          }
          this._push();

        } else if (msg.type === 'result') {
          const cost = msg.total_cost_usd || 0;
          this.totalInputTokens += this._turnInputTokens;
          this.totalOutputTokens += this._turnOutputTokens;
          this.totalCost += cost;
          console.log(`[Claude Adapter] Result: turns=${msg.num_turns} cost=$${cost.toFixed(4)} turn_in=${this._turnInputTokens} turn_out=${this._turnOutputTokens} session_total_in=${this.totalInputTokens} session_total_out=${this.totalOutputTokens} session=${msg.session_id}`);
          // Inject a turn_stats message so the frontend can display per-message token usage
          this.messages.push({
            role: 'system', type: 'turn_stats',
            text: `↑${this._turnInputTokens} ↓${this._turnOutputTokens}` + (this._turnCacheRead ? ` 📦${this._turnCacheRead}` : '') + ` $${cost.toFixed(4)}`,
            ts: new Date().toISOString(),
            tokens: {
              input: this._turnInputTokens,
              output: this._turnOutputTokens,
              cache_read: this._turnCacheRead,
              cache_create: this._turnCacheCreate,
              cost,
              total_input: this.totalInputTokens,
              total_output: this.totalOutputTokens,
              total_cost: this.totalCost,
            },
          });
          if (msg.session_id) this.claudeSessionId = msg.session_id;
          this._push();
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log(`[Claude Adapter] Query interrupted`);
        this.messages.push({
          role: 'system', type: 'interrupt',
          text: 'Interrupted',
          ts: new Date().toISOString(),
        });
        this._push();
      } else if (opts.resume && (err.message?.includes('session') || err.message?.includes('resume') || err.message?.includes('not found'))) {
        // Resume failed — session expired or invalid. Retry as fresh session.
        console.warn(`[Claude Adapter] Resume threw, falling back to fresh session: ${err.message}`);
        this.claudeSessionId = null;
        this._queryCount = 1;
        this.busy = false;
        return this.send(text);
      } else {
        console.error(`[Claude Adapter] Query error:`, err.message);
        this.messages.push({
          role: 'system', type: 'error',
          text: `Error: ${err.message}`,
          ts: new Date().toISOString(),
        });
        this._push();
      }
    } finally {
      this.busy = false;
      this.abortController = null;
    }
  }

  // Change the model used for subsequent queries (takes effect immediately on next send)
  setModel(modelId) {
    this.model = modelId || null;
    console.log(`[Claude Adapter] Model set to: ${this.model || 'default'}`);
    // Inject a system message so the transcript shows the switch
    this.messages.push({
      role: 'system', type: 'model_switch',
      text: `Model switched to: ${this.model || 'default'}`,
      ts: new Date().toISOString(),
    });
    this._push();
  }

  getModel() { return this.model; }

  // Interrupt current query
  interrupt() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  // Get all transcript messages
  getMessages() {
    return [...this.messages];
  }

  // Get Claude's session UUID
  getSessionId() {
    return this.claudeSessionId;
  }

  // Load transcript history from Claude's JSONL file on disk into this.messages.
  // Called from the constructor when resumeClaudeSessionId is set, so that after
  // a PTY crash + server restart the UI transcript is not blank.
  _loadHistoryFromJSONL(sessionId) {
    try {
      const slug = this.cwd.replace(/\\/g, '/').replace(/\/$/, '').replace(/[\/:]/g, '-');
      const filePath = join(homedir(), '.claude', 'projects', slug, sessionId + '.jsonl');
      if (!existsSync(filePath)) {
        console.warn(`[Claude Adapter] JSONL not found for session ${sessionId}: ${filePath}`);
        return;
      }
      const raw = readFileSync(filePath, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      const loaded = [];
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.isSidechain === true) continue;
        const msg = entry.message;
        if (!msg) continue;
        const ts = entry.timestamp || new Date().toISOString();
        if (entry.type === 'user') {
          const content = msg.content;
          if (!Array.isArray(content)) continue;
          const hasText = content.some(b => b.type === 'text');
          if (!hasText) continue;
          const textBlocks = content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
          loaded.push({ role: 'user', type: 'prompt', text: textBlocks, ts });
        } else if (entry.type === 'assistant') {
          const content = msg.content;
          if (!Array.isArray(content)) continue;
          const model = msg.model || null;
          const textParts = [];
          for (const block of content) {
            if (block.type === 'text' && block.text?.trim()) {
              textParts.push(block.text);
            } else if (block.type === 'tool_use') {
              if (textParts.length > 0) {
                loaded.push({ role: 'assistant', type: 'text', text: textParts.join('\n\n'), ts, model });
                textParts.length = 0;
              }
              const name = block.name || 'unknown';
              const input = block.input || {};
              let summary = name;
              if (name === 'Bash' && input.command) summary = `Bash: ${input.command.substring(0, 120)}`;
              else if (name === 'Edit' && input.file_path) summary = `Edit: ${input.file_path.split(/[/\\]/).pop()}`;
              else if (name === 'Read' && input.file_path) summary = `Read: ${input.file_path.split(/[/\\]/).pop()}`;
              else if (name === 'Write' && input.file_path) summary = `Write: ${input.file_path.split(/[/\\]/).pop()}`;
              else if (name === 'Grep' && input.pattern) summary = `Grep: ${input.pattern.substring(0, 60)}`;
              else if (name === 'Glob' && input.pattern) summary = `Glob: ${input.pattern}`;
              else if (name === 'Agent') summary = `Agent: ${(input.description || input.prompt || '').substring(0, 80)}`;
              loaded.push({ role: 'assistant', type: 'tool', text: summary, ts: new Date().toISOString() });
            }
          }
          if (textParts.length > 0) {
            loaded.push({ role: 'assistant', type: 'text', text: textParts.join('\n\n'), ts, model });
          }
        }
      }
      // Cap to MAX_MESSAGES, keeping most recent
      const capped = loaded.length > this.MAX_MESSAGES ? loaded.slice(-this.MAX_MESSAGES) : loaded;
      this.messages = capped;
      console.log(`[Claude Adapter] Loaded ${capped.length} messages from JSONL (${loaded.length} parsed, ${lines.length} lines)`);
    } catch (err) {
      console.warn(`[Claude Adapter] Failed to load JSONL history for session ${sessionId}: ${err.message}`);
    }
  }

  // Push transcript update to callback
  _push() {
    // Trim to cap — old messages already persisted to transcript files
    if (this.messages.length > this.MAX_MESSAGES) {
      this.messages = this.messages.slice(-this.MAX_MESSAGES);
    }
    try {
      this.onMessage(this.getMessages());
    } catch (err) {
      console.error(`[Claude Adapter] Push error:`, err.message);
    }
  }
}

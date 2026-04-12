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

export class ClaudeAdapter {
  constructor(sessionId, cwd, onMessage, resumeClaudeSessionId = null) {
    this.sessionId = sessionId;           // PAN tab session ID (e.g., "dash-pan-main")
    this.cwd = cwd;                       // Working directory
    this.onMessage = onMessage;           // Callback: (messages: Message[]) => void
    this.messages = [];                   // Transcript: [{role, type, text, ts, model?}]
    this.claudeSessionId = resumeClaudeSessionId; // Claude's internal session UUID (restored from token on restart)
    this.busy = false;                    // True while a query is running
    this.abortController = null;          // For interrupting
    this._queryCount = 0;
    if (resumeClaudeSessionId) {
      // Pre-set query count so the resume logic kicks in on first send
      this._queryCount = 1;
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
    };

    // Resume previous session for multi-turn (or after server restart)
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
          this.claudeSessionId = msg.session_id;
          console.log(`[Claude Adapter] Init: session=${msg.session_id}`);

        } else if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text?.trim()) {
              this.messages.push({
                role: 'assistant', type: 'text',
                text: block.text,
                ts: new Date().toISOString(),
                model: msg.message.model || null,
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
              else if (name === 'Agent') summary = `Agent: ${(input.description || input.prompt || '').substring(0, 80)}`;
              this.messages.push({
                role: 'assistant', type: 'tool',
                text: summary,
                ts: new Date().toISOString(),
              });
            }
          }
          this._push();

        } else if (msg.type === 'result') {
          console.log(`[Claude Adapter] Result: turns=${msg.num_turns} cost=$${msg.total_cost_usd?.toFixed(4)} session=${msg.session_id}`);
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
        console.warn(`[Claude Adapter] Resume failed (${err.message}), retrying as fresh session`);
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

  // Push transcript update to callback
  _push() {
    try {
      this.onMessage(this.getMessages());
    } catch (err) {
      console.error(`[Claude Adapter] Push error:`, err.message);
    }
  }
}

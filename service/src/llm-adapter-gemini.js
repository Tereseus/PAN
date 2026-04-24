// Gemini LLM Adapter — wraps the Gemini CLI for structured JSONL I/O.
// Programmatic access via: gemini -p "prompt" --output-format stream-json
//
// API:
//   const adapter = new GeminiAdapter(sessionId, cwd, onMessage);
//   adapter.send("What is 2+2?");        // sends a message, streams responses via onMessage
//   adapter.interrupt();                   // cancels current query
//   adapter.getMessages();                // returns transcript messages
//   adapter.getSessionId();               // Gemini session ID

import { spawn } from 'child_process';
import { anonymizeForAI } from './anonymize.js';
import { logUsage } from './llm.js';

export class GeminiAdapter {
  constructor(sessionId, cwd, onMessage, resumeGeminiSessionId = null) {
    this.sessionId = sessionId;           // PAN tab session ID
    this.cwd = cwd;                       // Working directory
    this.onMessage = onMessage;           // Callback: (messages: Message[]) => void
    this.messages = [];                   // Transcript: [{role, type, text, ts, model?}]
    this.geminiSessionId = resumeGeminiSessionId || 'latest'; // Gemini's session ID
    this.busy = false;                    // True while a query is running
    this.childProcess = null;             // The gemini CLI subprocess
  }

  // Send a message to Gemini. Responses stream via onMessage callback.
  async send(text) {
    if (!text?.trim()) return;
    text = anonymizeForAI(text.trim());
    
    // Add user message to transcript
    this.messages.push({
      role: 'user', type: 'prompt',
      text,
      ts: new Date().toISOString(),
    });
    this._push();

    this.busy = true;
    console.log(`[Gemini Adapter] Query: "${text.substring(0, 60)}" resume=${this.geminiSessionId} cwd=${this.cwd}`);

    // Spawn Gemini CLI in headless mode with JSON streaming
    const args = ['-p', text, '--output-format', 'stream-json'];
    if (this.geminiSessionId) {
      args.push('--resume', this.geminiSessionId);
    }

    this.childProcess = spawn('gemini', args, {
      cwd: this.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      shell: true, // Needed for .cmd/.ps1 resolution on Windows
      windowsHide: true,
    });

    let buffer = '';
    
    this.childProcess.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep partial line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          this._handleEvent(event, text);
        } catch (err) {
          // Ignore parse errors for non-JSON lines (e.g. warnings)
          if (line.includes('{')) console.warn(`[Gemini Adapter] JSON parse error: ${line.substring(0, 100)}`);
        }
      }
    });

    this.childProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.toLowerCase().includes('error')) {
        console.error(`[Gemini Adapter] CLI stderr: ${msg}`);
      }
    });

    return new Promise((resolve) => {
      this.childProcess.on('close', (code) => {
        this.busy = false;
        this.childProcess = null;
        console.log(`[Gemini Adapter] CLI exited with code ${code}`);
        resolve();
      });
    });
  }

  _handleEvent(event, originalPrompt) {
    const now = new Date().toISOString();

    if (event.type === 'message') {
      this.messages.push({
        role: 'assistant', type: 'text',
        text: event.text,
        ts: now,
        model: event.model || 'gemini-1.5-pro',
      });
      this._push();

    } else if (event.type === 'tool_use') {
      const name = event.name || 'unknown';
      const input = event.input || {};
      let summary = name;
      
      // Match PAN's tool summaries for consistency
      if (name === 'Bash' && input.command) summary = `Bash: ${input.command.substring(0, 120)}`;
      else if (name === 'Edit' && input.file_path) summary = `Edit: ${input.file_path.split(/[/\\]/).pop()}`;
      else if (name === 'Read' && input.file_path) summary = `Read: ${input.file_path.split(/[/\\]/).pop()}`;
      else if (name === 'Write' && input.file_path) summary = `Write: ${input.file_path.split(/[/\\]/).pop()}`;
      else if (name === 'Grep' && input.pattern) summary = `Grep: ${input.pattern.substring(0, 60)}`;
      else if (name === 'Glob' && input.pattern) summary = `Glob: ${input.pattern}`;
      
      this.messages.push({
        role: 'assistant', type: 'tool',
        text: summary,
        ts: now,
      });
      this._push();

    } else if (event.type === 'result') {
      if (event.session_id) this.geminiSessionId = event.session_id;
      
      // Log usage to database — use real model name (not cli: prefix) so pricing applies
      if (event.usage) {
        const model = event.model || 'gemini-1.5-pro';
        logUsage('terminal', model, event.usage, originalPrompt);
      }
      
      this._push();
    }
  }

  // Interrupt current query
  interrupt() {
    if (this.childProcess) {
      console.log(`[Gemini Adapter] Interrupting CLI process...`);
      this.childProcess.kill('SIGINT');
      this.messages.push({
        role: 'system', type: 'interrupt',
        text: 'Interrupted',
        ts: new Date().toISOString(),
      });
      this._push();
    }
  }

  // Get all transcript messages
  getMessages() {
    return [...this.messages];
  }

  // Get Gemini's session ID
  getSessionId() {
    return this.geminiSessionId;
  }

  // Push transcript update to callback
  _push() {
    try {
      this.onMessage(this.getMessages());
    } catch (err) {
      console.error(`[Gemini Adapter] Push error:`, err.message);
    }
  }
}

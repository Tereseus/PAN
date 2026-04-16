// PAN Terminal — WebSocket-backed PTY sessions
// Spawns real shell processes, streams I/O to dashboard via WebSocket.
// Each project gets its own terminal session. Phone can switch between them.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
import { WebSocketServer, WebSocket } from 'ws';
import { hostname } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { all, insert, get } from './db.js';
import { injectSessionContext } from './routes/hooks.js';
import { subscribeToTranscript, writeSystemEvent } from './transcript-watcher.js';
import { captureInput, captureOutput, subscribeToSession, writeSystemMessage, flushSession, destroySession, readTranscript, setSessionName, renameTranscript } from './pty-transcript.js';
import { getTerminalLogDir, getShell, getDataDir } from './platform.js';
import { createAlert } from './routes/dashboard.js';
import { ClaudeAdapter } from './llm-adapter-claude.js';
import { GeminiAdapter } from './llm-adapter-gemini.js';

// Terminal log directory — persists ScreenBuffer logs across server restarts
const TERMINAL_LOG_DIR = getTerminalLogDir();
try { mkdirSync(TERMINAL_LOG_DIR, { recursive: true }); } catch {}

// Active terminal sessions: Map<sessionId, { pty, term, clients, ... }>
const sessions = new Map();

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

    const resumeId = session.claudeSessionIds?.[session.claudeSessionIds.length - 1] || null;
    
    // 2. Instantiate the correct adapter
    const onMessage = (messages) => {
      // Push transcript to all connected WebSocket clients
      session.lastOutputTs = Date.now();
      session.claudeRunning = session._llmAdapter?.busy || false;
      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) {
          try { client.send(JSON.stringify({ type: 'transcript_messages', messages })); } catch {}
        }
      }
      // Persist the session ID back to the session + token (for resume)
      const csid = session._llmAdapter?.getSessionId?.();
      if (csid && !(session.claudeSessionIds || []).includes(csid)) {
        session.claudeSessionIds = [...(session.claudeSessionIds || []), csid];
        for (const c of session.clients) {
          if (c._reconnectToken) updateTokenClaudeSessions(c._reconnectToken, session.claudeSessionIds);
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

    // Apply saved model preference from settings (if any) so that model changes
    // made via the dashboard picker take effect even before the first message.
    try {
      const modelRow = get("SELECT value FROM settings WHERE key = 'terminal_ai_model'");
      if (modelRow) {
        const savedModel = modelRow.value.replace(/^"|"$/g, '').trim();
        if (savedModel) {
          session._llmAdapter.setModel(savedModel);
          console.log(`[PAN LLM] Applied saved model preference: ${savedModel}`);
        }
      }
    } catch {}
  }

  session.claudeRunning = true;
  session.pipeMode = true; 
  session._llmAdapter.send(userText).then(() => {
    session.claudeRunning = false;
    // Notify ready
    for (const c of session.clients) {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(JSON.stringify({ type: 'pipe_ready' })); } catch {}
      }
    }
  });
  return true;
}

// Interrupt a session's LLM adapter (Escape key in pipe mode)
function pipeInterrupt(sessionId) {
  const session = sessions.get(sessionId);
  if (!session?._llmAdapter) return false;
  session._llmAdapter.interrupt();
  session.claudeRunning = false;
  writeSystemMessage(sessionId, 'interrupt', 'Interrupted (Escape)');
  return true;
}

// Set the model for a session's LLM adapter — takes effect on next message
function pipeSetModel(sessionId, modelId) {
  const session = sessions.get(sessionId);
  if (!session?._llmAdapter?.setModel) return false;
  session._llmAdapter.setModel(modelId);
  return true;
}

// Get all transcript messages for a session (for HTTP fallback on page load)
function getSessionMessages(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return [];
  const stream = session._streamMessages || [];
  const adapter = session._llmAdapter?.getMessages?.() || [];
  const system = session.systemMessages || [];
  const all = [...system, ...stream, ...adapter];
  all.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  return all;
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
  // If we have specific Claude session IDs (from a tab), look those up first
  if (claudeSessionIds && claudeSessionIds.length > 0) {
    for (const csid of claudeSessionIds) {
      const tool = inFlightTools.get(csid);
      if (tool) return tool;
    }
    return null;
  }
  // Fallback: find any entry matching this cwd
  const cwdNorm = _cwdKey(cwd);
  for (const [, cur] of inFlightTools) {
    if (_cwdKey(cur.cwd) === cwdNorm) return cur;
  }
  return null;
}

// Default shell — platform.js handles Git Bash detection + Linux/Mac
const { shell: SHELL, args: SHELL_ARGS } = getShell();

let wss = null;
let ScreenBufferClass = null; // loaded async

async function startTerminalServer(httpServer) {
  // Load ScreenBuffer for server-side rendering
  const { ScreenBuffer } = await import('./screen-buffer.js');
  ScreenBufferClass = ScreenBuffer;

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
    }
    // Unknown paths: let socket hang/timeout naturally
  });

  wss.on('connection', (ws, req) => {
    try { _handleTerminalConnection(ws, req); } catch (err) {
      console.error(`[PAN Terminal] FATAL connection handler error:`, err);
      try { ws.send(JSON.stringify({ type: 'error', message: err.message })); } catch {}
    }
  });

  function _handleTerminalConnection(ws, req) {
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
    const cwd = tokenEntry?.cwd || url.searchParams.get('cwd') || 'C:\\Users\\tzuri\\Desktop';
    const tabName = url.searchParams.get('tab_name') || '';
    const cols = parseInt(url.searchParams.get('cols')) || 120;
    const rows = parseInt(url.searchParams.get('rows')) || 30;

    // Register tab name for per-tab transcript file naming
    if (tabName) {
      setSessionName(sessionId, tabName);
    }

    let session = sessions.get(sessionId);

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
        const ptyProcess = pty.spawn(SHELL, SHELL_ARGS, {
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
        });

        session = {
          pty: ptyProcess,
          term,
          clients: new Set(),
          project: projectName,
          cwd,
          createdAt: Date.now(),
          renderTimer: null,
          lastRendered: '',
          // System messages (banners, PTY events, interrupts) that persist
          // across transcript refreshes. Merged into every transcript push.
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
        };
        sessions.set(sessionId, session);

        // Register PTY shell in process registry
        registerProcess({
          pid: ptyProcess.pid,
          type: 'pty',
          sessionId,
          command: `${SHELL} ${SHELL_ARGS.join(' ')}`,
        });

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
              session.claudeRunning = true;
              session.claudeExited = false;
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
                  session._streamMessages.push({
                    role: 'assistant', type: 'text',
                    text: block.text,
                    ts: new Date().toISOString(),
                    model: evt.message.model || null,
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
                  session._streamMessages.push({
                    role: 'assistant', type: 'tool',
                    text: summary,
                    ts: new Date().toISOString(),
                  });
                }
              }
              // Trim to prevent unbounded growth (memory leak)
              if (session._streamMessages.length > MAX_STREAM_MESSAGES) {
                session._streamMessages = session._streamMessages.slice(-MAX_STREAM_MESSAGES);
              }
              // Push updated transcript to all clients
              _pushStreamTranscript(session);

            } else if (evt.type === 'result') {
              // Turn complete — Claude exited back to bash
              session.claudeRunning = false;
              console.log(`[PAN Terminal] Stream result: turns=${evt.num_turns} cost=$${evt.total_cost_usd?.toFixed(4)} in ${sessionId}`, JSON.stringify(Object.keys(evt)));
              // Push turn stats with cumulative cost + tokens
              const tt = session._tokenTotals || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
              session._streamMessages.push({
                role: 'system', type: 'turn_stats',
                ts: new Date().toISOString(),
                tokens: {
                  total_input: tt.input,
                  total_output: tt.output,
                  total_cache_read: tt.cacheRead,
                  total_cache_create: tt.cacheCreate,
                  total_cost: evt.total_cost_usd ?? null,
                },
              });
              if (session._streamMessages.length > MAX_STREAM_MESSAGES) {
                session._streamMessages = session._streamMessages.slice(-MAX_STREAM_MESSAGES);
              }
              // Final push
              _pushStreamTranscript(session);
            }
          }

          // Detect bash prompt return ($ at end without JSON)
          // This catches the case between claude -p invocations
          const rawStripped = data.replace(/[\r\n]/g, '').trim();
          if (/\$\s*$/.test(rawStripped) && !rawStripped.startsWith('{')) {
            if (session.claudeRunning) {
              session.claudeRunning = false;
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
          const exitMsg = { role: 'system', type: 'banner', text: `PTY exited (code ${exitCode}, uptime ${Math.round(uptimeMs/1000)}s)`, ts: new Date().toISOString() };
          if (session.systemMessages) session.systemMessages.push(exitMsg);
          for (const client of session.clients) {
            if (client.readyState === 1) {
              client.send(JSON.stringify({
                type: 'exit',
                code: exitCode,
                uptime_ms: uptimeMs,
                project: session.project,
              }));
              // Push updated system messages so PTY exit appears in transcript
              try {
                const merged = [...(session.systemMessages || []), ...(session._lastTranscriptMessages || [])];
                merged.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
                client.send(JSON.stringify({ type: 'transcript_messages', messages: merged }));
              } catch {}
            }
          }
          sessions.delete(sessionId);
        });

        // Inject session context into CLAUDE.md BEFORE Claude starts
        if (cwd) {
          try {
            injectSessionContext(cwd);
            console.log(`[PAN Terminal] Pre-injected session context for ${projectName || sessionId}`);
          } catch (err) {
            console.error(`[PAN Terminal] Context injection failed:`, err.message);
          }
        }

        console.log(`[PAN Terminal] New session: ${sessionId} (${projectName || 'shell'}) in ${cwd}`);

        // Claude auto-launch is handled by the FRONTEND (not here).
        // The frontend's onopen/reconnect handler calls /api/v1/inject-context
        // first, then sends `claude --permission-mode auto "ΠΑΝ remembers..."`.
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

    // Send session info + reconnect token
    ws.send(JSON.stringify({
      type: 'info',
      session: sessionId,
      project: session.project,
      cwd: session.cwd,
      host: hostname(),
      reconnectToken: newToken,
      restoredFromToken: !!tokenEntry,
      tokenExpired,
    }));

    if (tokenExpired) {
      console.log(`[PAN Terminal] Reconnect token expired/invalid for session ${sessionId} — falling back to fresh params`);
    }

    // Send current screen state immediately (for new/reconnecting clients)
    broadcastRenderedScreen(session, ws);

    // NOTE: No session-start banner here — Claude's own "ΠΑΝ Remembers:" response
    // (triggered by the dashboard auto-launch) IS the briefing. A separate system
    // banner was rendering as a red warning box which looked wrong.

    // On connect/reconnect, push all transcript messages immediately.
    // Merge: system messages + PTY stream messages + pipe mode adapter messages.
    {
      const stream = session._streamMessages || [];
      const adapter = session._llmAdapter?.getMessages?.() || [];
      const system = session.systemMessages || [];
      const all = [...system, ...stream, ...adapter];
      if (all.length > 0) {
        all.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
        try {
          ws.send(JSON.stringify({ type: 'transcript_messages', messages: all }));
        } catch {}
      }
    }

    // Handle incoming messages from client
    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());

        switch (parsed.type) {
          case 'input':
            if (session.pty) {
              session.lastInputTs = Date.now();
              session.pty.write(parsed.data);
              // Detect pipe-mode commands and extract user message for transcript
              const pipeMatch = parsed.data.match(/claude\s+-p\s+--continue\s+.*--permission-mode\s+\w+\s+'((?:[^'\\]|\\.)*)'/);
              if (pipeMatch) {
                const userText = pipeMatch[1].replace(/'\\''/g, "'");
                if (userText.trim() && !/ΠΑΝ remembers/i.test(userText)) {
                  session._streamMessages = session._streamMessages || [];
                  session._streamMessages.push({
                    role: 'user', type: 'prompt',
                    text: userText.trim(),
                    ts: new Date().toISOString(),
                  });
                  if (session._streamMessages.length > MAX_STREAM_MESSAGES) {
                    session._streamMessages = session._streamMessages.slice(-MAX_STREAM_MESSAGES);
                  }
                  _pushStreamTranscript(session);
                }
              }
            }
            break;

          case 'interrupt':
            // User pressed Escape — interrupt Claude
            session.lastInputTs = Date.now();
            if (session._llmAdapter && session._llmAdapter.busy) {
              // Pipe mode: abort the active SDK query
              pipeInterrupt(sessionId);
            } else if (session.pty) {
              // Legacy PTY mode: send ESC char
              session.pty.write('\x1b');
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
    const thinking = !!session.claudeRunning || inputNewer || stillStreaming;
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
      claudeRunning: !!session.claudeRunning,
      pipeMode: !!session.pipeMode,
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
    session.pty.kill();
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

// Send text to a terminal session (used by phone voice commands)
// If no sessionId given, sends to the most recently active session
function sendToSession(sessionId, text, label) {
  console.log(`[PAN Terminal] sendToSession(${sessionId}, ${JSON.stringify(text)}) bytes: ${[...text].map(c => c.charCodeAt(0).toString(16)).join(' ')}`);
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
// Falls back to broadcastNotification if no owning tab is found (e.g. new session
// not yet discovered). This prevents cross-tab contamination.
function broadcastChatUpdate(data) {
  const claudeSessionId = data?.session_id;
  const ownerSessionId = findSessionByClaudeId(claudeSessionId);
  if (ownerSessionId) {
    // Targeted: only send to the owning tab's clients
    broadcastToSession(ownerSessionId, 'chat_update', data);
  } else {
    // No owner found yet — broadcast to all so the first tab can claim it.
    // This only happens for the very first message of a new Claude session.
    broadcastNotification('chat_update', data);
  }
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

export { startTerminalServer, startDevTerminalServer, listSessions, killSession, killAllSessions, getActivePtyPids, getTerminalProjects, sendToSession, broadcastToSession, broadcastNotification, broadcastChatUpdate, findSessionByClaudeId, getPendingPermissions, clearPermission, addPendingPermission, respondToPermission, listDevSessions, killDevSession, setInFlightTool, clearInFlightTool, getInFlightTool, registerProcess, deregisterProcess, getProcessRegistry, pipeSend, pipeInterrupt, pipeSetModel, getSessionMessages };

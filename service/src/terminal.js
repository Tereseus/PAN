// PAN Terminal — WebSocket-backed PTY sessions
// Spawns real shell processes, streams I/O to dashboard via WebSocket.
// Each project gets its own terminal session. Phone can switch between them.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
import { WebSocketServer, WebSocket } from 'ws';
import { hostname } from 'os';
import { existsSync } from 'fs';
import { all, insert } from './db.js';
import { injectSessionContext } from './routes/hooks.js';
import { subscribeToTranscript } from './transcript-watcher.js';

// Active terminal sessions: Map<sessionId, { pty, term, clients, ... }>
const sessions = new Map();

// In-flight tool tracker — keyed by normalized cwd. Updated by the
// PreToolUse / PostToolUse / SubagentStart / SubagentStop hooks so the
// dashboard status bar can show the user what Claude is actually doing
// instead of staring at a dead "thinking" spinner. Replaces the 30-min
// black hole where a long Bash or Explore subagent looks identical to a
// crash.
//   key = cwd (forward-slashed, lowercased on Windows)
//   value = { tool, summary, startedAt, claudeSessionId, isSubagent }
const inFlightTools = new Map();

function _cwdKey(cwd) {
  if (!cwd) return '';
  return cwd.replace(/\\/g, '/').toLowerCase();
}

function setInFlightTool(cwd, info) {
  const key = _cwdKey(cwd);
  if (!key) return;
  inFlightTools.set(key, { ...info, startedAt: Date.now() });
}

function clearInFlightTool(cwd, claudeSessionId) {
  const key = _cwdKey(cwd);
  if (!key) return;
  const cur = inFlightTools.get(key);
  // Only clear if this PostToolUse matches the in-flight session — prevents
  // a stale Post from a different agent wiping the active tool.
  if (!cur) return;
  if (claudeSessionId && cur.claudeSessionId && cur.claudeSessionId !== claudeSessionId) return;
  inFlightTools.delete(key);
}

function getInFlightTool(cwd) {
  return inFlightTools.get(_cwdKey(cwd)) || null;
}

// Default shell
const SHELL = existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'powershell.exe';
const SHELL_ARGS = SHELL.includes('bash') ? ['--login', '-i'] : [];

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
    // Parse query params: ?session=<id>&project=<name>&cwd=<path>&cols=80&rows=24
    const url = new URL(req.url, 'http://localhost');
    const isDev = url.pathname === '/ws/terminal-dev';
    ws._panDev = true;  // All clients get screen-v2 with append-only log
    ws._logPosition = 0;  // Track log cursor for incremental sync
    const sessionId = url.searchParams.get('session') || 'default';
    const projectName = url.searchParams.get('project') || '';
    const cwd = url.searchParams.get('cwd') || 'C:\\Users\\tzuri\\Desktop';
    const cols = parseInt(url.searchParams.get('cols')) || 120;
    const rows = parseInt(url.searchParams.get('rows')) || 30;

    let session = sessions.get(sessionId);

    if (!session) {
      // Create ScreenBuffer for server-side rendering
      const term = new ScreenBufferClass(cols, rows);

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
          // Liveness tracking — used by listSessions() so the dashboard can
          // derive a real "thinking" state from input-vs-output recency,
          // not local UI state that desyncs across refreshes/tabs.
          lastInputTs: 0,
          lastOutputTs: Date.now(),
        };
        sessions.set(sessionId, session);

        // PTY output -> append-only log (raw) + ScreenBuffer (VT100) -> HTML to clients
        ptyProcess.onData((data) => {
          session.lastOutputTs = Date.now();
          term.write(data);
          // Debounce rendering — batch rapid output into single screen update
          if (!session.renderTimer) {
            session.renderTimer = setTimeout(() => {
              session.renderTimer = null;
              broadcastRenderedScreen(session);
            }, 33); // ~30fps — sufficient for terminal output
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          const uptimeMs = Date.now() - (session.createdAt || Date.now());
          // Log to events DB so the crash is permanent + recoverable after refresh.
          // This is the signal the dashboard renders as a red banner.
          try {
            insert(`INSERT INTO events (session_id, event_type, data) VALUES (:sid, :type, :data)`, {
              ':sid': sessionId,
              ':type': 'PtyExit',
              ':data': JSON.stringify({
                session_id: sessionId,
                project: session.project,
                cwd: session.cwd,
                exit_code: exitCode,
                uptime_ms: uptimeMs,
                pid: ptyProcess.pid,
                timestamp: Date.now(),
              }),
            });
          } catch (err) {
            console.error(`[PAN Terminal] Failed to log PtyExit:`, err.message);
          }
          console.log(`[PAN Terminal] PTY exited: ${sessionId} code=${exitCode} uptime=${Math.round(uptimeMs/1000)}s`);
          for (const client of session.clients) {
            if (client.readyState === 1) {
              client.send(JSON.stringify({
                type: 'exit',
                code: exitCode,
                uptime_ms: uptimeMs,
                project: session.project,
              }));
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

        // Auto-launch Claude Code in the new PTY. Without this, the user sees
        // a bare bash prompt and their messages get fed to bash (which fails),
        // never reaching a Claude session and never producing a JSONL transcript.
        // Wait briefly for bash to finish initializing before sending the command.
        setTimeout(() => {
          try {
            if (sessions.get(sessionId)?.pty) {
              ptyProcess.write('claude\r');
              console.log(`[PAN Terminal] Auto-launched claude in ${sessionId}`);
            }
          } catch (err) {
            console.error(`[PAN Terminal] Failed to auto-launch claude:`, err.message);
          }
        }, 800);
      } catch (err) {
        console.error(`[PAN Terminal] Failed to spawn PTY:`, err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to create terminal: ' + err.message }));
        ws.close();
        return;
      }
    }

    // Add this client to the session
    session.clients.add(ws);

    // Send session info
    ws.send(JSON.stringify({
      type: 'info',
      session: sessionId,
      project: session.project,
      cwd: session.cwd,
      host: hostname(),
    }));

    // Send current screen state immediately (for new/reconnecting clients)
    broadcastRenderedScreen(session, ws);

    // Subscribe this WebSocket to JSONL transcript file changes for the project's
    // cwd. The watcher uses fs.watch to detect any change to .jsonl files in the
    // Claude Code projects dir for this cwd, parses them, and pushes the full
    // message list as `transcript_messages`. Replaces the broken polling model.
    if (cwd) {
      const unsubscribe = subscribeToTranscript(cwd, (messages) => {
        if (ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({ type: 'transcript_messages', messages }));
          } catch (err) {
            console.error('[PAN Terminal] transcript push failed:', err.message);
          }
        }
      });
      ws._unsubscribeTranscript = unsubscribe;
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
            }
            break;

          case 'resize':
            if (parsed.cols && parsed.rows) {
              if (session.pty) session.pty.resize(parsed.cols, parsed.rows);
              session.term.resize(parsed.cols, parsed.rows);
            }
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
  });

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
    const thinking = inputNewer || stillStreaming;
    const inFlight = getInFlightTool(session.cwd);
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

// Return live PTY pids for the orphan reaper's protect set.
function getActivePtyPids() {
  const pids = [];
  for (const [, session] of sessions) {
    if (session.pty?.pid) pids.push(session.pty.pid);
  }
  return pids;
}

// Kill every tracked PTY (called on graceful shutdown so children don't orphan)
function killAllSessions() {
  let n = 0;
  for (const [id, session] of sessions) {
    try {
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

// Legacy aliases — dev terminal now uses the same server-side renderer
function listDevSessions() { return listSessions(); }
function killDevSession(id) { return killSession(id); }

async function startDevTerminalServer() { /* no-op — merged into startTerminalServer */ }

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

export { startTerminalServer, startDevTerminalServer, listSessions, killSession, killAllSessions, getActivePtyPids, getTerminalProjects, sendToSession, broadcastNotification, getPendingPermissions, clearPermission, addPendingPermission, respondToPermission, listDevSessions, killDevSession, setInFlightTool, clearInFlightTool, getInFlightTool };

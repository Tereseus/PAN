// PAN Terminal — WebSocket-backed PTY sessions
// Spawns real shell processes, streams I/O to dashboard via WebSocket.
// Each project gets its own terminal session. Phone can switch between them.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
import { WebSocketServer } from 'ws';
import { hostname } from 'os';
import { existsSync } from 'fs';
import { all } from './db.js';

// Active terminal sessions: Map<sessionId, { pty, clients: Set<ws>, project }>
const sessions = new Map();

// Default shell
const SHELL = existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'powershell.exe';
const SHELL_ARGS = SHELL.includes('bash') ? ['--login', '-i'] : [];

let wss = null;

function startTerminalServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws/terminal' });

  wss.on('connection', (ws, req) => {
    // Parse query params: ?session=<id>&project=<name>&cwd=<path>&cols=80&rows=24
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('session') || 'default';
    const projectName = url.searchParams.get('project') || '';
    const cwd = url.searchParams.get('cwd') || 'C:\\Users\\tzuri\\Desktop';
    const cols = parseInt(url.searchParams.get('cols')) || 120;
    const rows = parseInt(url.searchParams.get('rows')) || 30;

    let session = sessions.get(sessionId);

    if (!session) {
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
          clients: new Set(),
          project: projectName,
          cwd,
          buffer: '', // Keep last 50KB for new clients joining
          createdAt: Date.now(),
        };
        sessions.set(sessionId, session);

        // Stream PTY output to all connected clients
        // Also detect Claude permission prompts for mobile
        let permBuffer = '';
        ptyProcess.onData((data) => {
          // Buffer recent output for late-joining clients
          session.buffer += data;
          if (session.buffer.length > 50000) {
            session.buffer = session.buffer.slice(-25000);
          }
          for (const client of session.clients) {
            if (client.readyState === 1) {
              client.send(JSON.stringify({ type: 'output', data }));
            }
          }

          // Detect Claude Code permission prompts — very specific pattern matching
          // Claude Code shows: "Allow [tool]? (Y)es / (N)o" or similar with Y/n
          const stripped = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
          permBuffer += stripped;
          if (permBuffer.length > 2000) permBuffer = permBuffer.slice(-1000);
          // Match Claude Code's exact permission format: "Allow [something]?" followed by Y/N options
          const permMatch = permBuffer.match(/(?:Allow|Do you want to allow)\s+.{5,80}\?\s*(?:\(Y\)|Yes|Y\/n)/i);
          if (permMatch) {
            const promptText = permMatch[0].trim().substring(0, 200);
            permBuffer = ''; // reset so we don't re-fire
            // Deduplicate — don't fire if same prompt text was detected in last 30 seconds
            const isDupe = pendingPermissions.some(p =>
              p.prompt === promptText && (Date.now() - p.id) < 30000
            );
            if (!isDupe) {
              const permData = {
                session_id: sessionId,
                project: session.project,
                prompt: promptText,
                timestamp: new Date().toISOString(),
              };
              addPendingPermission(permData);
              broadcastNotification('permission_prompt', permData);
            }
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          for (const client of session.clients) {
            if (client.readyState === 1) {
              client.send(JSON.stringify({ type: 'exit', code: exitCode }));
            }
          }
          sessions.delete(sessionId);
        });

        console.log(`[PAN Terminal] New session: ${sessionId} (${projectName || 'shell'}) in ${cwd}`);
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

    // Send buffered output so new clients see recent history
    if (session.buffer) {
      ws.send(JSON.stringify({ type: 'output', data: session.buffer }));
    }

    // Handle incoming messages from client
    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());

        switch (parsed.type) {
          case 'input':
            // User typed something
            if (parsed.data && parsed.data.charCodeAt(0) === 13) {
              console.log(`[PAN Terminal] xterm Enter key: ${JSON.stringify(parsed.data)} bytes: ${[...parsed.data].map(c => c.charCodeAt(0).toString(16)).join(' ')}`);
            }
            if (session.pty) session.pty.write(parsed.data);
            break;

          case 'resize':
            // Terminal resized
            if (session.pty && parsed.cols && parsed.rows) {
              session.pty.resize(parsed.cols, parsed.rows);
            }
            break;

          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
        }
      } catch {}
    });

    ws.on('close', () => {
      if (session) {
        session.clients.delete(ws);
        // Don't kill the PTY when last client disconnects — keep it alive
        // User can reconnect and see the buffer
      }
    });
  });

  console.log(`[PAN Terminal] WebSocket server ready at /ws/terminal`);
}

// List active terminal sessions (for dashboard UI)
function listSessions() {
  const result = [];
  for (const [id, session] of sessions) {
    result.push({
      id,
      project: session.project,
      cwd: session.cwd,
      clients: session.clients.size,
      createdAt: session.createdAt,
    });
  }
  return result;
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
    session.pty.write(text);
    return true;
  }
  return false;
}

// Pending permission prompts — for mobile polling
let pendingPermissions = [];

function addPendingPermission(data) {
  pendingPermissions.push({ ...data, id: Date.now() });
  // No auto-expire — stays until user responds or 5 minutes (safety net)
  const permId = data.id || Date.now();
  setTimeout(() => {
    pendingPermissions = pendingPermissions.filter(p => p.id !== permId);
  }, 300000);
}

function getPendingPermissions() {
  return pendingPermissions;
}

function clearPermission(id) {
  pendingPermissions = pendingPermissions.filter(p => p.id !== id);
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

export { startTerminalServer, listSessions, killSession, getTerminalProjects, sendToSession, broadcastNotification, getPendingPermissions, clearPermission };

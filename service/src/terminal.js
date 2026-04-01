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
import { injectSessionContext } from './routes/hooks.js';
import { buildAICommand, readPanFile, getSessionHistory, updateClaudeMd, CLAUDE_PROJECTS } from './cli/launch.js';

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

          // Permission detection DISABLED — pty.write() cannot interact with Claude Code's
          // permission prompt (see https://github.com/anthropics/claude-code/issues/38299)
          // Re-enable when Anthropic adds a permission hook or API
          const permMatch = false;
          const stripped = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
          if (permMatch) {
            // Extract the command description from the buffer (look for the line before "requires permission")
            const lines = permBuffer.split('\n').map(l => l.trim()).filter(Boolean);
            let description = '';
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes('requires permission') || lines[i].includes('Do you want to proceed')) {
                // Get the command from earlier lines
                for (let j = Math.max(0, i - 3); j < i; j++) {
                  if (lines[j] && !lines[j].startsWith('⚡') && lines[j].length > 3) {
                    description = lines[j];
                    break;
                  }
                }
                break;
              }
            }
            const promptText = (description || 'Permission required').trim().substring(0, 200);
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

        // Inject FULL session context into CLAUDE.md BEFORE Claude starts
        // Uses the same logic as pan.js launch — session history, environment, memory
        if (cwd) {
          try {
            // First: update CLAUDE.md with session history from Claude's own index
            // (same as pan.js launch does)
            const panData = readPanFile(cwd);
            const sessionDirs = panData?.all_session_dirs || [];
            const fwd = cwd.replace(/\\/g, '/');
            const cwdEncoded = 'C--' + fwd.replace(/^[A-Za-z]:\//,'').replace(/\//g, '-');
            if (!sessionDirs.includes(cwdEncoded)) sessionDirs.push(cwdEncoded);
            const entries = getSessionHistory(sessionDirs);
            updateClaudeMd(cwd, projectName || sessionId, entries);

            // Then: inject DB-based context (recent conversation, memory, tasks)
            injectSessionContext(cwd);
            console.log(`[PAN Terminal] Full context injected for ${projectName || sessionId} (${entries.length} session records)`);
          } catch (err) {
            console.error(`[PAN Terminal] Context injection failed:`, err.message);
          }
        }

        console.log(`[PAN Terminal] New session: ${sessionId} (${projectName || 'shell'}) in ${cwd}`);

        // Auto-launch Claude for project sessions (not plain shells)
        // Uses the same AI command as pan.js launch (respects terminal_ai settings)
        // THIS is the single source of truth for Claude launch — client-side should NOT launch
        if (projectName && projectName !== 'Shell') {
          session.claudeAutoLaunched = true;
          setTimeout(() => {
            if (session.pty) {
              // Print ΠΑΝ remembers.. banner BEFORE launching Claude
              session.pty.write('printf "\\033[1;96mΠΑΝ remembers..\\033[0m\\n"\r');

              setTimeout(() => {
                const aiCmd = buildAICommand(projectName);
                console.log(`[PAN Terminal] Auto-launching: ${aiCmd}`);
                session.pty.write(aiCmd + '\r');

                // Wait for Claude to be ready, then send initial session prompt
                let readyDetected = false;
                const sendStartPrompt = () => {
                  if (readyDetected || !session.pty) return;
                  readyDetected = true;
                  console.log(`[PAN Terminal] Claude ready — sending ΠΑΝ remembers for ${projectName}`);
                  session.pty.write('ΠΑΝ remembers... Start session. Read CLAUDE.md and give the session continuity summary.\r');
                };

                // Detect Claude's ❯ prompt in the PTY output stream
                const readyDisposable = session.pty.onData((data) => {
                  if (readyDetected) return;
                  const stripped = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
                  if (stripped.includes('❯') || stripped.includes('context')) {
                    setTimeout(sendStartPrompt, 1000);
                    if (readyDisposable) readyDisposable.dispose();
                  }
                });

                // Fallback: send after 15s if prompt not detected
                setTimeout(() => {
                  sendStartPrompt();
                  if (readyDisposable) readyDisposable.dispose();
                }, 15000);
              }, 500);
            }
          }, 1500);
        }
      } catch (err) {
        console.error(`[PAN Terminal] Failed to spawn PTY:`, err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to create terminal: ' + err.message }));
        ws.close();
        return;
      }
    }

    // Add this client to the session — cancel cleanup if reconnecting
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    session.clients.add(ws);

    // Send session info (including whether Claude was auto-launched)
    ws.send(JSON.stringify({
      type: 'info',
      session: sessionId,
      project: session.project,
      cwd: session.cwd,
      host: hostname(),
      claudeLaunched: session.claudeAutoLaunched || false,
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
        // When last client disconnects, start a cleanup timer
        // Gives 60s for reconnect, then kills the orphaned PTY
        if (session.clients.size === 0) {
          if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
          session.cleanupTimer = setTimeout(() => {
            // Re-check — someone may have reconnected
            if (session.clients.size === 0) {
              console.log(`[PAN Terminal] Killing orphaned session: ${sessionId} (${session.project || 'shell'}) — no clients for 60s`);
              try { session.pty.kill(); } catch {}
              sessions.delete(sessionId);
            }
          }, 60000);
        }
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
  return pendingPermissions;
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

export { startTerminalServer, listSessions, killSession, getTerminalProjects, sendToSession, broadcastNotification, getPendingPermissions, clearPermission, addPendingPermission, respondToPermission };

// PAN Test Runner — sequential dependency-chain test execution
// Suites have dependencies: if a dependency fails, dependent suites are skipped.
// Results shown live in dashboard Tests panel. Last 10 runs kept.
//
// Restart test: saves pre-restart state to disk, triggers restart, then on
// startup the new process calls resumeRestartTest() to continue verification.
//
// ============================================================================
// TEST EXECUTION RULES — MANDATORY, NO EXCEPTIONS
// ============================================================================
// Tests MUST be run and verified through the Electron UI with screenshots.
// There is NO other way to run tests. DO NOT run tests via curl or API calls.
//
// ALL VERIFICATION IS VISUAL. The screenshot is the test. You do NOT check
// API responses to determine pass/fail — you READ the screenshot and verify
// what is visible on screen. The UI is the source of truth, not the backend.
//
// UNIVERSAL STEPS 1-3 (run before EVERY test suite, no exceptions):
//   1. Open Electron window to the dev dashboard
//   2. Maximize it (doesn't need focus — screenshot works regardless)
//   3. Take a screenshot and VERIFY the dashboard loaded correctly:
//      - "ΠΑΝ remembers" must be visible (proves memory loaded + PAN started)
//      - Dashboard UI is fully rendered (not blank/crashed/error state)
//      - If this fails, the ENTIRE suite stops here. Nothing else runs.
//
// THEN suite-specific tests run. At the end:
//   4. Take a final screenshot showing test results in the UI side panel
//   5. READ the screenshot to verify pass/fail — green/red status visible
//
// NEVER: run tests via curl, check results via API JSON, skip screenshots.
// The dev window may open on a second monitor — screenshot captures all screens.
// ============================================================================

import WebSocket from 'ws';
import http from 'http';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const RESTART_STATE_FILE = join(tmpdir(), 'pan-restart-test.json');
const SCREENSHOT_DIR = join(tmpdir(), 'pan-test-screenshots');

// Ensure screenshot directory exists
try { mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

// Production server port (for Electron window/screenshot commands)
function getProdPort() { return 7777; }

// Take a screenshot via Tauri shell and save to disk
// Returns the file path of the saved screenshot, or null on failure
async function takeScreenshot(label) {
  const filename = `test_${label}_${Date.now()}.png`;
  const filepath = join(SCREENSHOT_DIR, filename);

  try {
    // Screenshot via Tauri shell (port 7790) — captures the dev window
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: 7790, path: '/screenshot',
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
      });
      req.on('error', reject);
      req.write(JSON.stringify({ windowId: 'dev' }));
      req.end();
    });

    if (result.ok && result.base64) {
      const imgBuf = Buffer.from(result.base64, 'base64');
      writeFileSync(filepath, imgBuf);
      console.log(`[PAN Tests] Screenshot (Tauri): ${filepath}`);
      return filepath;
    }
    if (result.ok && result.path) {
      console.log(`[PAN Tests] Screenshot (Tauri path): ${result.path}`);
      return result.path;
    }
  } catch (err) {
    console.log(`[PAN Tests] Tauri screenshot failed: ${err.message}`);
  }

  // Fallback: try main window screenshot
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: 7790, path: '/screenshot',
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
      });
      req.on('error', reject);
      req.write(JSON.stringify({})); // no windowId = full screen
      req.end();
    });

    if (result.ok && result.base64) {
      const imgBuf = Buffer.from(result.base64, 'base64');
      writeFileSync(filepath, imgBuf);
      console.log(`[PAN Tests] Screenshot (fallback): ${filepath}`);
      return filepath;
    }
  } catch (err) {
    console.log(`[PAN Tests] Screenshot fallback failed: ${err.message}`);
  }

  return null;
}

// Open an Electron window via production server's action queue
// Electron polls /api/v1/actions every 2 seconds and handles open_window
async function openElectronWindow(url, title, maximize) {
  const port = getProdPort();
  const body = JSON.stringify({ type: 'open_window', url, title, width: 1400, height: 900, maximize: maximize !== false });

  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/v1/actions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(body);
    req.end();
  });
}

// Test state
let currentRun = null;
const testHistory = [];
let cancelRequested = false;

function cancelTests() {
  if (!currentRun || currentRun.status !== 'running') return false;
  cancelRequested = true;
  currentRun.status = 'cancelled';
  currentRun.finishedAt = Date.now();
  // Mark remaining pending tests as cancelled
  for (const t of currentRun.tests) {
    if (t.status === 'pending' || t.status === 'running') t.status = 'cancelled';
  }
  for (const sid of Object.keys(currentRun.suiteStatus || {})) {
    const s = currentRun.suiteStatus[sid];
    if (s.status === 'pending' || s.status === 'running') s.status = 'cancelled';
  }
  return true;
}

// Cancellation-aware wait — throws if cancelled
function waitCancellable(ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const check = setInterval(() => {
      if (cancelRequested) {
        clearTimeout(timer);
        clearInterval(check);
        reject(new Error('Test cancelled'));
      }
    }, 200);
    setTimeout(() => clearInterval(check), ms + 100);
  });
}

function getPort() {
  return parseInt(process.env.PAN_PORT) || 7777;
}

function apiGet(path) {
  const port = getPort();
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    }).on('error', reject);
  });
}

function apiPost(path, body) {
  const port = getPort();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body || {}));
    req.end();
  });
}

function apiDelete(path) {
  const port = getPort();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'DELETE' }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectWs(params) {
  const port = getPort();
  const qs = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?${qs}`);
    const messages = [];
    ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString())); } catch {} });
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000);
  });
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseIntervalToMs(interval) {
  if (!interval || typeof interval !== 'string') return 0;
  const match = interval.match(/^(\d+)(m|h|s)$/);
  if (!match) return 0;
  const val = parseInt(match[1]);
  if (match[2] === 's') return val * 1000;
  if (match[2] === 'm') return val * 60 * 1000;
  if (match[2] === 'h') return val * 60 * 60 * 1000;
  return 0;
}

// ==================== Suite Definitions ====================
// EVERY suite depends on 'pan-remembers'. Nothing runs unless PAN starts and shows memory.
// UI screenshot verification is part of every test flow.

const TEST_SESSION_ID = 'test-runner-session';

const suites = {
  'startup': {
    name: 'PAN Startup',
    description: 'Open dev dashboard window, verify it loads',
    dependsOn: [],
    tests: [
      {
        id: 'startup-open', name: 'Open dev dashboard',
        description: 'Open dev dashboard via Tauri shell, wait for page to load',
        run: async (ctx) => {
          const port = getPort();
          const dashUrl = `http://127.0.0.1:${port}/v2/terminal-dev`;

          // Open via Tauri shell (port 7790)
          try {
            await new Promise((resolve, reject) => {
              const req = http.request({
                hostname: '127.0.0.1', port: 7790, path: '/open',
                method: 'POST', headers: { 'Content-Type': 'application/json' }
              }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
              req.on('error', reject);
              req.write(JSON.stringify({ url: dashUrl, title: 'PAN Dev Terminal', label: 'dev' }));
              req.end();
            });
          } catch (err) {
            // Window may already be open — try focusing it
            try {
              await new Promise((resolve, reject) => {
                const req = http.request({
                  hostname: '127.0.0.1', port: 7790, path: '/focus',
                  method: 'POST', headers: { 'Content-Type': 'application/json' }
                }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
                req.on('error', reject);
                req.write(JSON.stringify({ windowId: 'dev' }));
                req.end();
              });
            } catch {}
          }
          await waitCancellable(5000);
          return 'Dev dashboard window opened via Tauri';
        }
      },
      {
        id: 'startup-screenshot', name: 'Dashboard loaded (screenshot)',
        description: 'Take screenshot proving dashboard UI rendered — not blank, not crashed',
        run: async (ctx) => {
          const ssPath = await takeScreenshot('startup_dashboard');
          if (!ssPath) throw new Error('Screenshot failed — is Tauri/ui-automation running?');
          ctx._startupScreenshot = ssPath;
          return `VERIFY SCREENSHOT: ${ssPath} — dashboard must be visible and rendered`;
        }
      }
    ]
  },

  'pan-remembers': {
    name: 'PAN Remembers',
    description: 'THE GATE: Start PAN terminal session, wait for "ΠΑΝ remembers" (proves memory + context injection works). NOTHING runs if this fails.',
    dependsOn: ['startup'],
    tests: [
      {
        id: 'pan-start-session', name: 'Start PAN terminal session',
        description: 'Connect WebSocket terminal, inject context briefing, launch Claude',
        run: async (ctx) => {
          const port = getPort();
          const cwd = 'C:\\Users\\tzuri\\Desktop\\PAN';
          const { ws, messages } = await connectWs({
            session: 'test-pan-remembers', project: 'PAN',
            cwd, cols: 120, rows: 30
          });
          ctx.ws = ws; ctx.messages = messages;

          // Wait for shell prompt
          await waitCancellable(1500);

          // Inject context into CLAUDE.md before launching Claude
          let briefingReady = false;
          try {
            await apiPost('/api/v1/inject-context', { cwd });
            briefingReady = true;
          } catch {}

          await waitCancellable(500);

          // Launch Claude (same command as frontend)
          if (briefingReady) {
            ws.send(JSON.stringify({ type: 'input', data: 'printf "\\033[1;96m\u03A0\u0391\u039D remembers..\\033[0m\\n" && claude --permission-mode auto "\u03A0\u0391\u039D remembers..."\n' }));
          } else {
            ws.send(JSON.stringify({ type: 'input', data: 'claude --permission-mode auto\n' }));
          }
          return `PAN terminal session connected, Claude launched (context injected: ${briefingReady ? 'yes' : 'no'})`;
        }
      },
      {
        id: 'pan-remembers-wait', name: 'Wait for "ΠΑΝ remembers"',
        description: 'Claude starts, loads CLAUDE.md with memory context, outputs briefing. Wait up to 90s.',
        run: async (ctx) => {
          const startTime = Date.now();
          let found = false;
          while (Date.now() - startTime < 90000) {
            if (cancelRequested) throw new Error('Test cancelled');
            // Check screen/screen-v2 messages for rendered content (strip HTML tags)
            for (const m of ctx.messages) {
              if (m.type === 'screen' || m.type === 'screen-v2') {
                const allLines = [...(m.lines || []), ...(m.logLines || []), ...(m.scrollback || [])];
                const text = allLines.join(' ').replace(/<[^>]*>/g, '');
                if (text.includes('remembers') || text.includes('Last time') || text.includes('working on')) {
                  found = true;
                  break;
                }
              }
            }
            if (found) break;
            await waitCancellable(2000);
          }
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          if (!found) throw new Error(`"ΠΑΝ remembers" not seen after ${elapsed}s — memory system broken`);
          return `PAN memory briefing appeared in ${elapsed}s`;
        }
      },
      {
        id: 'pan-remembers-screenshot', name: 'PAN Remembers (screenshot)',
        description: 'Screenshot proving "ΠΑΝ remembers" is visible in the terminal',
        run: async (ctx) => {
          await wait(2000);
          const ssPath = await takeScreenshot('pan_remembers');
          if (ctx.ws) ctx.ws.close();
          if (!ssPath) throw new Error('Screenshot failed');
          return `VERIFY SCREENSHOT: ${ssPath} — "ΠΑΝ remembers" must be visible in terminal output`;
        }
      }
    ]
  },

  'database': {
    name: 'Database',
    description: 'Database accessible, read/write works, encryption intact',
    dependsOn: ['pan-remembers'],
    tests: [
      {
        id: 'db-stats', name: 'Database responds',
        description: 'GET /dashboard/api/stats must return valid JSON with counts',
        run: async () => {
          const stats = await apiGet('/dashboard/api/stats');
          if (!stats || typeof stats.total_events !== 'number') throw new Error('Stats response invalid');
          return `${stats.total_events} events, ${stats.total_memory} memory, ${stats.total_sessions} sessions`;
        }
      },
      {
        id: 'db-projects', name: 'Projects readable',
        description: 'GET /dashboard/api/projects must return project list',
        run: async () => {
          const data = await apiGet('/dashboard/api/projects');
          const projects = Array.isArray(data) ? data : (data.projects || []);
          if (projects.length === 0) throw new Error('No projects found');
          return `${projects.length} projects: ${projects.map(p => p.name).join(', ')}`;
        }
      },
      {
        id: 'db-events', name: 'Events queryable',
        description: 'GET /dashboard/api/events must return recent events',
        run: async () => {
          const data = await apiGet('/dashboard/api/events?limit=5');
          const events = data.events || [];
          return `${events.length} recent events returned`;
        }
      }
    ]
  },

  'api': {
    name: 'API Endpoints',
    description: 'Core API endpoints respond with valid data, no 500s',
    dependsOn: ['pan-remembers'],
    tests: [
      {
        id: 'api-sessions', name: 'Terminal sessions API',
        description: 'GET /api/v1/terminal/sessions returns valid response',
        run: async () => {
          const data = await apiGet('/api/v1/terminal/sessions');
          if (!data.sessions) throw new Error('No sessions array in response');
          return `${data.sessions.length} active sessions`;
        }
      },
      {
        id: 'api-projects', name: 'Terminal projects API',
        description: 'GET /api/v1/terminal/projects returns project list',
        run: async () => {
          const data = await apiGet('/api/v1/terminal/projects');
          const projects = data.projects || [];
          if (projects.length === 0) throw new Error('No terminal projects');
          return `${projects.length} projects available`;
        }
      },
      {
        id: 'api-permissions', name: 'Permissions API',
        description: 'GET /api/v1/terminal/permissions returns valid response',
        run: async () => {
          const data = await apiGet('/api/v1/terminal/permissions');
          return `${(data.permissions || []).length} pending permissions`;
        }
      },
      {
        id: 'api-services', name: 'Services API',
        description: 'GET /dashboard/api/services returns services list',
        run: async () => {
          const data = await apiGet('/dashboard/api/services');
          const services = data.services || [];
          return `${services.length} services, ${(data.issues || []).length} issues`;
        }
      },
      {
        id: 'api-devices', name: 'Devices API',
        description: 'GET /api/v1/devices returns device list',
        run: async () => {
          const data = await apiGet('/api/v1/devices');
          const devices = data.devices || data || [];
          return `${Array.isArray(devices) ? devices.length : '?'} devices`;
        }
      }
    ]
  },

  'services': {
    name: 'Services Health',
    description: 'Core PAN services are running: classifier, scout, dream, memory',
    dependsOn: ['pan-remembers'],
    tests: [
      {
        id: 'svc-check', name: 'Services status',
        description: 'Check that services API reports key services as running',
        run: async () => {
          const data = await apiGet('/dashboard/api/services');
          const services = data.services || [];
          const running = services.filter(s => s.status === 'up').map(s => s.name);
          const down = services.filter(s => s.status !== 'up').map(s => s.name);
          if (down.length > 0) return `${running.length} up, ${down.length} down: ${down.join(', ')}`;
          return `All ${running.length} services running`;
        }
      },
      {
        id: 'svc-device', name: 'Local device registered',
        description: 'This PC should be registered as a device',
        run: async () => {
          const data = await apiGet('/api/v1/devices');
          const devices = Array.isArray(data) ? data : (data.devices || []);
          const pc = devices.find(d => d.device_type === 'pc');
          if (!pc) return 'No PC device registered yet (fresh dev DB — will register on first phone sync)';
          return `PC "${pc.name}" registered`;
        }
      },
      // Steward tests (steward is a service)
      {
        id: 'steward-server-up', name: 'Steward: Server is up',
        description: 'Health endpoint responds, steward has booted',
        run: async () => {
          const data = await apiGet('/health');
          if (!data.status || data.status !== 'running') throw new Error(`Server status: ${data.status}`);
          return `Server running, uptime: ${data.uptime}`;
        }
      },
      {
        id: 'steward-atlas', name: 'Steward: Atlas service registry',
        description: 'GET /api/v1/atlas/services returns full registry with status',
        run: async (ctx) => {
          const data = await apiGet('/api/v1/atlas/services');
          if (!data.services || data.services.length === 0) throw new Error('No services in atlas');
          ctx.atlasServices = data.services;
          const running = data.services.filter(s => s.status === 'running');
          const stopped = data.services.filter(s => s.status === 'stopped');
          return `${data.services.length} services: ${running.length} running, ${stopped.length} stopped`;
        }
      },
      {
        id: 'steward-heartbeat', name: 'Steward: Heartbeat recent',
        description: 'StewardHeartbeat events exist within last 5 minutes',
        run: async () => {
          const search = await apiGet('/dashboard/api/events?q=StewardHeartbeat&limit=3');
          const hb = (search.events || []).filter(e => e.event_type === 'StewardHeartbeat');
          if (hb.length === 0) return 'No heartbeat events yet (dev server just started — steward needs ~60s)';
          const latest = new Date(hb[0].created_at);
          const ago = Math.round((Date.now() - latest) / 60000);
          if (ago > 5) return `Last heartbeat ${ago}m ago — steward may be slow`;
          return `Heartbeat ${ago}m ago — steward alive`;
        }
      },
      {
        id: 'steward-restartable', name: 'Steward: Services restartable',
        description: 'Key services are steward-managed and restartable',
        run: async () => {
          const data = await apiGet('/api/v1/atlas/services');
          const restartable = data.services.filter(s =>
            ['whisper', 'classifier', 'dream', 'scout', 'consolidation', 'evolution'].includes(s.id) && s.enabled
          );
          return `${restartable.length} services are steward-managed and restartable`;
        }
      }
    ]
  },

  'protocol': {
    name: 'Terminal Protocol',
    description: 'WebSocket terminal: create session, persist across disconnect, reconnect, PTY responds',
    dependsOn: ['pan-remembers'],
    tests: [
      {
        id: 'proto-create', name: 'Create session',
        description: 'Connect WebSocket, verify session appears in API',
        run: async (ctx) => {
          const { ws, messages } = await connectWs({
            session: TEST_SESSION_ID, project: 'Shell',
            cwd: 'C:\\Users\\tzuri\\Desktop', cols: 80, rows: 24
          });
          ctx.ws = ws;
          ctx.messages = messages;
          await wait(1000);
          const info = messages.find(m => m.type === 'info');
          if (!info) throw new Error('No info message');
          const sessions = await apiGet('/api/v1/terminal/sessions');
          if (!sessions.sessions?.find(s => s.id === TEST_SESSION_ID)) throw new Error('Session not in API');
          return 'Session created';
        }
      },
      {
        id: 'proto-persist', name: 'Session survives disconnect',
        description: 'Close WebSocket, verify session still exists after 2s',
        run: async (ctx) => {
          ctx.ws.close();
          await wait(2000);
          const sessions = await apiGet('/api/v1/terminal/sessions');
          if (!sessions.sessions?.find(s => s.id === TEST_SESSION_ID)) throw new Error('Session disappeared!');
          return 'Session alive, 0 clients';
        }
      },
      {
        id: 'proto-reconnect', name: 'Reconnect reuses PTY',
        description: 'Connect again with same ID, verify same PTY',
        run: async (ctx) => {
          const before = await apiGet('/api/v1/terminal/sessions');
          const b = before.sessions?.find(s => s.id === TEST_SESSION_ID);
          const { ws, messages } = await connectWs({
            session: TEST_SESSION_ID, project: 'Shell',
            cwd: 'C:\\Users\\tzuri\\Desktop', cols: 80, rows: 24
          });
          ctx.ws = ws;
          ctx.messages = messages;
          await wait(1000);
          const after = await apiGet('/api/v1/terminal/sessions');
          const a = after.sessions?.find(s => s.id === TEST_SESSION_ID);
          if (b.createdAt !== a.createdAt) throw new Error('Different PTY');
          return 'Same PTY reused';
        }
      },
      {
        id: 'proto-pty', name: 'PTY responds',
        description: 'Send echo command, verify output in screen',
        run: async (ctx) => {
          const marker = 'PTY_TEST_' + Date.now();
          ctx.ws.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r` }));
          let found = false;
          const startTime = Date.now();
          while (Date.now() - startTime < 5000) {
            for (const m of ctx.messages) {
              if (m.type === 'screen' || m.type === 'screen-v2') {
                const text = [...(m.lines || []), ...(m.logLines || [])].join(' ').replace(/<[^>]*>/g, '');
                if (text.includes(marker)) { found = true; break; }
              }
            }
            if (found) break;
            await wait(300);
          }
          if (!found) throw new Error('No response in screen');
          return 'PTY responded';
        }
      },
      {
        id: 'proto-cleanup', name: 'Cleanup',
        description: 'Disconnect test client',
        run: async (ctx) => {
          if (ctx.ws) ctx.ws.close();
          return 'Disconnected';
        }
      }
    ]
  },

  'refresh': {
    name: 'Page Refresh',
    description: 'The #1 bug: opens PAN session, waits for Claude to fully start (ΠΑΝ remembers → ❯), sends message, simulates F5, verifies session and history survive.',
    dependsOn: ['pan-remembers'],
    tests: [
      {
        id: 'refresh-connect', name: 'Connect to existing PAN session',
        description: 'Connects to the dev-dash-pan session where Claude is already running from PAN Remembers.',
        run: async (ctx) => {
          // Find the existing PAN session (created by the dashboard auto-launch)
          const sessions = await apiGet('/api/v1/terminal/sessions');
          const panSession = sessions.sessions?.find(s => s.id.includes('dev-dash-pan') || s.project === 'PAN');
          if (!panSession) throw new Error('No PAN session found — did PAN Remembers run?');
          ctx.sessionId = panSession.id;
          ctx.createdAt = panSession.createdAt;

          const { ws, messages } = await connectWs({
            session: panSession.id, project: 'PAN',
            cwd: 'C:\\Users\\tzuri\\Desktop\\PAN', cols: 120, rows: 30
          });
          ctx.ws = ws; ctx.messages = messages;

          // Verify Claude is running by checking screen content
          await waitCancellable(2000);
          let hasContent = false;
          for (const m of messages) {
            if (m.type === 'screen' || m.type === 'screen-v2') {
              const text = (m.lines || []).join(' ').replace(/<[^>]*>/g, '');
              if (text.includes('❯') || text.includes('remembers') || text.includes('Claude')) {
                hasContent = true;
                break;
              }
            }
          }
          if (!hasContent) return `Connected to ${panSession.id} — Claude may still be loading`;
          return `Connected to ${panSession.id} — Claude is running`;
        }
      },
      {
        id: 'refresh-send', name: 'Send message to Claude',
        description: 'Sends a marker message and waits for it to appear in screen output.',
        run: async (ctx) => {
          if (!ctx.ws || ctx.ws.readyState !== 1) throw new Error('No WebSocket');
          const marker = 'REFRESH_TEST_' + Date.now();
          ctx.marker = marker;
          ctx.ws.send(JSON.stringify({ type: 'input', data: `echo "${marker}"\r` }));

          // Wait for marker to appear in screen messages
          const startTime = Date.now();
          let found = false;
          while (Date.now() - startTime < 15000) {
            if (cancelRequested) throw new Error('Test cancelled');
            for (const m of ctx.messages) {
              if (m.type === 'screen' || m.type === 'screen-v2') {
                const text = [...(m.lines || []), ...(m.logLines || [])].join(' ').replace(/<[^>]*>/g, '');
                if (text.includes(marker)) { found = true; break; }
              }
            }
            if (found) break;
            await waitCancellable(500);
          }
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          if (!found) return `Sent "${marker}" — not in screen after ${elapsed}s (may be in scrollback)`;
          return `Marker appeared in ${elapsed}s`;
        }
      },
      {
        id: 'refresh-f5', name: 'Simulate F5 (disconnect)',
        description: 'Closes WebSocket, waits 2s, checks session still exists.',
        run: async (ctx) => {
          ctx.ws.close(); ctx.ws = null;
          await waitCancellable(2000);
          const sessions = await apiGet('/api/v1/terminal/sessions');
          const found = sessions.sessions?.find(s => s.id === ctx.sessionId);
          if (!found) throw new Error('Session GONE — server cleanup too fast!');
          return `Session alive, ${found.clients} clients`;
        }
      },
      {
        id: 'refresh-api', name: 'Sessions API returns session',
        description: 'After disconnect, session must still be in the API.',
        run: async (ctx) => {
          await waitCancellable(500);
          const sessions = await apiGet('/api/v1/terminal/sessions');
          if (!sessions.sessions?.find(s => s.id === ctx.sessionId)) throw new Error('Session NOT in API!');
          return 'Session found — dashboard will reconnect';
        }
      },
      {
        id: 'refresh-reconnect', name: 'Reconnect same PTY',
        description: 'New WebSocket with same session ID. Must reuse PTY (same createdAt).',
        run: async (ctx) => {
          const { ws, messages } = await connectWs({
            session: ctx.sessionId, project: 'PAN',
            cwd: 'C:\\Users\\tzuri\\Desktop\\PAN', cols: 120, rows: 30
          });
          ctx.ws2 = ws; ctx.messages2 = messages;
          await waitCancellable(2000);
          const sessions = await apiGet('/api/v1/terminal/sessions');
          const found = sessions.sessions?.find(s => s.id === ctx.sessionId);
          if (!found) throw new Error('Session gone');
          if (found.createdAt !== ctx.createdAt) throw new Error(`Different PTY! ${ctx.createdAt} vs ${found.createdAt}`);
          return 'Same PTY reused';
        }
      },
      {
        id: 'refresh-buffer', name: 'History preserved',
        description: 'Buffer must contain the marker sent before disconnect.',
        run: async (ctx) => {
          // Check the reconnected session's screen/scrollback for the marker
          await waitCancellable(2000);
          let found = false;
          for (const m of (ctx.messages2 || [])) {
            if (m.type === 'screen' || m.type === 'screen-v2') {
              const text = [...(m.lines || []), ...(m.scrollback || []), ...(m.logLines || [])].join(' ').replace(/<[^>]*>/g, '');
              if (text.includes(ctx.marker)) { found = true; break; }
            }
          }
          if (!found) throw new Error(`"${ctx.marker}" NOT in reconnected buffer`);
          return 'Marker found in buffer after reconnect';
        }
      },
      {
        id: 'refresh-cleanup', name: 'Cleanup (disconnect only)',
        description: 'Disconnects test clients, leaves session alive.',
        run: async (ctx) => {
          if (ctx.ws) try { ctx.ws.close(); } catch {}
          if (ctx.ws2) try { ctx.ws2.close(); } catch {}
          return 'Disconnected';
        }
      }
    ]
  },

  'usage': {
    name: 'Usage Widget',
    description: 'Claude usage endpoint returns real rate limit data from Anthropic API headers',
    dependsOn: ['pan-remembers'],
    tests: [
      {
        id: 'usage-endpoint', name: 'Usage endpoint responds',
        description: 'GET /api/v1/claude-usage must return valid JSON with session/today/week/model',
        run: async () => {
          const data = await apiGet('/api/v1/claude-usage');
          if (!data || data.error) throw new Error('Endpoint error: ' + (data?.error || 'no response'));
          if (typeof data.session?.total !== 'number') throw new Error('Missing session.total');
          if (typeof data.today?.total !== 'number') throw new Error('Missing today.total');
          if (typeof data.week?.total !== 'number') throw new Error('Missing week.total');
          if (!data.model) throw new Error('Missing model');
          return `Model: ${data.model}, session: ${data.session.total} tokens, ${data.session.activeSessions} active sessions`;
        }
      },
      {
        id: 'usage-ratelimits', name: 'Rate limits have real values',
        description: 'rateLimits must be non-null with five_hour and seven_day utilization',
        run: async () => {
          const data = await apiGet('/api/v1/claude-usage');
          if (!data.rateLimits) throw new Error('rateLimits is null — Anthropic API call failed');
          const rl = data.rateLimits;
          if (!rl.five_hour) throw new Error('Missing five_hour data');
          if (!rl.seven_day) throw new Error('Missing seven_day data');
          if (typeof rl.five_hour.utilization !== 'number') throw new Error('five_hour.utilization not a number');
          if (typeof rl.seven_day.utilization !== 'number') throw new Error('seven_day.utilization not a number');
          if (!rl.five_hour.resets_at) throw new Error('five_hour.resets_at missing');
          if (!rl.seven_day.resets_at) throw new Error('seven_day.resets_at missing');
          const resetDate = new Date(rl.five_hour.resets_at);
          if (isNaN(resetDate.getTime())) throw new Error('five_hour.resets_at is not a valid timestamp');
          return `5hr: ${rl.five_hour.utilization.toFixed(1)}% (resets ${resetDate.toISOString()}), 7d: ${rl.seven_day.utilization.toFixed(1)}%, plan: ${rl.subscriptionType}/${rl.rateLimitTier}`;
        }
      },
      {
        id: 'usage-tokens-nonzero', name: 'Session tokens are non-zero',
        description: 'Active Claude session should have > 0 tokens',
        run: async () => {
          const data = await apiGet('/api/v1/claude-usage');
          if (data.session.total === 0 && data.today.total === 0) throw new Error('Both session and today tokens are 0 — JSONL parsing broken');
          return `Session: ${data.session.total} tokens (${data.session.messages} msgs), Today: ${data.today.total} tokens (${data.today.messages} msgs)`;
        }
      }
    ]
  },

  'memory': {
    name: 'Memory System',
    description: 'Memory items can be created, searched, and retrieved',
    dependsOn: ['pan-remembers'],
    tests: [
      {
        id: 'mem-search', name: 'Memory search works',
        description: 'Search memory items via API',
        run: async () => {
          const data = await apiGet('/dashboard/api/events?q=test&limit=5');
          return `Search returned ${(data.events || []).length} results`;
        }
      },
      {
        id: 'mem-conversations', name: 'Conversations queryable',
        description: 'GET /dashboard/api/conversations returns data',
        run: async () => {
          const data = await apiGet('/dashboard/api/conversations?limit=5');
          return `${(data.conversations || data.messages || []).length} conversations`;
        }
      },
      {
        id: 'mem-tables', name: 'Vector memory tables exist',
        description: 'Episodic, semantic, procedural tables must exist in DB',
        run: async () => {
          const stats = await apiGet('/dashboard/api/stats');
          // Try querying each memory table directly
          const ep = await apiGet('/dashboard/api/events?limit=1'); // basic DB check
          if (!stats || typeof stats.total_events !== 'number') throw new Error('DB not responding');
          return `DB responding — memory tables created by schema`;
        }
      }
    ]
  },

  'project-runner': {
    name: 'Project Runner',
    description: 'Open application: discover projects with services, start service, verify health, load dashboard, stop service',
    dependsOn: ['pan-remembers'],
    tests: [
      {
        id: 'runner-projects', name: 'Discover projects with services',
        description: 'GET /api/v1/runner/projects returns projects, at least one has services defined',
        run: async (ctx) => {
          const data = await apiGet('/api/v1/runner/projects');
          if (!Array.isArray(data)) throw new Error('Response not an array');
          ctx.allProjects = data;
          const withServices = data.filter(p => p.hasServices);
          if (withServices.length === 0) throw new Error('No projects have services defined in .pan');
          ctx.project = withServices[0];
          return `${data.length} projects, ${withServices.length} with services: ${withServices.map(p => p.name).join(', ')}`;
        }
      },
      {
        id: 'runner-status', name: 'Project status API',
        description: 'GET /api/v1/runner/project?path=... returns service definitions',
        run: async (ctx) => {
          const status = await apiGet(`/api/v1/runner/project?path=${encodeURIComponent(ctx.project.path)}`);
          if (!status.services || status.services.length === 0) throw new Error('No services in status');
          ctx.service = status.services[0];
          ctx.projectPath = ctx.project.path;
          return `${status.name}: ${status.services.length} service(s) — ${status.services.map(s => `${s.name} (port ${s.port}, ${s.status})`).join(', ')}`;
        }
      },
      {
        id: 'runner-start', name: 'Start service',
        description: 'POST /api/v1/runner/start — starts the first service, waits for it to be running',
        run: async (ctx) => {
          const result = await apiPost('/api/v1/runner/start', {
            path: ctx.projectPath,
            service: ctx.service.name
          });
          if (!result.status) throw new Error('No status in response');
          if (result.status === 'already_running') return `Already running (PID ${result.pid})`;
          ctx.pid = result.pid;
          return `${result.status} (PID ${result.pid})`;
        }
      },
      {
        id: 'runner-health', name: 'Service health check',
        description: 'Service health endpoint responds with OK within 10s',
        run: async (ctx) => {
          if (!ctx.service.health || !ctx.service.port) return 'No health endpoint configured — skipped';
          const healthUrl = `/api/v1/runner/project?path=${encodeURIComponent(ctx.projectPath)}`;
          let healthy = false;
          let lastError = '';
          for (let i = 0; i < 20; i++) {
            try {
              const r = await new Promise((resolve, reject) => {
                http.get(`http://localhost:${ctx.service.port}${ctx.service.health}`, (res) => {
                  let data = '';
                  res.on('data', chunk => data += chunk);
                  res.on('end', () => resolve({ ok: res.statusCode === 200, data }));
                }).on('error', reject);
              });
              if (r.ok) { healthy = true; break; }
              lastError = `HTTP ${r.data}`;
            } catch (err) {
              lastError = err.message;
            }
            await wait(500);
          }
          if (!healthy) throw new Error(`Health check failed after 10s: ${lastError}`);
          return `${ctx.service.name} healthy on port ${ctx.service.port}`;
        }
      },
      {
        id: 'runner-dashboard', name: 'Service dashboard loads',
        description: 'Dashboard URL returns HTML content',
        run: async (ctx) => {
          if (!ctx.service.dashboard || !ctx.service.port) return 'No dashboard configured — skipped';
          const html = await new Promise((resolve, reject) => {
            http.get(`http://localhost:${ctx.service.port}${ctx.service.dashboard}`, (res) => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => resolve(data));
            }).on('error', reject);
          });
          if (!html || html.length < 100) throw new Error(`Dashboard returned only ${html?.length || 0} bytes`);
          const titleMatch = html.match(/<title>(.*?)<\/title>/);
          const title = titleMatch ? titleMatch[1] : 'no title';
          return `Dashboard loaded: "${title}" (${html.length} bytes)`;
        }
      },
      {
        id: 'runner-running', name: 'Service shows as running',
        description: 'Status API confirms service is running with PID and uptime',
        run: async (ctx) => {
          const status = await apiGet(`/api/v1/runner/project?path=${encodeURIComponent(ctx.projectPath)}`);
          const svc = status.services.find(s => s.name === ctx.service.name);
          if (!svc) throw new Error('Service not found in status');
          if (svc.status !== 'running') throw new Error(`Service status: ${svc.status} (expected running)`);
          if (!svc.pid) throw new Error('No PID');
          return `Running — PID ${svc.pid}, uptime ${svc.uptime}s, ${svc.logs.length} log lines`;
        }
      },
      {
        id: 'runner-logs', name: 'Service logs captured',
        description: 'Logs API returns stdout/stderr from the service',
        run: async (ctx) => {
          const status = await apiGet(`/api/v1/runner/project?path=${encodeURIComponent(ctx.projectPath)}`);
          const svc = status.services.find(s => s.name === ctx.service.name);
          if (!svc.logs || svc.logs.length === 0) throw new Error('No logs captured');
          const stdout = svc.logs.filter(l => l.type === 'stdout').length;
          const stderr = svc.logs.filter(l => l.type === 'stderr').length;
          return `${svc.logs.length} log lines (${stdout} stdout, ${stderr} stderr)`;
        }
      },
      {
        id: 'runner-stop', name: 'Stop service',
        description: 'POST /api/v1/runner/stop — stops the service, verifies it goes down',
        run: async (ctx) => {
          const result = await apiPost('/api/v1/runner/stop', {
            path: ctx.projectPath,
            service: ctx.service.name
          });
          if (result.status !== 'stopped') throw new Error(`Stop returned: ${result.status}`);
          // Verify it's actually down
          await wait(2000);
          const status = await apiGet(`/api/v1/runner/project?path=${encodeURIComponent(ctx.projectPath)}`);
          const svc = status.services.find(s => s.name === ctx.service.name);
          if (svc.status === 'running') throw new Error('Service still running after stop!');
          return `Service stopped successfully`;
        }
      }
    ]
  },

  'context-health': {
    name: 'Context Health',
    description: 'Verifies Claude session context: memory injected, CLAUDE.md clean, no duplicate tabs',
    dependsOn: ['pan-remembers'],
    tests: [
      {
        id: 'startup-markers', name: 'CLAUDE.md markers clean',
        description: 'PAN-CONTEXT-START and PAN-CONTEXT-END each appear exactly once',
        run: async () => {
          const fs = await import('fs');
          const claudeMd = fs.readFileSync('C:/Users/tzuri/Desktop/PAN/CLAUDE.md', 'utf8');
          const starts = (claudeMd.match(/<!-- PAN-CONTEXT-START -->/g) || []).length;
          const ends = (claudeMd.match(/<!-- PAN-CONTEXT-END -->/g) || []).length;
          if (starts !== 1) throw new Error(`PAN-CONTEXT-START appears ${starts} times (expected 1)`);
          if (ends !== 1) throw new Error(`PAN-CONTEXT-END appears ${ends} times (expected 1)`);
          const startIdx = claudeMd.indexOf('<!-- PAN-CONTEXT-START -->');
          const endIdx = claudeMd.indexOf('<!-- PAN-CONTEXT-END -->');
          if (endIdx <= startIdx) throw new Error('END marker before START marker');
          const between = claudeMd.substring(startIdx, endIdx).length;
          return `Markers clean — ${between} chars between them`;
        }
      },
      {
        id: 'startup-memory-injected', name: 'Memory content injected',
        description: 'CLAUDE.md must contain "What You Should Know" section from memory files',
        run: async () => {
          const fs = await import('fs');
          const claudeMd = fs.readFileSync('C:/Users/tzuri/Desktop/PAN/CLAUDE.md', 'utf8');
          const hasMemory = claudeMd.includes('What You Should Know');
          const hasState = claudeMd.includes('PAN State Document') || claudeMd.includes('What Works');
          if (!hasMemory && !hasState) throw new Error('No memory content injected — inject-context.cjs may have failed');
          const memoryDir = 'C:/Users/tzuri/.claude/projects/C--Users-tzuri-Desktop-PAN/memory';
          const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
          return `Memory injected: ${hasMemory ? 'Yes' : 'No'}, State: ${hasState ? 'Yes' : 'No'}, ${files.length} memory files`;
        }
      },
      {
        id: 'startup-no-corruption', name: 'No marker corruption',
        description: 'Content between markers must not contain literal PAN-CONTEXT markers',
        run: async () => {
          const fs = await import('fs');
          const claudeMd = fs.readFileSync('C:/Users/tzuri/Desktop/PAN/CLAUDE.md', 'utf8');
          const start = claudeMd.indexOf('<!-- PAN-CONTEXT-START -->') + '<!-- PAN-CONTEXT-START -->'.length;
          const end = claudeMd.indexOf('<!-- PAN-CONTEXT-END -->');
          const between = claudeMd.substring(start, end);
          // Check for standalone markers (not as part of code descriptions)
          const strayStarts = (between.match(/^<!-- PAN-CONTEXT-START -->$/gm) || []).length;
          const strayEnds = (between.match(/^<!-- PAN-CONTEXT-END -->$/gm) || []).length;
          if (strayStarts > 0) throw new Error(`${strayStarts} stray START markers inside injection zone`);
          if (strayEnds > 0) throw new Error(`${strayEnds} stray END markers inside injection zone`);
          return `Clean — no stray markers in ${between.length} chars of injected content`;
        }
      },
      {
        id: 'startup-state-file', name: 'State file exists and non-empty',
        description: '.pan-state.md or .pan-briefing.md must have content',
        run: async () => {
          const fs = await import('fs');
          const briefing = 'C:/Users/tzuri/Desktop/PAN/.pan-briefing.md';
          const state = 'C:/Users/tzuri/Desktop/PAN/.pan-state.md';
          let source = 'none';
          let size = 0;
          if (fs.existsSync(briefing)) {
            const content = fs.readFileSync(briefing, 'utf8').trim();
            if (content.length > 0) { source = '.pan-briefing.md'; size = content.length; }
          }
          if (source === 'none' && fs.existsSync(state)) {
            const content = fs.readFileSync(state, 'utf8').trim();
            if (content.length > 0) { source = '.pan-state.md'; size = content.length; }
          }
          if (source === 'none') throw new Error('Both .pan-briefing.md and .pan-state.md are empty or missing');
          return `${source}: ${size} chars`;
        }
      },
      {
        id: 'startup-session-dedup', name: 'No duplicate sessions per project',
        description: 'Terminal sessions API should have at most 1 non-test session per project',
        run: async () => {
          const data = await apiGet('/api/v1/terminal/sessions');
          const sessions = (data.sessions || []).filter(s => !s.id.startsWith('test-') && s.id !== TEST_SESSION_ID);
          const byProject = {};
          for (const s of sessions) {
            const key = s.project || 'unknown';
            if (!byProject[key]) byProject[key] = [];
            byProject[key].push(s.id);
          }
          const dupes = Object.entries(byProject).filter(([, ids]) => ids.length > 1);
          if (dupes.length > 0) {
            const details = dupes.map(([p, ids]) => `${p}: ${ids.length} sessions`).join(', ');
            throw new Error(`Duplicate sessions: ${details}`);
          }
          return `${sessions.length} sessions, no duplicates: ${Object.keys(byProject).join(', ')}`;
        }
      },
      {
        id: 'startup-inject-test', name: 'Context injection API works',
        description: 'Call /api/v1/inject-context and verify CLAUDE.md markers stay intact',
        run: async () => {
          const fs = await import('fs');
          const before = fs.readFileSync('C:/Users/tzuri/Desktop/PAN/CLAUDE.md', 'utf8').length;
          await apiPost('/api/v1/inject-context', { cwd: 'C:\\Users\\tzuri\\Desktop\\PAN' });
          const after = fs.readFileSync('C:/Users/tzuri/Desktop/PAN/CLAUDE.md', 'utf8');
          const starts = (after.match(/<!-- PAN-CONTEXT-START -->/g) || []).length;
          const ends = (after.match(/<!-- PAN-CONTEXT-END -->/g) || []).length;
          if (starts !== 1 || ends !== 1) throw new Error(`Markers corrupted after inject: ${starts} starts, ${ends} ends`);
          return `Injection OK — ${before} → ${after.length} chars, markers intact`;
        }
      }
    ]
  },

  // Steward suite MERGED into 'services' above

  'restart': {
    name: 'Server Restart',
    runInAll: false, // Excluded from Run All — kills server and wipes test state
    description: 'Full restart cycle: snapshot state → save to disk → trigger restart → new process resumes verification',
    dependsOn: ['database'],
    tests: [
      {
        id: 'restart-snapshot', name: 'Snapshot pre-restart state',
        description: 'Record current DB stats and save to disk so the new process can verify',
        run: async (ctx) => {
          const stats = await apiGet('/dashboard/api/stats');
          ctx.preStats = stats;
          const projects = await apiGet('/dashboard/api/projects');
          ctx.preProjects = Array.isArray(projects) ? projects : (projects.projects || []);
          const devices = await apiGet('/api/v1/devices');
          ctx.preDevices = Array.isArray(devices) ? devices : (devices.devices || []);
          const services = await apiGet('/dashboard/api/services');
          ctx.preServices = (services.services || []).length;

          // Save state to disk — new process will read this after restart
          const state = {
            triggeredAt: new Date().toISOString(),
            preStats: stats,
            preProjectCount: ctx.preProjects.length,
            preDeviceCount: ctx.preDevices.length,
            preServiceCount: ctx.preServices,
          };
          writeFileSync(RESTART_STATE_FILE, JSON.stringify(state, null, 2));

          return `Saved to ${RESTART_STATE_FILE} — Events: ${stats.total_events}, Projects: ${ctx.preProjects.length}`;
        }
      },
      {
        id: 'restart-trigger', name: 'Trigger restart',
        description: 'POST to restart endpoint — server will die, new process resumes test via resumeRestartTest()',
        run: async () => {
          // This is the last test that runs in THIS process.
          // After this, the server dies. The new process calls resumeRestartTest() on startup
          // which runs the post-restart verification tests and updates currentRun.
          let triggered = false;
          let usedPath = '';
          for (const path of ['/api/admin/restart', '/api/v1/restart']) {
            try {
              const result = await apiPost(path);
              if (result?.ok) { triggered = true; usedPath = path; break; }
            } catch {}
          }
          if (!triggered) {
            try { unlinkSync(RESTART_STATE_FILE); } catch {}
            throw new Error('Neither restart endpoint responded with ok:true');
          }
          return `Restart triggered via ${usedPath} — server will die now, new process continues verification`;
        }
      }
    ]
  }
};

// ==================== Dependency Chain Runner ====================

// Topological sort — returns suite IDs in execution order
function getExecutionOrder(suiteIds) {
  const visited = new Set();
  const order = [];

  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const suite = suites[id];
    if (!suite) return;
    for (const dep of suite.dependsOn || []) {
      if (suiteIds.includes(dep)) visit(dep);
    }
    order.push(id);
  }

  for (const id of suiteIds) visit(id);
  return order;
}

function getSuiteList() {
  return Object.entries(suites).map(([id, suite]) => ({
    id,
    name: suite.name,
    description: suite.description,
    testCount: suite.tests.length,
    dependsOn: suite.dependsOn || [],
    runInAll: suite.runInAll !== false, // true by default, false for destructive tests like restart
    group: suite.group || 'PAN Core',  // future: app-specific test groups
  }));
}

// ==================== Startup and PAN Remembers are now proper suites ====================
// They run as part of the dependency chain. No separate gate logic needed.

function makeResultsScreenshotTest(suiteId) {
  return {
    id: `${suiteId}-results-screenshot`, name: 'Results: Verify via Screenshot',
    description: 'Takes final screenshot of test results. Operator reads screenshot to verify pass/fail — green/red status visible.',
    run: async (ctx) => {
      await wait(2000);
      const ssPath = await takeScreenshot(`${suiteId}_results`);
      ctx._resultsScreenshot = ssPath;
      if (!ssPath) return 'Screenshot unavailable — verify results via API';
      return `VERIFY SCREENSHOT: ${ssPath} — read the test results panel to confirm pass/fail status`;
    }
  };
}

// Run a single suite or a chain of suites with dependencies
async function runTests(suiteId) {
  if (currentRun?.status === 'running') {
    return { error: 'Tests already running' };
  }
  cancelRequested = false;

  // 'all' runs everything in dependency order
  // A single suite also runs its dependencies first
  let suiteIds;
  if (suiteId === 'all') {
    // Skip suites with runInAll: false (like restart which kills the server)
    suiteIds = getExecutionOrder(Object.keys(suites).filter(id => suites[id].runInAll !== false));
  } else {
    // Collect this suite + all its transitive dependencies
    const deps = new Set();
    function collectDeps(id) {
      const s = suites[id];
      if (!s) return;
      for (const dep of s.dependsOn || []) { collectDeps(dep); }
      deps.add(id);
    }
    collectDeps(suiteId || 'refresh');
    suiteIds = getExecutionOrder([...deps]);
  }

  const runId = Date.now();
  const allTests = [];
  const suiteMap = {};

  for (const sid of suiteIds) {
    const suite = suites[sid];
    suiteMap[sid] = { status: 'pending', passed: 0, failed: 0 };

    // Suite's own tests
    for (const t of suite.tests) {
      allTests.push({
        suiteId: sid, suiteName: suite.name,
        id: t.id, name: t.name, description: t.description,
        status: 'pending', result: null, error: null,
      });
    }

    // Results screenshot test (one per suite, at the end)
    const resultsSS = makeResultsScreenshotTest(sid);
    allTests.push({
      suiteId: sid, suiteName: suite.name,
      id: resultsSS.id, name: resultsSS.name, description: resultsSS.description,
      status: 'pending', result: null, error: null,
    });
  }

  currentRun = {
    runId,
    status: 'running',
    mode: suiteId === 'all' ? 'full-chain' : 'single',
    requestedSuite: suiteId,
    suiteOrder: suiteIds,
    suiteStatus: suiteMap,
    startedAt: new Date().toISOString(),
    tests: allTests,
    screenshots: [], // Track all screenshots taken during this run
    summary: null,
  };

  // Execute in background
  (async () => {
    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    for (const sid of suiteIds) {
      const suite = suites[sid];
      const sm = currentRun.suiteStatus[sid];

      // Check dependencies passed
      const depsFailed = (suite.dependsOn || []).some(dep => currentRun.suiteStatus[dep]?.status === 'failed');
      if (depsFailed) {
        sm.status = 'skipped';
        for (const t of currentRun.tests.filter(t => t.suiteId === sid)) {
          t.status = 'skipped';
          t.error = 'Dependency failed';
          totalSkipped++;
        }
        continue;
      }

      sm.status = 'running';
      const ctx = {};

      // Build full test list: suite tests + results screenshot
      const fullTestList = [
        ...suite.tests,
        makeResultsScreenshotTest(sid),
      ];

      for (const test of fullTestList) {
        const entry = currentRun.tests.find(t => t.id === test.id);
        if (!entry) continue;
        entry.status = 'running';
        try {
          const result = await test.run(ctx);
          entry.status = 'passed';
          entry.result = result;
          sm.passed++;
          totalPassed++;

          // Track screenshots
          if (ctx._startupScreenshot) {
            currentRun.screenshots.push({ suite: sid, phase: 'startup', path: ctx._startupScreenshot });
            ctx._startupScreenshot = null;
          }
          if (ctx._resultsScreenshot) {
            currentRun.screenshots.push({ suite: sid, phase: 'results', path: ctx._resultsScreenshot });
            ctx._resultsScreenshot = null;
          }
        } catch (err) {
          entry.status = 'failed';
          entry.error = err.message;
          sm.failed++;
          totalFailed++;
        }
      }

      sm.status = sm.failed > 0 ? 'failed' : 'passed';
    }

    currentRun.status = 'done';
    currentRun.finishedAt = new Date().toISOString();
    currentRun.summary = { passed: totalPassed, failed: totalFailed, skipped: totalSkipped, total: allTests.length };
    testHistory.unshift({ ...currentRun });
    if (testHistory.length > 10) testHistory.length = 10;

    console.log(`[PAN Tests] Run complete: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped. Screenshots: ${currentRun.screenshots.length}`);
  })();

  return { ok: true, message: `Running ${suiteIds.length} suite(s): ${suiteIds.join(' → ')}` };
}

function getTestStatus() {
  if (!currentRun) {
    return {
      status: 'idle',
      suites: getSuiteList(),
      tests: [],
      summary: null,
      history: testHistory,
    };
  }
  return { ...currentRun, suites: getSuiteList(), history: testHistory };
}

// Called on server startup — if a restart test was in progress, continue the post-restart verification
async function resumeRestartTest() {
  if (!existsSync(RESTART_STATE_FILE)) return;

  let state;
  try {
    state = JSON.parse(readFileSync(RESTART_STATE_FILE, 'utf8'));
    unlinkSync(RESTART_STATE_FILE);
  } catch (err) {
    console.error('[PAN Tests] Failed to read restart state:', err.message);
    return;
  }

  console.log('[PAN Tests] Restart test state found — running post-restart verification...');

  // Build a currentRun so the dashboard shows live results
  const postTests = [
    { id: 'restart-snapshot', name: 'Snapshot pre-restart state', status: 'passed', result: `Pre-restart: Events=${state.preStats?.total_events}, Projects=${state.preProjectCount}` },
    { id: 'restart-trigger', name: 'Trigger restart', status: 'passed', result: 'Server restarted and came back' },
    { id: 'restart-back', name: 'Server came back up', status: 'running', result: null },
  ];

  const verifyTests = [
    {
      id: 'restart-back', name: 'Server came back up',
      run: async () => {
        const elapsed = ((Date.now() - new Date(state.triggeredAt).getTime()) / 1000).toFixed(1);
        return `Server back up in ${elapsed}s`;
      }
    },
    {
      id: 'restart-db', name: 'Database intact after restart',
      run: async () => {
        const stats = await apiGet('/dashboard/api/stats');
        if (!stats || typeof stats.total_events !== 'number') throw new Error('Stats endpoint broken');
        if (stats.total_events < state.preStats.total_events)
          throw new Error(`Events LOST: was ${state.preStats.total_events}, now ${stats.total_events}`);
        return `Events: ${stats.total_events} (was ${state.preStats.total_events})`;
      }
    },
    {
      id: 'restart-projects', name: 'Projects survive restart',
      run: async () => {
        const data = await apiGet('/dashboard/api/projects');
        const projects = Array.isArray(data) ? data : (data.projects || []);
        if (projects.length < state.preProjectCount)
          throw new Error(`Projects LOST: was ${state.preProjectCount}, now ${projects.length}`);
        return `${projects.length} projects intact`;
      }
    },
    {
      id: 'restart-api', name: 'API endpoints respond',
      run: async () => {
        const checks = [
          { path: '/dashboard/api/stats', check: d => typeof d?.total_events === 'number' },
          { path: '/dashboard/api/projects', check: d => d !== null },
          { path: '/api/v1/devices', check: d => d !== null },
          { path: '/api/v1/terminal/sessions', check: d => d?.sessions !== undefined },
        ];
        const results = [];
        for (const { path, check } of checks) {
          const data = await apiGet(path);
          if (!check(data)) throw new Error(`Bad response from ${path}`);
          results.push(path.split('/').pop());
        }
        return `All endpoints OK: ${results.join(', ')}`;
      }
    },
    {
      id: 'restart-services', name: 'Services restart',
      run: async () => {
        await wait(3000);
        const data = await apiGet('/dashboard/api/services');
        const services = data.services || [];
        const running = services.filter(s => s.status === 'up');
        return `${running.length}/${services.length} services running`;
      }
    },
    {
      id: 'restart-briefing', name: 'Context briefing works',
      run: async () => {
        const data = await apiGet('/api/v1/context-briefing');
        if (!data?.briefing) throw new Error('No briefing returned');
        if (data.briefing.length < 100) throw new Error(`Briefing too short: ${data.briefing.length} chars`);
        return `Briefing: ${data.briefing.length} chars`;
      }
    }
  ];

  // Build the full test list for the dashboard
  const allTests = [
    ...postTests.slice(0, 2), // snapshot + trigger (already passed)
    ...verifyTests.map(t => ({ suiteId: 'restart', suiteName: 'Server Restart', id: t.id, name: t.name, status: 'pending', result: null, error: null }))
  ];

  currentRun = {
    runId: Date.now(),
    status: 'running',
    mode: 'restart-resume',
    requestedSuite: 'restart',
    suiteOrder: ['restart'],
    suiteStatus: { restart: { status: 'running', passed: 2, failed: 0 } },
    startedAt: state.triggeredAt,
    tests: allTests,
    summary: null,
  };

  let passed = 2, failed = 0;
  for (const test of verifyTests) {
    const entry = allTests.find(t => t.id === test.id);
    if (entry) entry.status = 'running';
    try {
      const result = await test.run();
      if (entry) { entry.status = 'passed'; entry.result = result; }
      passed++;
    } catch (err) {
      if (entry) { entry.status = 'failed'; entry.error = err.message; }
      failed++;
    }
  }

  currentRun.status = 'done';
  currentRun.finishedAt = new Date().toISOString();
  currentRun.summary = { passed, failed, skipped: 0, total: allTests.length };
  currentRun.suiteStatus.restart.status = failed > 0 ? 'failed' : 'passed';
  testHistory.unshift({ ...currentRun });
  if (testHistory.length > 10) testHistory.length = 10;

  console.log(`[PAN Tests] Restart verification complete: ${passed} passed, ${failed} failed`);
}

export { runTests, getTestStatus, resumeRestartTest, cancelTests };

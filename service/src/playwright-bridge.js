/**
 * Playwright MCP Bridge for PAN
 *
 * Spawns `npx @anthropic-ai/mcp-server-playwright` (or `npx @playwright/mcp`)
 * as a child process with stdio JSON-RPC transport.
 * Provides high-level browser automation functions.
 */

import { spawn } from 'child_process';

let mcpProcess = null;
let requestId = 0;
let pendingRequests = new Map(); // id -> { resolve, reject, timeout }
let initialized = false;
let buffer = '';

// ── Lifecycle ──────────────────────────────────────────────────

async function start() {
  if (mcpProcess && !mcpProcess.killed) return true;

  return new Promise((resolve) => {
    try {
      // Try the official Playwright MCP server
      mcpProcess = spawn('npx', ['-y', '@playwright/mcp@latest', '--headless', '--isolated'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });

      buffer = '';

      mcpProcess.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        // JSON-RPC messages are newline-delimited
        let lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            handleMessage(msg);
          } catch {}
        }
      });

      mcpProcess.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) console.log('[Playwright MCP stderr]', text);
      });

      mcpProcess.on('error', (err) => {
        console.error('[Playwright MCP] spawn error:', err.message);
        mcpProcess = null;
        initialized = false;
        resolve(false);
      });

      mcpProcess.on('exit', (code) => {
        console.log('[Playwright MCP] exited with code', code);
        mcpProcess = null;
        initialized = false;
        // Reject all pending
        for (const [id, p] of pendingRequests) {
          clearTimeout(p.timeout);
          p.reject(new Error('MCP process exited'));
        }
        pendingRequests.clear();
      });

      // Send the initialize handshake, with room to breathe and one retry.
      //
      // npx has to resolve the package and boot node before anything reads stdin,
      // and under shell:true that goes through cmd.exe as well. A handshake sent at
      // 1s was simply thrown away, so the bridge reported itself unavailable while
      // the server sat there working fine. Measured: a hand probe that waited 3s got
      // a valid reply ~3s later.
      const handshakeWithRetry = async () => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const initResult = await rpcCall('initialize', {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'pan', version: '1.0.0' }
            }, 25000);
            sendMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
            initialized = true;
            console.log(`[Playwright MCP] initialized on attempt ${attempt}, tools:`,
              initResult?.capabilities?.tools ? 'yes' : 'unknown');
            return true;
          } catch (e) {
            console.warn(`[Playwright MCP] initialize attempt ${attempt} failed: ${e.message}`);
            if (attempt === 1 && mcpProcess && !mcpProcess.killed) {
              // Process is still alive, so the message was lost rather than refused.
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            }
            return false;
          }
        }
        return false;
      };
      
      setTimeout(async () => {
        const ok = await handshakeWithRetry();
        if (!ok) stop();
        resolve(ok);
      }, 3000); // npx + cmd.exe + node boot; 1000ms was too early and lost the write

    } catch (e) {
      console.error('[Playwright MCP] failed to spawn:', e.message);
      resolve(false);
    }
  });
}

function stop() {
  if (mcpProcess && !mcpProcess.killed) {
    const pid = mcpProcess.pid;
    mcpProcess.kill();
    // kill() reaches the cmd.exe wrapper only. npx, node and Chromium below it
    // survive as orphans - four such processes were found still alive, holding
    // memory, long after their parent had gone. Take the whole tree.
    if (process.platform === 'win32' && pid) {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {}
    }
  }
  mcpProcess = null;
  initialized = false;
  pendingRequests.clear();
}

// ── JSON-RPC Transport ─────────────────────────────────────────

function sendMessage(msg) {
  if (!mcpProcess || mcpProcess.killed) throw new Error('MCP not running');
  mcpProcess.stdin.write(JSON.stringify(msg) + '\n');
}

function rpcCall(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timeout });
    sendMessage({ jsonrpc: '2.0', id, method, params });
  });
}

function handleMessage(msg) {
  if (msg.id != null && pendingRequests.has(msg.id)) {
    const p = pendingRequests.get(msg.id);
    clearTimeout(p.timeout);
    pendingRequests.delete(msg.id);
    if (msg.error) {
      p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      p.resolve(msg.result);
    }
  }
}

// ── MCP Tool Calls ─────────────────────────────────────────────

async function callTool(name, args = {}, timeoutMs = 15000) {
  if (!initialized) {
    const ok = await start();
    if (!ok) throw new Error('Playwright MCP not available');
  }
  const result = await rpcCall('tools/call', { name, arguments: args }, timeoutMs);
  // MCP tool results come as { content: [{ type, text }] }
  if (result?.content) {
    const texts = result.content.filter(c => c.type === 'text').map(c => c.text);
    return texts.join('\n');
  }
  return JSON.stringify(result);
}

/** Is the MCP process alive and initialized? */
export function isRunning() {
  return initialized && mcpProcess && !mcpProcess.killed;
}

// ── Public API ─────────────────────────────────────────────────

export async function isAvailable() {
  try {
    if (initialized && mcpProcess && !mcpProcess.killed) return true;
    return await start();
  } catch {
    return false;
  }
}

export async function navigateTo(url) {
  const result = await callTool('browser_navigate', { url });
  return { ok: true, text: result };
}

export async function clickElement(selector) {
  // Playwright MCP uses element descriptions or coordinates
  // Try the snapshot-based click first
  const result = await callTool('browser_click', { element: selector, ref: selector });
  return { ok: true, text: result };
}

export async function typeText(selector, text) {
  const result = await callTool('browser_type', { element: selector, ref: selector, text });
  return { ok: true, text: result };
}

export async function readPage() {
  const result = await callTool('browser_snapshot', {});
  return { ok: true, text: result };
}

export async function screenshot() {
  const result = await callTool('browser_take_screenshot', {});
  return { ok: true, text: result };
}

export async function listTabs() {
  try {
    const result = await callTool('browser_tab_list', {});
    // Parse tab list from the text response
    let tabs = [];
    try {
      // The MCP might return structured text — try to parse it
      const lines = result.split('\n').filter(l => l.trim());
      tabs = lines.map((line, i) => ({ id: i, title: line.trim() }));
    } catch {
      tabs = [{ id: 0, title: result }];
    }
    return { ok: true, tabs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function newTab(url) {
  const result = await callTool('browser_tab_create', { url });
  return { ok: true, text: result };
}

export async function closeTab() {
  const result = await callTool('browser_tab_close', {});
  return { ok: true, text: result };
}

/**
 * Generic passthrough — call any Playwright MCP tool by name.
 * Used by the router for actions we haven't wrapped yet.
 */
export async function raw(toolName, args = {}, timeoutMs = 15000) {
  const result = await callTool(toolName, args, timeoutMs);
  return { ok: true, text: result };
}

export { start, stop };

// ── Page text ──────────────────────────────────────────────────
//
// browser_snapshot returns an accessibility tree: roles and refs, not prose.
// Fine for clicking, useless as evidence for a model. browser_evaluate runs in
// the page and hands back document.innerText, which is the actual readable text.
//
// Two gotchas, both measured:
//   1. browser_navigate returns before the page paints. Reading immediately gave
//      "Page Title: Loading ...&rdr=1" and nothing else. A wait is required.
//   2. Results arrive wrapped in Playwright's '### Result "..."' envelope with
//      the text JSON-escaped, so it has to be unwrapped and unescaped.

function extractEvalResult(raw) {
  let s = String(raw || '');
  const m = s.match(/### Result\s*([\s\S]*?)(?:\n### |$)/);
  if (m) s = m[1].trim();
  if (s.startsWith('"')) {
    try {
      s = JSON.parse(s);
    } catch {
      // Truncated or oddly escaped: unwrap by hand rather than lose the text.
      s = s.replace(/^"/, '').replace(/"$/, '')
           .replace(/\\n/g, '\n')
           .replace(/\\"/g, '"')
           .replace(/\\\\/g, '\\');
    }
  }
  return s;
}

/** Run a JS function in the live page and return its value as text. */
export async function evaluate(fn, timeoutMs = 15000) {
  const result = await callTool('browser_evaluate', { function: fn }, timeoutMs);
  return extractEvalResult(result);
}

/**
 * Fetch the human-readable text of a URL.
 * settleMs covers the redirect-and-paint gap that made bare navigate useless.
 */
export async function readUrl(url, { settleMs = 2000, maxChars = 4000 } = {}) {
  await callTool('browser_navigate', { url }, 20000);
  if (settleMs > 0) {
    await callTool('browser_wait_for', { time: Math.ceil(settleMs / 1000) }, 20000);
  }
  // body.innerText leads with nav chrome and site banners: a Wikipedia read
  // opened with 600 chars of fundraising appeal. Prefer the article region.
  const text = await evaluate('() => { const el = document.querySelector("main, article, #content, [role=main]"); return (el && el.innerText.length > 200) ? el.innerText : document.body.innerText; }');
  return String(text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
}

/**
 * Boot the browser ahead of time.
 *
 * Cold start is npx + cmd.exe + node + Chromium, measured at ~3s. Paying that
 * inside a voice turn is the difference between an answer and a dead pause, so
 * the hub calls this at startup. Never throws and never blocks the caller.
 */
export function warm() {
  if (isRunning()) return Promise.resolve(true);
  const t0 = Date.now();
  return start()
    .then(async (ok) => {
      if (!ok) {
        console.log(`[Playwright MCP] warm FAILED in ${Date.now() - t0}ms`);
        return false;
      }
      // Starting the server is not enough: it launches Chromium lazily, on the
      // first navigation. Do that here so no voice turn ever pays for it.
      try {
        await callTool('browser_navigate', { url: 'about:blank' }, 30000);
      } catch (e) {
        console.warn('[Playwright MCP] warm navigation failed:', e.message);
      }
      console.log(`[Playwright MCP] warm ready in ${Date.now() - t0}ms`);
      return true;
    })
    .catch((e) => {
      console.warn('[Playwright MCP] warm failed:', e.message);
      return false;
    });
}

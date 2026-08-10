// PAN Tool Scout — discovers new AI CLIs, tools, and integrations
//
// Monitors BetterStack, GitHub trending, and AI tool aggregators for new
// CLIs and tools that PAN can integrate. Runs daily, stores findings
// as memory items so PAN and the user stay on top of what's new.
//
// Philosophy: PAN is a compilation of the best tools available.
// All we do is take what they create and put it into PAN.

import { insert, all, get, run, getModelForPurpose, setModelForPurpose } from './db.js';
import { getSecret } from './secrets.js';
import { claude } from './claude.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Promisified async exec — replaces execSync to avoid blocking the event loop
// during the Start Menu / registry scan that fires on Craft startup. Each
// execSync call could take up to 10s; with 8 of them in sequence, Craft's
// event loop was frozen for up to 80s after boot, blowing every Carrier
// health probe and triggering an endless swap/rollback loop.
const execAsync = promisify(exec);

let timer = null;
let _startupIntervals_providerModels = null;
let _startupIntervals_deviceModels = null;

// Sources to monitor
const SOURCES = [
  {
    name: 'GitHub Trending',
    url: 'https://github.com/trending?since=weekly&spoken_language_code=en',
    type: 'github',
  },
  {
    name: 'Awesome MCP Servers',
    url: 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md',
    type: 'github_raw',
  },
  {
    name: 'Awesome AI Agents',
    url: 'https://raw.githubusercontent.com/e2b-dev/awesome-ai-agents/main/README.md',
    type: 'github_raw',
  },
  {
    name: 'Awesome CLI Tools',
    url: 'https://raw.githubusercontent.com/agarrharr/awesome-cli-apps/master/readme.md',
    type: 'github_raw',
  },
];

// Ensure tables exist
try {
  run(`CREATE TABLE IF NOT EXISTS local_apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    url TEXT NOT NULL,
    exe_found TEXT,
    installed INTEGER DEFAULT 0,
    browser_only INTEGER DEFAULT 0,
    icon TEXT,
    module_id TEXT,
    last_scanned TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(id)
  )`);
  run(`CREATE INDEX IF NOT EXISTS idx_local_apps_category ON local_apps(category)`);
  run(`CREATE INDEX IF NOT EXISTS idx_local_apps_installed ON local_apps(installed)`);
} catch {}

try {
  run(`CREATE TABLE IF NOT EXISTS scout_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    description TEXT NOT NULL,
    url TEXT,
    relevance TEXT,
    relevance_score REAL DEFAULT 0.0,
    category TEXT,
    status TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(tool_name, source)
  )`);
  run(`CREATE INDEX IF NOT EXISTS idx_scout_status ON scout_findings(status)`);
  run(`CREATE INDEX IF NOT EXISTS idx_scout_score ON scout_findings(relevance_score DESC)`);
} catch {}

// provider_models — live source of truth for which model IDs each LLM
// provider currently serves. Populated by scanProviderModels() which hits
// the OpenAI-compatible /v1/models endpoint of each configured provider.
// llm.js consults this table to short-circuit dead-model calls (e.g. when
// Cerebras retires qwen-3-235b-a22b-instruct-2507) before paying the full
// HTTP round-trip on every Intuition / Orchestrator / Dream cycle.
try {
  run(`CREATE TABLE IF NOT EXISTS provider_models (
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    metadata TEXT,
    first_seen TEXT DEFAULT (datetime('now','localtime')),
    last_seen TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (provider, model_id)
  )`);
  run(`CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(provider)`);
} catch {}

// device_models — same idea but for LOCAL inference servers running on
// devices enrolled via pan-client. Mostly Ollama right now (port 11434)
// but the schema is provider-tagged so we can add LM Studio etc. later.
//
// Why a table and not hardcoded constants in embeddings.js / llm.js:
//  - The user controls what's actually installed on each device. PAN
//    learns it by probing /api/tags, not by guessing.
//  - When the user runs `ollama pull <model>` on the the local Ollama box, the next
//    Scout sweep picks it up — code doesn't need to be redeployed.
//  - findDeviceWithModel(name) lets callers ask "who has *this exact
//    model name*?" which is critical for embeddings (1024-dim qwen3-
//    embedding:0.6b output cannot be silently substituted with a 2560-
//    dim variant — the dimensions are wedded to the existing
//    event_embeddings rows on disk).
try {
  run(`CREATE TABLE IF NOT EXISTS device_models (
    device_hostname TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'ollama',
    model_name TEXT NOT NULL,
    size_bytes INTEGER,
    metadata TEXT,
    first_seen TEXT DEFAULT (datetime('now','localtime')),
    last_seen TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (device_hostname, provider, model_name)
  )`);
  run(`CREATE INDEX IF NOT EXISTS idx_device_models_model ON device_models(model_name)`);
  run(`CREATE INDEX IF NOT EXISTS idx_device_models_device ON device_models(device_hostname)`);
} catch {}

// Fetch a URL with timeout
async function fetchUrl(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'PAN-Scout/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Extract text content from HTML (simple strip)
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000); // Keep under token limits
}

// Ask Claude to find relevant tools from page content
async function analyzeSource(source, content) {
  // Get ALL existing findings grouped by category for smart deduplication
  const existingTools = all(`SELECT tool_name, category FROM scout_findings ORDER BY created_at DESC`);
  const known = existingTools.map(t => t.tool_name);
  const knownByCategory = {};
  for (const t of existingTools) {
    const cat = t.category || 'other';
    if (!knownByCategory[cat]) knownByCategory[cat] = [];
    knownByCategory[cat].push(t.tool_name);
  }
  const categoryReport = Object.entries(knownByCategory)
    .map(([cat, tools]) => `${cat}: ${tools.length} tools (${tools.slice(0, 5).join(', ')}${tools.length > 5 ? '...' : ''})`)
    .join('\n');

  // Get project tech stacks for context
  const stacks = all("SELECT value FROM settings WHERE key LIKE 'stack_%'");
  let stackSummary = '';
  for (const row of stacks) {
    try {
      const s = JSON.parse(row.value);
      stackSummary += `${s.project_name}: ${(s.runtimes || []).join(', ')} + ${(s.frameworks || []).join(', ')}\n`;
    } catch {}
  }

  const prompt = `You are PAN's Tool Scout. PAN is a personal AI operating system with: Android app, Node.js server, web dashboard, Whisper STT, Piper TTS, llama.cpp, pyautogui automation, terminal multiplexing, FTS5 search, and an ESP32 hardware pendant (in development).

Project tech stacks:
${stackSummary || 'Not scanned yet'}

ALREADY DISCOVERED (DO NOT repeat these — find NEW tools in DIFFERENT categories):
${categoryReport || 'Nothing yet'}

Total known tools: ${known.length}. We have too many in these categories already: ${Object.entries(knownByCategory).filter(([,v]) => v.length > 5).map(([k,v]) => `${k}(${v.length})`).join(', ') || 'none'}.

PRIORITIZE finding tools in categories we're MISSING or UNDERREPRESENTED in:
- Hardware/IoT/ESP32 tools
- Database/search tools
- Security/auth tools
- Deployment/packaging tools
- Voice/TTS/STT tools (beyond what we have)
- Communication tools (Slack, Discord, email CLIs)
- Calendar/productivity integrations

From this ${source.name} content, find tools PAN doesn't already know about:
${content.slice(0, 6000)}

Return a JSON array. Each finding:
{"name": "tool name", "description": "what it does (1-2 sentences)", "url": "project URL if found", "relevance": "why PAN should care (1 sentence)", "score": 0.0-1.0, "category": "cli|mcp|voice|agent|automation|hardware|security|database|deploy|communication|other"}

Return MAX 5 most relevant NEW findings. Skip anything similar to already-discovered tools. If nothing new, return []. Only return the JSON array.`;

  try {
    const raw = await claude(prompt, { timeout: 30000, maxTokens: 2000, caller: 'scout' });
    // Extract JSON array from response — handle text before/after
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]);
  } catch (e) {
    console.error(`[PAN Scout] Analysis error for ${source.name}:`, e.message);
    return [];
  }
}

// Main scout run
async function scout() {
  console.log('[PAN Scout] Starting tool discovery scan...');
  let totalNew = 0;

  for (const source of SOURCES) {
    try {
      console.log(`[PAN Scout] Checking ${source.name}...`);
      const html = await fetchUrl(source.url);
      const text = stripHtml(html);

      if (text.length < 100) {
        console.log(`[PAN Scout] ${source.name}: not enough content, skipping`);
        continue;
      }

      const findings = await analyzeSource(source, text);

      if (!Array.isArray(findings)) continue;

      for (const f of findings) {
        if (!f.name || !f.description) continue;

        try {
          insert(`INSERT OR IGNORE INTO scout_findings (source, tool_name, description, url, relevance, relevance_score, category)
            VALUES (:src, :name, :desc, :url, :rel, :score, :cat)`, {
            ':src': source.name,
            ':name': f.name,
            ':desc': f.description,
            ':url': f.url || null,
            ':rel': f.relevance || '',
            ':score': f.score || 0.5,
            ':cat': f.category || 'other',
          });
          totalNew++;
        } catch {
          // UNIQUE constraint = already known, skip
        }
      }

      console.log(`[PAN Scout] ${source.name}: found ${findings.length} tools`);
    } catch (e) {
      console.error(`[PAN Scout] Error fetching ${source.name}:`, e.message);
    }
  }

  // Phase 2: Search a2asearch-mcp per project + custom topics
  try {
    const configRow = get("SELECT value FROM settings WHERE key = 'autodev_config'");
    const config = configRow ? JSON.parse(configRow.value) : {};
    const customTopics = config.scout_topics || [];

    // Build per-project search queries from tech stacks
    const stackRows = all("SELECT key, value FROM settings WHERE key LIKE 'stack_%'");
    const projectSearches = []; // { project, topic }

    for (const row of stackRows) {
      try {
        const stack = JSON.parse(row.value);
        const proj = stack.project_name || 'Unknown';
        // Generate search terms from project's tech stack
        if (stack.runtimes) {
          for (const r of stack.runtimes) projectSearches.push({ project: proj, topic: `${r} MCP` });
        }
        if (stack.frameworks) {
          for (const f of stack.frameworks) projectSearches.push({ project: proj, topic: `${f} tools` });
        }
        // Add language-specific searches for dominant languages
        const topLangs = Object.entries(stack.languages || {}).sort((a, b) => b[1] - a[1]).slice(0, 2);
        for (const [lang] of topLangs) {
          projectSearches.push({ project: proj, topic: `${lang} automation` });
        }
      } catch {}
    }

    // Add custom topics (global, not project-specific)
    for (const t of customTopics) {
      projectSearches.push({ project: 'All', topic: t });
    }

    // Deduplicate by topic
    const seen = new Set();
    const uniqueSearches = projectSearches.filter(s => {
      if (seen.has(s.topic)) return false;
      seen.add(s.topic);
      return true;
    }).slice(0, 15);

    if (uniqueSearches.length > 0) {
      console.log(`[PAN Scout] Searching a2asearch for ${uniqueSearches.length} topics across projects`);
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(execFile);

      for (const search of uniqueSearches) {
        try {
          const { stdout } = await execAsync('npx', ['a2asearch', search.topic, '--json'], { timeout: 15000, shell: true, windowsHide: true });
          if (!stdout.trim()) continue;

          let results = [];
          try { results = JSON.parse(stdout); } catch {
            const lines = stdout.split('\n');
            for (const line of lines) {
              const match = line.match(/^\d+\.\s+(.+)/);
              if (match) results.push({ name: match[1].trim(), description: '', url: '' });
            }
          }

          for (const r of (Array.isArray(results) ? results : []).slice(0, 3)) {
            const toolName = r.name || r.title || '';
            if (!toolName || known.includes(toolName)) continue; // skip already known
            try {
              insert(`INSERT OR IGNORE INTO scout_findings (source, tool_name, description, url, relevance, relevance_score, category)
                VALUES (:src, :name, :desc, :url, :rel, :score, :cat)`, {
                ':src': `a2asearch [${search.project}]: ${search.topic}`,
                ':name': toolName,
                ':desc': (r.description || '').slice(0, 300),
                ':url': r.url || r.link || null,
                ':rel': `For ${search.project} — found via "${search.topic}"`,
                ':score': 0.7,
                ':cat': r.type?.toLowerCase().includes('mcp') ? 'mcp' : r.type?.toLowerCase().includes('agent') ? 'agent' : 'cli',
              });
              totalNew++;
            } catch {}
          }
          if (results.length > 0) console.log(`[PAN Scout] a2asearch "${search.topic}" [${search.project}]: ${results.length} results`);
        } catch {}
      }
    }
  } catch (e) {
    console.error('[PAN Scout] a2asearch error:', e.message);
  }

  console.log(`[PAN Scout] Scan complete. ${totalNew} new findings stored.`);
  return totalNew;
}

// Get top findings for display
function getFindings({ status = 'new', limit = 20 } = {}) {
  return all(`SELECT * FROM scout_findings
    WHERE status = :status
    ORDER BY relevance_score DESC, created_at DESC
    LIMIT :limit`, {
    ':status': status,
    ':limit': limit,
  });
}

// Mark a finding as reviewed/integrated/dismissed
function updateFinding(id, status) {
  run(`UPDATE scout_findings SET status = :status WHERE id = :id`, {
    ':id': id,
    ':status': status,
  });
}

function startScout(intervalMs = 24 * 60 * 60 * 1000) {
  // Scan local apps immediately on startup (fast, no AI needed)
  setTimeout(async () => {
    try {
      const matched = await scanLocalApps();
      console.log(`[PAN Scout] Initial local scan: ${matched} apps discovered`);
    } catch (e) {
      console.error('[PAN Scout] Local scan failed:', e.message);
    }
  }, 5000);

  // Refresh provider model lists (Cerebras, Groq) — single source of truth
  // for llm.js to validate model IDs against. Delayed 12s so we run well
  // after Craft is healthy on Carrier's perf probes, then a 6h interval
  // catches any model rename/retirement.
  setTimeout(async () => {
    try {
      const summary = await scanProviderModels();
      const parts = Object.entries(summary).map(([p, r]) => r.ok ? `${p}=${r.count}` : `${p}=fail(${r.reason})`);
      console.log(`[PAN Scout] Provider model scan: ${parts.join(' ')}`);
    } catch (e) {
      console.error('[PAN Scout] Provider model scan failed:', e.message);
    }
  }, 12000);
  _startupIntervals_providerModels = setInterval(() => {
    scanProviderModels().catch(e => console.warn('[PAN Scout] Provider refresh failed:', e.message));
  }, 6 * 60 * 60 * 1000);

  // Refresh local device model registry — discovers which models each
  // enrolled device has installed on its local Ollama. embeddings.js +
  // llm.js use findDeviceWithModel() instead of hardcoding names. Same
  // 12s startup delay + 6h refresh as the cloud-provider scan; also
  // re-triggered ad-hoc when client-manager.handleHeartbeat sees an
  // ollama service-status change in a device's heartbeat.
  setTimeout(async () => {
    try {
      const summary = await scanDeviceModels();
      const parts = Object.entries(summary).map(([h, r]) => r.ok ? `${h}=${r.count}` : `${h}=fail(${r.reason})`);
      console.log(`[PAN Scout] Device model scan: ${parts.join(' ') || '(no devices report ollama)'}`);
    } catch (e) {
      console.error('[PAN Scout] Device model scan failed:', e.message);
    }
  }, 12000);
  _startupIntervals_deviceModels = setInterval(() => {
    scanDeviceModels().catch(e => console.warn('[PAN Scout] Device model refresh failed:', e.message));
  }, 6 * 60 * 60 * 1000);

  const runRemote = async () => {
    try {
      // Re-scan local apps too (picks up new installs)
      await scanLocalApps();
      await scout();
      const { reportServiceRun, getAtlasSummary } = await import('./steward.js');
      reportServiceRun('scout');

      // Update System State section in MEMORY.md
      try {
        const { readFileSync, writeFileSync } = await import('fs');
        const summary = await getAtlasSummary();
        const memPath = '%USERPROFILE%\\.claude\\projects\\C--Users-owner-Desktop-PAN\\memory\\MEMORY.md';
        let content = '';
        try { content = readFileSync(memPath, 'utf8'); } catch { content = ''; }
        const section = `## System State\n\`\`\`\n${summary}\n\`\`\`\n`;
        if (content.includes('## System State')) {
          // Replace everything from ## System State up to the next ## heading (or end of file)
          content = content.replace(/## System State[\s\S]*?(?=\n## |\n*$)/, section.trimEnd());
        } else {
          content = content.trimEnd() + '\n\n' + section;
        }
        writeFileSync(memPath, content, 'utf8');
        console.log('[PAN Scout] MEMORY.md System State updated');
      } catch (e) {
        console.error('[PAN Scout] Atlas MEMORY.md update failed:', e.message);
      }
    } catch (err) {
      try { const { reportServiceRun } = await import('./steward.js'); reportServiceRun('scout', err.message); } catch {}
      console.error('[PAN Scout]', err.message);
    }
  };
  // INTENTIONALLY no `setTimeout(runRemote, 30000)` here.
  //
  // Previously the Web scout (4 GitHub source fetches + 15 sequential
  // `npx a2asearch` spawns @ 15s timeout each = up to 225s of heavy work)
  // fired 30 seconds after EVERY Craft startup. With auto-rollback + sleep-
  // wake swaps + manual swaps during dev, this meant Scout was permanently
  // hammering the event loop and the npx process pool, contributing to the
  // CPU runaway that wedged Craft.
  //
  // scanLocalApps already runs at the 5s mark above — that's the part that
  // matters for the dashboard's Apps widget. The Web scout phase (which
  // discovers brand-new third-party tools) is a discovery convenience, not
  // a UX-critical path, so the 24-hour interval is plenty.
  timer = setInterval(runRemote, intervalMs);
  console.log(`[PAN Scout] Web scout scheduled every ${Math.round(intervalMs / 3600000)}h (no on-startup run)`);
}

function stopScout() {
  if (timer) clearInterval(timer);
  timer = null;
  if (_startupIntervals_providerModels) clearInterval(_startupIntervals_providerModels);
  _startupIntervals_providerModels = null;
  if (_startupIntervals_deviceModels) clearInterval(_startupIntervals_deviceModels);
  _startupIntervals_deviceModels = null;
}

// ─── Local App Discovery ───────────────────────────────────────────
// Scans Windows for installed applications that have web equivalents.
// Matches against known-web-apps.json registry.
// Results stored in local_apps table and served via /api/v1/wrap/services.

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadKnownApps() {
  try {
    const raw = readFileSync(join(__dirname, 'modules', 'known-web-apps.json'), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[PAN Scout] Failed to load known-web-apps.json:', e.message);
    return { apps: [], categories: {} };
  }
}

// Scan Windows Start Menu and registry for installed apps.
//
// MUST be async + use execAsync — see import block. Old execSync version
// blocked the event loop for up to 80s on startup and was the root cause
// of the never-ending Craft swap/rollback loop (every health probe failed
// during the freeze). Running these 8 commands in parallel via Promise.all
// is also much faster wall-clock: ~3-5s total instead of summing.
async function scanInstalledApps() {
  const found = new Set();
  const paths = [
    process.env.APPDATA ? join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : null,
    process.env.PROGRAMFILES || 'C:\\Program Files',
    process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
  ].filter(Boolean);

  const regPaths = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];

  // Fan out all 8 child-process scans in parallel. Each one yields to the
  // event loop while its child process runs — health probes can answer
  // normally throughout the scan window.
  const dirJobs = paths.map(dir =>
    execAsync(`dir /s /b "${dir}" 2>nul`, {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }).then(({ stdout }) => ({ kind: 'dir', stdout }))
      .catch(() => ({ kind: 'dir', stdout: '' }))
  );

  const regJobs = regPaths.map(regPath =>
    execAsync(`reg query "${regPath}" /s /v DisplayName 2>nul`, {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }).then(({ stdout }) => ({ kind: 'reg', stdout }))
      .catch(() => ({ kind: 'reg', stdout: '' }))
  );

  const results = await Promise.all([...dirJobs, ...regJobs]);

  for (const r of results) {
    if (r.kind === 'dir') {
      for (const line of r.stdout.split('\n')) {
        const name = line.trim().split('\\').pop()?.replace(/\.lnk$/i, '').replace(/\.exe$/i, '');
        if (name) found.add(name);
      }
    } else {
      for (const line of r.stdout.split('\n')) {
        const match = line.match(/DisplayName\s+REG_SZ\s+(.+)/i);
        if (match) found.add(match[1].trim());
      }
    }
  }

  return found;
}

// Match installed apps against known web apps registry
async function scanLocalApps() {
  const platform = process.platform;
  if (platform !== 'win32') {
    console.log('[PAN Scout] Local app scan only supported on Windows currently');
    return 0;
  }

  console.log('[PAN Scout] Scanning for installed applications...');
  const known = loadKnownApps();
  // scanInstalledApps is now async — without await, we'd get back a Promise
  // and "installed.size" would be undefined, matching zero apps. The async
  // change exists so the 8 child-process scans yield to the event loop
  // (health probes keep answering) instead of blocking for up to 80s.
  const installed = await scanInstalledApps();
  console.log(`[PAN Scout] Found ${installed.size} installed programs, matching against ${known.apps.length} known web apps...`);

  let matched = 0;

  for (const app of known.apps) {
    // Check if any of the app's known names appear in installed programs
    const isInstalled = app.names.some(name =>
      [...installed].some(prog =>
        prog.toLowerCase().includes(name.toLowerCase())
      )
    );

    // Find which exe was matched (if any)
    let exeFound = null;
    if (!app.browser_only) {
      for (const name of app.names) {
        const match = [...installed].find(prog => prog.toLowerCase().includes(name.toLowerCase()));
        if (match) { exeFound = match; break; }
      }
    }

    try {
      run(`INSERT INTO local_apps (id, name, category, url, exe_found, installed, browser_only, icon, last_scanned)
           VALUES (:id, :name, :cat, :url, :exe, :installed, :browser, :icon, datetime('now','localtime'))
           ON CONFLICT(id) DO UPDATE SET
             exe_found = :exe,
             installed = :installed,
             last_scanned = datetime('now','localtime')`, {
        ':id': app.id,
        ':name': app.title,
        ':cat': app.category,
        ':url': app.url,
        ':exe': exeFound || null,
        ':installed': isInstalled ? 1 : 0,
        ':browser': app.browser_only ? 1 : 0,
        ':icon': app.icon || null,
      });
      if (isInstalled) matched++;
    } catch (e) {
      console.error(`[PAN Scout] Failed to store ${app.id}:`, e.message);
    }
  }

  console.log(`[PAN Scout] Local scan complete. ${matched} apps matched out of ${known.apps.length} known.`);
  return matched;
}

// ── Provider model discovery ─────────────────────────────────────────────────
// Cerebras and Groq both expose OpenAI-compatible /v1/models endpoints. We
// fetch the live list per provider and store the model IDs in
// provider_models. llm.js uses getKnownProviderModels(provider) to short-circuit
// calls to retired models (e.g. when Cerebras renames qwen-3-235b-a22b-instruct-2507).
//
// Returns counts by provider. Failures per-provider are isolated — a Groq
// key with no Cerebras key still scans Groq cleanly.

const PROVIDER_ENDPOINTS = {
  cerebras: 'https://api.cerebras.ai/v1/models',
  groq:     'https://api.groq.com/openai/v1/models',
  gemini:   'https://generativelanguage.googleapis.com/v1beta/models',
};

// Gemini differs from the OpenAI-compatible providers in both auth and shape:
// key goes in the query string, and it answers { models: [{ name: "models/x",
// supportedGenerationMethods: [...] }] } instead of { data: [{ id }] }.
// Keeping the difference here means _fetchProviderModels stays uniform.
//
// Gemini was missing entirely until 2026-08-09, which mattered once voice moved
// onto it: Scout could not have noticed a retired Gemini model, and Gemini does
// retire them — gemini-2.5-flash 404'd the same day gemini-3.5-flash-lite worked.
const PROVIDER_STYLE = {
  gemini: {
    url:     (base, key) => `${base}?key=${encodeURIComponent(key)}`,
    headers: () => ({}),
    parse:   (body) => (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: String(m.name).replace(/^models\//, '') })),
  },
};

const DEFAULT_PROVIDER_STYLE = {
  url:     (base) => base,
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
  parse:   (body) => (Array.isArray(body.data) ? body.data : []),
};

async function _fetchProviderModels(provider, apiKey, timeoutMs = 8000) {
  const base = PROVIDER_ENDPOINTS[provider];
  if (!base) throw new Error(`Unknown provider: ${provider}`);
  const style = PROVIDER_STYLE[provider] || DEFAULT_PROVIDER_STYLE;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(style.url(base, apiKey), {
      headers: style.headers(apiKey),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 402 = billing tier exhausted, 401/403 = key rejected. These are NOT
      // transient, and they are exactly how Cerebras failed on 2026-08-09:
      // /v1/models still answered, so "is the model listed" said healthy while
      // every completion returned 402. Tag them so the caller can distinguish
      // "provider is unusable" from "network blip".
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.unusable = res.status === 401 || res.status === 402 || res.status === 403;
      throw err;
    }
    return style.parse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

// Canary: actually ASK the provider for one token.
//
// Listing the catalogue is not proof of service. On 2026-08-09 Cerebras's
// /v1/models returned 200 with three models while /chat/completions returned
// 402 for every one of them — so "is the model listed?" reported healthy while
// voice was completely dead. The only reliable liveness test is a real
// completion. One tiny request per provider per scan (6h) is cheap.
//
// Returns { ok } on success, or { ok: false, status, unusable } where unusable
// means the provider refused us outright rather than glitched.
const PROVIDER_COMPLETION = {
  cerebras: {
    url:  () => 'https://api.cerebras.ai/v1/chat/completions',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: (m) => JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
  },
  groq: {
    url:  () => 'https://api.groq.com/openai/v1/chat/completions',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: (m) => JSON.stringify({ model: m, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
  },
  gemini: {
    url:  (k, m) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(k)}`,
    headers: () => ({ 'Content-Type': 'application/json' }),
    body: () => JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
  },
};

async function _probeProviderServes(provider, apiKey, model, timeoutMs = 12000) {
  const spec = PROVIDER_COMPLETION[provider];
  if (!spec || !model) return { ok: true, skipped: true };   // unknown shape — don't false-alarm
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(spec.url(apiKey, model), {
      method: 'POST',
      headers: spec.headers(apiKey),
      body: spec.body(model),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    return {
      ok: false,
      status: res.status,
      // 429 is rate limiting — transient, NOT a reason to abandon the provider.
      unusable: res.status === 401 || res.status === 402 || res.status === 403,
    };
  } catch {
    return { ok: false, status: 0, unusable: false };  // network blip
  } finally {
    clearTimeout(timer);
  }
}

function _getProviderApiKey(provider) {
  // Was a raw `SELECT value FROM settings`, which silently stopped working on
  // 2026-08-09 when the keys were moved out of the database into PAN_* env
  // vars for security. Scout then reported no_api_key for every provider and
  // could not detect a retired model at all — the exact failure it exists to
  // catch. getSecret() resolves env first, database second, so both layouts
  // work. secrets.js only imports db.js, so this adds no circular dependency.
  const keyMap = {
    cerebras: 'cerebras_api_key',
    groq:     'groq_api_key',
    gemini:   'gemini_api_key',
  };
  const settingKey = keyMap[provider];
  if (!settingKey) return null;
  try {
    return getSecret(settingKey);
  } catch {
    return null;
  }
}

async function scanProviderModels() {
  const summary = {};
  for (const provider of Object.keys(PROVIDER_ENDPOINTS)) {
    const apiKey = _getProviderApiKey(provider);
    if (!apiKey) {
      summary[provider] = { ok: false, reason: 'no_api_key' };
      continue;
    }
    try {
      const models = await _fetchProviderModels(provider, apiKey);
      if (models.length === 0) {
        summary[provider] = { ok: false, reason: 'empty_response' };
        continue;
      }
      // Upsert each model. We DON'T delete missing rows immediately —
      // a transient network blip shouldn't make llm.js think every
      // model retired. Stale rows age out via last_seen during the
      // 6-hour refresh cycle and the dashboard can show "last seen X
      // days ago" if needed.
      let stored = 0;
      for (const m of models) {
        if (!m?.id) continue;
        try {
          run(`INSERT INTO provider_models (provider, model_id, metadata, first_seen, last_seen)
               VALUES (:p, :id, :meta, datetime('now','localtime'), datetime('now','localtime'))
               ON CONFLICT(provider, model_id) DO UPDATE SET
                 metadata = :meta,
                 last_seen = datetime('now','localtime')`,
            { ':p': provider, ':id': m.id, ':meta': JSON.stringify(m) });
          stored++;
        } catch {}
      }
      // Catalogue fetched — now prove it will actually SERVE one. See
      // _probeProviderServes: listing is not serving, and that difference is
      // exactly what hid the Cerebras outage.
      const probeModel = (REASONING_CLOUD_PREFERRED[provider] || []).find((m) => models.some((x) => x.id === m))
        || models[0]?.id;
      const probe = await _probeProviderServes(provider, apiKey, probeModel);
      if (probe.unusable) {
        _unusableProviders.add(provider);
        summary[provider] = { ok: false, count: stored, reason: `lists ${stored} models but completions return HTTP ${probe.status}`, unusable: true };
        console.error(`[PAN Scout] Provider ${provider} UNUSABLE: /models lists ${stored} models but a 1-token completion returned HTTP ${probe.status} (tier exhausted or key rejected).`);
      } else {
        _unusableProviders.delete(provider);
        summary[provider] = { ok: true, count: stored, served: probe.ok };
        console.log(`[PAN Scout] Provider ${provider}: ${stored} models discovered${probe.ok ? ', completion probe OK' : ''}`);
      }
    } catch (e) {
      // 401/402/403 means the provider will refuse completions no matter what
      // its catalogue says. Latch it so checkReasoningCloudHealth stops
      // trusting the cached model list and fails over to another provider.
      if (e.unusable) {
        _unusableProviders.add(provider);
        summary[provider] = { ok: false, reason: e.message, unusable: true };
        console.error(`[PAN Scout] Provider ${provider} UNUSABLE (${e.message}) — key rejected or tier exhausted.`);
      } else {
        summary[provider] = { ok: false, reason: e.message };
        console.warn(`[PAN Scout] Provider ${provider} scan failed: ${e.message}`);
      }
    }
  }
  // We just refreshed the live model lists — this is the one moment we KNOW
  // whether the configured voice model still exists. Piggyback the health
  // check here (no extra API calls, no new polling loop). Isolated so a check
  // failure never affects the scan result the callers depend on.
  try { await checkReasoningCloudHealth(); }
  catch (e) { console.warn('[PAN Scout] reasoning_cloud health check failed:', e.message); }
  return summary;
}

// ── Voice / reasoning-cloud model health ─────────────────────────────────────
// The voice path resolves its model from model_selections.reasoning_cloud. If
// that model gets retired by the provider (e.g. Cerebras dropped qwen-3-235b on
// 2026-05-27) it 404s on EVERY voice prompt — and nothing noticed before this
// check existed, because Steward only supervises processes, not cloud-model
// health. So: compare the configured reasoning_cloud model against the
// freshly-scanned live list and, if it's gone, raise a DEGRADED alert and
// self-heal to a live model.
//
// Replacement preference — all confirmed live on Cerebras free tier as of
// 2026-07: gpt-oss-120b (the current voice default), then zai-glm-4.7, then
// gemma-4-31b. Falls back to any live model if none of those are present.
// Replacement preference PER PROVIDER. This used to be a single Cerebras-only
// list, which broke the moment reasoning_cloud moved to Gemini: a retired
// Gemini model would have been "healed" by writing a Cerebras model id that
// does not exist there. Ordered best-first; falls back to any live model.
const REASONING_CLOUD_PREFERRED = {
  cerebras: ['gpt-oss-120b', 'zai-glm-4.7', 'gemma-4-31b'],
  groq:     ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gpt-oss-20b'],
  gemini:   ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-2.0-flash-lite'],
};

// Providers whose LAST scan returned 401/402/403 — key rejected or tier
// exhausted. Distinct from "scan failed": those are permanent-ish and mean the
// provider cannot serve, no matter what its /models endpoint lists.
const _unusableProviders = new Set();

let _lastReasoningCloudAlertModel = null; // de-dupe: don't re-alert the same retired model on every scan

async function checkReasoningCloudHealth() {
  let sel;
  try { sel = getModelForPurpose('reasoning_cloud'); } catch { return; }
  if (!sel || !sel.provider || !sel.model) return;

  // Only providers we actually scan have a trustworthy live list. Strip any
  // "@device" suffix (cloud providers don't use it, but be defensive).
  const provider = String(sel.provider).split('@')[0];
  if (!PROVIDER_ENDPOINTS[provider]) return;

  // THE 2026-08-09 CASE: Cerebras kept listing gpt-oss-120b on /v1/models while
  // returning 402 for every completion. Membership in the cached list therefore
  // said "healthy" while every real call failed. A provider that answered
  // 401/402/403 cannot serve anything, so treat its whole catalogue as dead
  // rather than trusting a list we may have cached before billing changed.
  if (_unusableProviders.has(provider)) {
    console.error(`[PAN Scout] DEGRADED: provider "${provider}" rejected us (401/402/403) — its model list is stale, every completion will fail.`);
    const alt = Object.keys(PROVIDER_ENDPOINTS).find((p) => {
      if (p === provider || _unusableProviders.has(p)) return false;
      const m = getKnownProviderModels(p);
      return m && m.size > 0;
    });
    if (alt) {
      const altLive = getKnownProviderModels(alt);
      const pick = (REASONING_CLOUD_PREFERRED[alt] || []).find((m) => altLive.has(m))
        || [...altLive].sort()[0];
      if (pick && setModelForPurpose('reasoning_cloud', alt, pick, {
        notes: `Auto-switched by Scout: ${provider} returned 401/402/403 on ${new Date().toISOString().slice(0, 10)} (tier exhausted or key rejected)`,
      })) {
        console.log(`[PAN Scout] Self-heal: reasoning_cloud ${provider}:${sel.model} → ${alt}:${pick} (provider failover)`);
      }
    } else {
      console.error('[PAN Scout] No usable cloud provider left — reasoning_cloud will fall through to local.');
    }
    return;
  }

  const live = getKnownProviderModels(provider);
  if (!live) return;             // never scanned / empty response — no info, don't false-alarm
  if (live.has(sel.model)) {     // healthy — clear any prior de-dupe latch
    _lastReasoningCloudAlertModel = null;
    return;
  }

  // Configured voice model is NOT in the live list → retired / 404.
  const retired = sel.model;
  console.error(`[PAN Scout] DEGRADED: reasoning_cloud model "${provider}:${retired}" is not in ${provider}'s live model list — voice path will 404 until switched.`);

  // Pick a live replacement, preferring gpt-oss-120b.
  let replacement = (REASONING_CLOUD_PREFERRED[provider] || []).find(m => live.has(m));
  if (!replacement) replacement = [...live].sort()[0] || null; // deterministic last resort

  // Self-heal via the existing helper (idempotent: current model isn't live,
  // so replacement is always different from it).
  let switched = false;
  if (replacement && replacement !== retired) {
    switched = setModelForPurpose('reasoning_cloud', provider, replacement, {
      notes: `Auto-switched by Scout: "${retired}" left ${provider}'s live model list on ${new Date().toISOString().slice(0, 10)}`,
    });
    if (switched) console.log(`[PAN Scout] Self-heal: reasoning_cloud ${provider}:${retired} → ${provider}:${replacement}`);
    else console.warn(`[PAN Scout] Self-heal FAILED: could not switch reasoning_cloud off retired ${provider}:${retired}`);
  }

  // Raise a DEGRADED alert (de-duped per retired model so we don't spam the
  // panel on every 6h scan while it sits in a bad state).
  if (_lastReasoningCloudAlertModel !== retired) {
    _lastReasoningCloudAlertModel = retired;
    try {
      // Lazy import: routes/dashboard.js imports scout.js, so a top-level
      // import here would be a circular dependency. This runs long after boot.
      const { createAlert } = await import('./routes/dashboard.js');
      createAlert({
        alert_type: 'ai_backend_degraded',
        severity: switched ? 'warning' : 'critical',
        title: switched
          ? `Voice model retired — auto-switched to ${provider}:${replacement}`
          : `Voice model ${provider}:${retired} retired — no live replacement`,
        detail: switched
          ? `reasoning_cloud pointed at "${provider}:${retired}", which is no longer in ${provider}'s live model list. Scout auto-switched it to "${provider}:${replacement}".`
          : `reasoning_cloud is "${provider}:${retired}", which is no longer in ${provider}'s live model list, and no live replacement was found among ${REASONING_CLOUD_PREFERRED.join(', ')}. Voice/reasoning will keep failing until this is fixed.`,
      });
    } catch (e) {
      console.warn('[PAN Scout] Could not raise ai_backend_degraded alert:', e.message);
    }
  }
}

// Cached read for llm.js callers — synchronous since better-sqlite3 is sync.
// Returns Set<string> of model IDs the provider currently serves, or null
// if the table is empty (never scanned). llm.js treats null as "trust the
// caller, no info yet" (don't block first calls before scout runs).
function getKnownProviderModels(provider) {
  try {
    const rows = all(`SELECT model_id FROM provider_models WHERE provider = :p`, { ':p': provider });
    if (rows.length === 0) return null;
    return new Set(rows.map(r => r.model_id));
  } catch {
    return null;
  }
}

// ── Local-device model discovery (Ollama / LM Studio / etc.) ─────────────────
// Probes every enrolled device whose reported_services advertises a local
// inference server, lists its currently-installed models via /api/tags,
// and upserts into device_models. embeddings.js / llm.js consult the result
// via findDeviceWithModel(name) instead of hardcoding model IDs that might
// not be installed on the user's actual hardware.

const _LOCAL_INFERENCE_DEFAULT_PORT = 11434; // Ollama default

async function scanDeviceModels() {
  // Find every device that ever reported ollama. We don't filter by recency
  // because we want to KNOW which devices have ollama configured even when
  // they're temporarily offline — getOllamaUrl uses the same permissive
  // logic. Unreachable devices just get { ok: false, reason: ... } in the
  // summary and their device_models rows stay stale until next contact.
  const devices = all(`
    SELECT hostname, tailscale_ip, tailscale_hostname, reported_services
    FROM devices
    WHERE reported_services IS NOT NULL
  `);

  const summary = {};
  for (const d of devices) {
    let svcs;
    try { svcs = JSON.parse(d.reported_services); } catch { continue; }
    if (!Array.isArray(svcs)) continue;
    const ollamaSvc = svcs.find(s => s.name === 'ollama');
    if (!ollamaSvc) continue;

    // Address column priority is the same as getOllamaUrl — see db.js for
    // the rationale on why tailscale_hostname often contains the actual IP.
    const host = d.tailscale_ip || d.tailscale_hostname || d.hostname;
    if (!host) {
      summary[d.hostname] = { ok: false, reason: 'no_address' };
      continue;
    }
    const port = Number(ollamaSvc.port) || _LOCAL_INFERENCE_DEFAULT_PORT;
    const url = `http://${host}:${port}`;

    try {
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        summary[d.hostname] = { ok: false, reason: `HTTP ${res.status}`, url };
        continue;
      }
      const data = await res.json();
      const models = Array.isArray(data?.models) ? data.models : [];

      let stored = 0;
      for (const m of models) {
        if (!m?.name) continue;
        try {
          run(`INSERT INTO device_models
                 (device_hostname, provider, model_name, size_bytes, metadata, first_seen, last_seen)
               VALUES (:h, 'ollama', :n, :sz, :meta,
                       datetime('now','localtime'), datetime('now','localtime'))
               ON CONFLICT(device_hostname, provider, model_name) DO UPDATE SET
                 size_bytes = :sz,
                 metadata = :meta,
                 last_seen = datetime('now','localtime')`,
            { ':h': d.hostname, ':n': m.name, ':sz': m.size || 0, ':meta': JSON.stringify(m) });
          stored++;
        } catch {}
      }
      summary[d.hostname] = { ok: true, url, count: stored };
      console.log(`[PAN Scout] Device ${d.hostname} (${url}): ${stored} ollama models`);
    } catch (e) {
      summary[d.hostname] = { ok: false, reason: e.message, url };
    }
  }
  return summary;
}

// Find a connected device that has the given model installed. Used by
// embeddings.js when it needs an EXACT model name match (dimensional
// compatibility). Returns { hostname, url, model, last_seen } or null.
// Prefers most-recently-confirmed device when multiple have the same model.
function findDeviceWithModel(modelName) {
  try {
    const row = get(`
      SELECT dm.device_hostname, dm.model_name, dm.last_seen,
             d.tailscale_ip, d.tailscale_hostname, d.hostname
      FROM device_models dm
      JOIN devices d ON d.hostname = dm.device_hostname
      WHERE dm.model_name = :name
      ORDER BY dm.last_seen DESC
      LIMIT 1
    `, { ':name': modelName });
    if (!row) return null;
    const host = row.tailscale_ip || row.tailscale_hostname || row.hostname;
    if (!host) return null;
    return {
      hostname: row.device_hostname,
      url: `http://${host}:${_LOCAL_INFERENCE_DEFAULT_PORT}`,
      model: row.model_name,
      last_seen: row.last_seen,
    };
  } catch {
    return null;
  }
}

// All models known to be installed on one device (or all devices if hostname omitted).
function getDeviceModelList(hostname = null) {
  try {
    if (hostname) {
      return all(`SELECT model_name, size_bytes, last_seen FROM device_models WHERE device_hostname = :h ORDER BY model_name`, { ':h': hostname });
    }
    return all(`SELECT device_hostname, model_name, size_bytes, last_seen FROM device_models ORDER BY device_hostname, model_name`);
  } catch {
    return [];
  }
}

// Get discovered local apps (for the Apps widget)
function getLocalApps({ category, installed_only = true } = {}) {
  let sql = 'SELECT * FROM local_apps';
  const conditions = [];
  const params = {};

  if (installed_only) {
    conditions.push('installed = 1');
  }
  if (category) {
    conditions.push('category = :cat');
    params[':cat'] = category;
  }

  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY category, name';

  return all(sql, params);
}

export { scout, startScout, stopScout, getFindings, updateFinding, scanLocalApps, getLocalApps, scanProviderModels, getKnownProviderModels, scanDeviceModels, findDeviceWithModel, getDeviceModelList };

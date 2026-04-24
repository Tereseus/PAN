// PAN Tool Scout — discovers new AI CLIs, tools, and integrations
//
// Monitors BetterStack, GitHub trending, and AI tool aggregators for new
// CLIs and tools that PAN can integrate. Runs daily, stores findings
// as memory items so PAN and the user stay on top of what's new.
//
// Philosophy: PAN is a compilation of the best tools available.
// All we do is take what they create and put it into PAN.

import { insert, all, get, run } from './db.js';
import { claude } from './claude.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

let timer = null;

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

  const runRemote = async () => {
    try {
      // Re-scan local apps too (picks up new installs)
      await scanLocalApps();
      await scout();
      const { reportServiceRun } = await import('./steward.js');
      reportServiceRun('scout');
    } catch (err) {
      try { const { reportServiceRun } = await import('./steward.js'); reportServiceRun('scout', err.message); } catch {}
      console.error('[PAN Scout]', err.message);
    }
  };
  setTimeout(runRemote, 30000);
  timer = setInterval(runRemote, intervalMs);
  console.log(`[PAN Scout] Running every ${Math.round(intervalMs / 3600000)}h`);
}

function stopScout() {
  if (timer) clearInterval(timer);
  timer = null;
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

// Scan Windows Start Menu and registry for installed apps
function scanInstalledApps() {
  const found = new Set();
  const paths = [
    process.env.APPDATA ? join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : null,
    process.env.PROGRAMFILES || 'C:\\Program Files',
    process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
  ].filter(Boolean);

  // Method 1: Search Start Menu shortcuts for app names
  for (const dir of paths) {
    try {
      const output = execSync(`dir /s /b "${dir}" 2>nul`, {
        encoding: 'utf-8',
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      for (const line of output.split('\n')) {
        const name = line.trim().split('\\').pop()?.replace(/\.lnk$/i, '').replace(/\.exe$/i, '');
        if (name) found.add(name);
      }
    } catch {}
  }

  // Method 2: Registry scan for installed programs (display names)
  try {
    const regPaths = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    for (const regPath of regPaths) {
      try {
        const output = execSync(
          `reg query "${regPath}" /s /v DisplayName 2>nul`,
          { encoding: 'utf-8', timeout: 10000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
        );
        for (const line of output.split('\n')) {
          const match = line.match(/DisplayName\s+REG_SZ\s+(.+)/i);
          if (match) found.add(match[1].trim());
        }
      } catch {}
    }
  } catch {}

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
  const installed = scanInstalledApps();
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

export { scout, startScout, stopScout, getFindings, updateFinding, scanLocalApps, getLocalApps };

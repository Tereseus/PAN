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

// Ensure scout table exists
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
    const raw = await claude(prompt, { model: 'claude-haiku-4-5-20251001', timeout: 30000, maxTokens: 2000, caller: 'scout' });
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
          const { stdout } = await execAsync('npx', ['a2asearch', search.topic, '--json'], { timeout: 15000, shell: true });
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
  const run = async () => {
    try {
      await scout();
      const { reportServiceRun } = await import('./steward.js');
      reportServiceRun('scout');
    } catch (err) {
      try { const { reportServiceRun } = await import('./steward.js'); reportServiceRun('scout', err.message); } catch {}
      console.error('[PAN Scout]', err.message);
    }
  };
  setTimeout(run, 30000);
  timer = setInterval(run, intervalMs);
  console.log(`[PAN Scout] Running every ${Math.round(intervalMs / 3600000)}h`);
}

function stopScout() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { scout, startScout, stopScout, getFindings, updateFinding };

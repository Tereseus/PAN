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
  const existingTools = all(`SELECT tool_name FROM scout_findings ORDER BY created_at DESC LIMIT 50`);
  const known = existingTools.map(t => t.tool_name).join(', ');

  const prompt = `You are PAN's Tool Scout. PAN is a personal AI assistant that integrates CLIs, browser automation, voice control, and other tools to automate everything on PC and phone.

PAN currently uses or knows about: NanoClaw, Playwright CLI, GWS CLI (Google Workspace), Piper TTS, Whisper STT, llama.cpp, PersonaPlex/Moshi.
Already discovered: ${known || 'none yet'}

From this ${source.name} content, find ANY new CLI tools, AI tools, automation frameworks, MCP servers, or integrations that PAN could use. Focus on:
- CLI tools that let AI agents control services (like Playwright controls browsers)
- MCP servers for new integrations
- Voice/audio AI tools
- Agent frameworks or orchestration tools
- Automation tools that work on Windows
- Anything that replaces manual API integration with a simple CLI

Page content from ${source.url}:
${content.slice(0, 6000)}

Return a JSON array of findings. Each finding:
{"name": "tool name", "description": "what it does (1-2 sentences)", "url": "project URL if found", "relevance": "why PAN should care (1 sentence)", "score": 0.0-1.0, "category": "cli|mcp|voice|agent|automation|other"}

Return MAX 5 most relevant findings. If nothing relevant, return []. Only return the JSON array.`;

  try {
    const raw = await claude(prompt, { model: 'claude-haiku-4-5-20251001', timeout: 30000, maxTokens: 2000 });
    return JSON.parse(raw);
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
  // Run first scan after 30 seconds (let server start up)
  setTimeout(() => scout().catch(console.error), 30000);
  // Then run on interval (default: daily)
  timer = setInterval(() => scout().catch(console.error), intervalMs);
  console.log(`[PAN Scout] Running every ${Math.round(intervalMs / 3600000)}h`);
}

function stopScout() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { scout, startScout, stopScout, getFindings, updateFinding };

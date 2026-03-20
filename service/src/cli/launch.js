// PAN Terminal Launcher
//
// Opens a Windows Terminal tab per project. Each Claude session gets:
//   - Tab title = project name
//   - Session name = project name (for /resume picker)
//   - Initial prompt with full session history baked in (no file reads needed)
//   - CLAUDE.md updated with PAN context (for ongoing session awareness)
//
// Context comes from Claude's sessions-index.json (summaries) and raw .jsonl
// files (first human prompt extracted when no index exists). This means
// Claude can greet the user with project context without needing ANY file
// read permissions first.

import { spawn } from 'child_process';
import { writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncProjects } from '../db.js';

const CLAUDE_CMD = join(process.env.APPDATA || 'C:\\Users\\user\\AppData\\Roaming', 'npm', 'claude.cmd');
const CLAUDE_PROJECTS = join(process.env.USERPROFILE || 'C:\\Users\\user', '.claude', 'projects');

function readPanFile(projectPath) {
  const panFile = join(projectPath.replace(/\//g, '\\'), '.pan');
  if (!existsSync(panFile)) return null;
  try { return JSON.parse(readFileSync(panFile, 'utf-8')); } catch { return null; }
}

// Sanitize text for use in a bat echo command
function batSafe(text) {
  return text
    .replace(/[&|<>^%"]/g, '') // strip bat-special chars
    .replace(/[\r\n]/g, ' ')   // flatten newlines
    .replace(/[^\x20-\x7E]/g, '') // strip non-ASCII (escape codes, unicode)
    .trim();
}

// Collect session summaries from all known session directories
function getSessionHistory(sessionDirs) {
  const entries = [];

  for (const dirName of sessionDirs) {
    const dirPath = join(CLAUDE_PROJECTS, dirName);
    if (!existsSync(dirPath)) continue;

    const idxPath = join(dirPath, 'sessions-index.json');
    if (existsSync(idxPath)) {
      // Has index — use summaries directly
      try {
        const data = JSON.parse(readFileSync(idxPath, 'utf-8'));
        for (const entry of (data.entries || [])) {
          entries.push({
            summary: entry.summary || entry.firstPrompt?.slice(0, 100) || 'untitled',
            date: entry.modified || entry.created,
            messages: entry.messageCount || 0,
          });
        }
      } catch {}
    } else {
      // No index — just note the count, don't try to extract garbage from raw jsonls
      try {
        const count = readdirSync(dirPath).filter(f => f.endsWith('.jsonl')).length;
        if (count > 0) {
          // Find the date range
          const jsonls = readdirSync(dirPath)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => statSync(join(dirPath, f)).mtimeMs);
          const newest = new Date(Math.max(...jsonls)).toISOString().slice(0, 10);
          entries.push({
            summary: `${count} previous sessions (last active ${newest})`,
            date: new Date(Math.max(...jsonls)).toISOString(),
            messages: 0,
          });
        }
      } catch {}
    }
  }

  entries.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  return entries;
}

// Update CLAUDE.md with PAN session context (preserves existing content)
function updateClaudeMd(projectPath, projectName, entries) {
  const claudeMdPath = join(projectPath.replace(/\//g, '\\'), 'CLAUDE.md');

  let existing = '';
  try { existing = readFileSync(claudeMdPath, 'utf-8'); } catch {}

  const panMarkerStart = '<!-- PAN-CONTEXT-START -->';
  const panMarkerEnd = '<!-- PAN-CONTEXT-END -->';
  const startIdx = existing.indexOf(panMarkerStart);
  const endIdx = existing.indexOf(panMarkerEnd);
  if (startIdx !== -1 && endIdx !== -1) {
    existing = existing.slice(0, startIdx) + existing.slice(endIdx + panMarkerEnd.length);
    existing = existing.trim();
  }

  let panSection = `${panMarkerStart}\n`;
  panSection += `## PAN Session Context\n\n`;
  panSection += `This terminal was launched by PAN for the "${projectName}" project.\n`;
  panSection += `IMPORTANT: The project documentation is at the TOP of this CLAUDE.md file — read it first to understand what this project is and how it works.\n\n`;

  if (entries.length > 0) {
    const realSessions = entries.filter(e => e.messages > 0);
    if (realSessions.length > 0) {
      panSection += `Recent work sessions:\n`;
      for (const e of realSessions.slice(0, 8)) {
        const date = e.date ? new Date(e.date).toISOString().slice(0, 10) : '?';
        panSection += `- [${date}] ${e.summary} (${e.messages} msgs)\n`;
      }
    }
  }

  panSection += `${panMarkerEnd}`;

  const combined = existing ? `${existing}\n\n${panSection}\n` : `${panSection}\n`;
  writeFileSync(claudeMdPath, combined, 'utf-8');
}

export default function cmdLaunch() {
  let projects = syncProjects();

  // Filter out Desktop — that's the general terminal the user is already in
  const desktopPaths = ['desktop'];
  projects = projects.filter(p => {
    const name = p.name.toLowerCase();
    const lastDir = p.path.replace(/\\/g, '/').split('/').pop().toLowerCase();
    return !desktopPaths.includes(name) && !desktopPaths.includes(lastDir);
  });

  if (projects.length === 0) {
    console.log('[PAN] No projects found on disk (.pan files). Nothing to launch.');
    return;
  }

  const batPaths = [];

  for (const p of projects) {
    const panData = readPanFile(p.path);
    const sessionDirs = panData?.all_session_dirs || [];
    const cwdEncoded = 'C--' + p.path.replace(/^[A-Z]:\//,'').replace(/\//g, '-');
    if (!sessionDirs.includes(cwdEncoded)) sessionDirs.push(cwdEncoded);

    const entries = getSessionHistory(sessionDirs);

    // Update CLAUDE.md for ongoing session context
    updateClaudeMd(p.path, p.name, entries);

    // Build a plain-text summary to echo directly — no AI, no hallucination
    const safeName = p.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const batPath = join(tmpdir(), `pan-launch-${safeName}.bat`);
    const winPath = p.path.replace(/\//g, '\\');

    // Build echo lines: project description + session history
    const echoLines = [];
    echoLines.push(`echo [PAN] ${p.name}`);
    echoLines.push(`echo Location: ${winPath}`);
    echoLines.push(`echo.`);

    // Pull project description from CLAUDE.md (the non-PAN part)
    const claudeMdPath = join(winPath, 'CLAUDE.md');
    let description = '';
    try {
      const raw = readFileSync(claudeMdPath, 'utf-8');
      // Strip the PAN context section
      const panStart = raw.indexOf('<!-- PAN-CONTEXT-START -->');
      const clean = panStart !== -1 ? raw.slice(0, panStart).trim() : raw.trim();
      // Get first meaningful lines (skip title, get description)
      const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('#')) continue; // skip headers
        if (line.startsWith('```')) break;  // stop at code blocks
        if (line.startsWith('##')) break;   // stop at sub-headers
        description = line;
        break;
      }
    } catch {}

    if (description) {
      echoLines.push(`echo ${batSafe(description).slice(0, 120)}`);
      echoLines.push(`echo.`);
    }

    // Only show indexed sessions with real summaries
    const realSessions = entries.filter(e => e.messages > 0);
    if (realSessions.length > 0) {
      echoLines.push(`echo Recent work:`);
      for (const e of realSessions.slice(0, 5)) {
        const date = e.date ? new Date(e.date).toISOString().slice(0, 10) : '';
        const summary = batSafe(e.summary).slice(0, 90);
        echoLines.push(`echo   ${date} - ${summary} (${e.messages} msgs)`);
      }
    } else {
      // No indexed sessions — just show total count
      const totalCount = entries.reduce((sum, e) => {
        const match = e.summary.match(/^(\d+) previous/);
        return sum + (match ? parseInt(match[1]) : 1);
      }, 0);
      if (totalCount > 0) {
        echoLines.push(`echo ${totalCount} previous sessions on file`);
      }
    }

    const batContent = [
      '@echo off',
      `title ${p.name}`,
      `cd /d "${winPath}"`,
      `echo.`,
      `echo ============================================`,
      ...echoLines,
      `echo ============================================`,
      `echo.`,
      `"${CLAUDE_CMD}" --name "${p.name}"`,
    ].join('\r\n');

    writeFileSync(batPath, batContent, 'ascii');
    batPaths.push({ name: p.name, bat: batPath });

    console.log(`[PAN] ${p.name}: ${entries.length} session records`);
  }

  // Build wt command string with proper quoting
  const tabCmds = batPaths.map((b, i) => {
    const prefix = i > 0 ? ' ; new-tab' : '';
    return `${prefix} --title "${b.name}" "${b.bat}"`;
  });
  const wtCmd = `wt.exe ${tabCmds.join('')}`;

  const child = spawn(wtCmd, [], {
    detached: true,
    stdio: 'ignore',
    shell: true
  });
  child.unref();

  console.log(`[PAN] Launched ${projects.length} project terminals`);
}

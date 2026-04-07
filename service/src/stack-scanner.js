// PAN Stack Scanner — Discovers tech stacks across all projects
//
// Scans project files (package.json, build.gradle, requirements.txt, etc.)
// to identify what technologies each project uses. This data feeds into
// Scout (to search for relevant improvements) and AutoDev (to know what
// tools are available for each project).

import { all, get, insert, run } from './db.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, sep } from 'path';

let scanInterval = null;

// File patterns that indicate tech stack
const STACK_FILES = [
  { file: 'package.json', parser: parsePackageJson },
  { file: 'build.gradle.kts', parser: parseGradle },
  { file: 'build.gradle', parser: parseGradle },
  { file: 'requirements.txt', parser: parseRequirements },
  { file: 'Pipfile', parser: parsePipfile },
  { file: 'pyproject.toml', parser: parsePyproject },
  { file: 'Cargo.toml', parser: parseCargoToml },
  { file: 'go.mod', parser: parseGoMod },
  { file: 'Gemfile', parser: parseGemfile },
  { file: 'CMakeLists.txt', parser: parseCMake },
  { file: '.pan', parser: parsePanFile },
];

// Language detection by file extensions
const LANG_EXTENSIONS = {
  '.kt': 'Kotlin', '.java': 'Java', '.js': 'JavaScript', '.ts': 'TypeScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.rb': 'Ruby',
  '.cpp': 'C++', '.c': 'C', '.cs': 'C#', '.swift': 'Swift',
  '.gd': 'GDScript', '.lua': 'Lua', '.dart': 'Dart',
  '.html': 'HTML', '.css': 'CSS', '.sql': 'SQL',
};

function parsePackageJson(path) {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return {
      runtime: 'Node.js',
      framework: deps.express ? 'Express' : deps.next ? 'Next.js' : deps.react ? 'React' : null,
      dependencies: Object.keys(deps),
      type: pkg.type || 'commonjs',
    };
  } catch { return null; }
}

function parseGradle(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    const deps = [];
    const matches = content.matchAll(/implementation\s*\(?\s*["']([^"']+)["']/g);
    for (const m of matches) deps.push(m[1]);
    return {
      runtime: content.includes('kotlin') ? 'Kotlin' : 'Java',
      framework: content.includes('compose') ? 'Jetpack Compose' : content.includes('android') ? 'Android' : null,
      dependencies: deps,
      android: content.includes('com.android'),
    };
  } catch { return null; }
}

function parseRequirements(path) {
  try {
    const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
    return { runtime: 'Python', dependencies: lines.map(l => l.split('==')[0].split('>=')[0].trim()) };
  } catch { return null; }
}

function parsePipfile(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    const deps = [];
    const matches = content.matchAll(/^(\w[\w-]+)\s*=/gm);
    for (const m of matches) if (!['python_version', 'url', 'verify_ssl'].includes(m[1])) deps.push(m[1]);
    return { runtime: 'Python', dependencies: deps };
  } catch { return null; }
}

function parsePyproject(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    const deps = [];
    const matches = content.matchAll(/"([^"]+)"/g);
    for (const m of matches) if (m[1].match(/^[a-z]/i)) deps.push(m[1].split('>=')[0].split('==')[0]);
    return { runtime: 'Python', dependencies: deps.slice(0, 30) };
  } catch { return null; }
}

function parseCargoToml(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    const deps = [];
    const matches = content.matchAll(/^(\w[\w-]+)\s*=/gm);
    for (const m of matches) deps.push(m[1]);
    return { runtime: 'Rust', dependencies: deps };
  } catch { return null; }
}

function parseGoMod(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    const deps = [];
    const matches = content.matchAll(/^\t(\S+)/gm);
    for (const m of matches) deps.push(m[1]);
    return { runtime: 'Go', dependencies: deps };
  } catch { return null; }
}

function parseGemfile(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    const deps = [];
    const matches = content.matchAll(/gem\s+['"]([^'"]+)['"]/g);
    for (const m of matches) deps.push(m[1]);
    return { runtime: 'Ruby', dependencies: deps };
  } catch { return null; }
}

function parseCMake(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    return {
      runtime: 'C/C++',
      dependencies: content.includes('llama') ? ['llama.cpp'] : [],
      ndk: content.includes('ANDROID_NDK'),
    };
  } catch { return null; }
}

function parsePanFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

// Detect languages used in project by scanning file extensions
function detectLanguages(projectPath) {
  const winPath = projectPath.replace(/\//g, sep);
  const langs = {};
  const maxDepth = 3;

  function scan(dir, depth) {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build' ||
            entry.name === '.git' || entry.name === '__pycache__' || entry.name === 'target') continue;
        if (entry.isDirectory()) {
          scan(join(dir, entry.name), depth + 1);
        } else {
          const ext = '.' + entry.name.split('.').pop();
          if (LANG_EXTENSIONS[ext]) {
            langs[LANG_EXTENSIONS[ext]] = (langs[LANG_EXTENSIONS[ext]] || 0) + 1;
          }
        }
      }
    } catch {}
  }

  scan(winPath, 0);
  return langs;
}

// Main scan function
function scanStacks() {
  console.log('[PAN Stack] Scanning project tech stacks...');

  const projects = all("SELECT * FROM projects ORDER BY name");
  let scanned = 0;

  for (const project of projects) {
    const projectPath = project.path.replace(/\//g, sep);
    if (!existsSync(projectPath)) continue;

    const stack = {
      project_id: project.id,
      project_name: project.name,
      runtimes: [],
      frameworks: [],
      dependencies: [],
      languages: {},
      raw: {},
    };

    // Check each stack file
    for (const { file, parser } of STACK_FILES) {
      // Check in project root and one level deep
      const paths = [join(projectPath, file)];
      try {
        const entries = readdirSync(projectPath, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
            paths.push(join(projectPath, e.name, file));
          }
        }
      } catch {}

      for (const p of paths) {
        if (!existsSync(p)) continue;
        const result = parser(p);
        if (result) {
          if (result.runtime && !stack.runtimes.includes(result.runtime)) stack.runtimes.push(result.runtime);
          if (result.framework && !stack.frameworks.includes(result.framework)) stack.frameworks.push(result.framework);
          if (result.dependencies) {
            for (const d of result.dependencies) {
              if (!stack.dependencies.includes(d)) stack.dependencies.push(d);
            }
          }
          stack.raw[file] = result;
        }
      }
    }

    // Detect languages
    stack.languages = detectLanguages(projectPath);

    // Store in settings
    const key = `stack_${project.id}`;
    const existing = get("SELECT id FROM settings WHERE key = :key", { ':key': key });
    const value = JSON.stringify(stack);
    if (existing) {
      run("UPDATE settings SET value = :val, updated_at = datetime('now','localtime') WHERE key = :key",
        { ':key': key, ':val': value });
    } else {
      insert("INSERT INTO settings (key, value) VALUES (:key, :val)", { ':key': key, ':val': value });
    }

    scanned++;
    console.log(`[PAN Stack] ${project.name}: ${stack.runtimes.join(', ')} | ${Object.keys(stack.languages).join(', ')} | ${stack.dependencies.length} deps`);
  }

  console.log(`[PAN Stack] Scanned ${scanned} projects`);
  return scanned;
}

function getProjectStack(projectId) {
  const row = get("SELECT value FROM settings WHERE key = :key", { ':key': `stack_${projectId}` });
  if (row) try { return JSON.parse(row.value); } catch {}
  return null;
}

function getAllStacks() {
  const rows = all("SELECT key, value FROM settings WHERE key LIKE 'stack_%'");
  return rows.map(r => {
    try { return JSON.parse(r.value); } catch { return null; }
  }).filter(Boolean);
}

function startStackScanner(intervalMs = 6 * 60 * 60 * 1000) {
  const run = async () => {
    try {
      await scanStacks();
      const { reportServiceRun } = await import('./steward.js');
      reportServiceRun('stack-scanner');
    } catch (err) {
      try { const { reportServiceRun } = await import('./steward.js'); reportServiceRun('stack-scanner', err.message); } catch {}
      console.error('[PAN Stack]', err.message);
    }
  };
  setTimeout(run, 15000);
  scanInterval = setInterval(run, intervalMs);
  console.log('[PAN Stack] Scanner scheduled every ' + Math.round(intervalMs / 3600000) + 'h');
}

function stopStackScanner() {
  if (scanInterval) clearInterval(scanInterval);
  scanInterval = null;
}

// Detect the user's development environment (terminal, IDE, OS, shell)
// Runs once and caches — environment doesn't change often
let envCache = null;

function detectDevEnvironment() {
  if (envCache) return envCache;

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const env = {
    os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    shell: process.env.SHELL || (process.platform === 'win32' ? 'bash (Git Bash)' : 'unknown'),
    terminal: 'unknown',
    ide: [],
    tools: [],
  };

  // Detect terminal
  if (existsSync(join(home, '.wezterm.lua')) || existsSync(join(home, '.config', 'wezterm'))) {
    env.terminal = 'WezTerm';
    env.terminalConfig = join(home, '.wezterm.lua');
  } else if (process.env.WT_SESSION) {
    env.terminal = 'Windows Terminal';
  } else if (process.env.TERM_PROGRAM === 'iTerm.app') {
    env.terminal = 'iTerm2';
  } else if (process.env.TERM_PROGRAM) {
    env.terminal = process.env.TERM_PROGRAM;
  }

  // Detect IDE
  if (existsSync(join(home, '.vscode'))) env.ide.push('VS Code');
  if (existsSync(join(home, '.jetbrains'))) env.ide.push('JetBrains');

  // Detect common tools
  if (existsSync(join(home, '.claude'))) env.tools.push('Claude Code CLI');
  if (process.env.ANDROID_HOME || existsSync(join(home, 'AppData', 'Local', 'Android', 'Sdk'))) env.tools.push('Android SDK');

  envCache = env;
  return env;
}

// Build a human-readable environment summary for context briefing
function getEnvironmentBriefing() {
  const env = detectDevEnvironment();
  let lines = [];
  lines.push(`OS: ${env.os}`);
  lines.push(`Terminal: ${env.terminal}${env.terminalConfig ? ' (config: ' + env.terminalConfig + ')' : ''}`);
  lines.push(`Shell: ${env.shell}`);
  if (env.ide.length) lines.push(`IDE: ${env.ide.join(', ')}`);
  if (env.tools.length) lines.push(`Tools: ${env.tools.join(', ')}`);
  return lines.join('\n');
}

// Build a full project context string including stack + environment
function getProjectBriefing(projectId) {
  const stack = getProjectStack(projectId);
  const envBrief = getEnvironmentBriefing();

  let brief = '## Development Environment\n' + envBrief + '\n';

  if (stack) {
    if (stack.runtimes.length) brief += `\nRuntimes: ${stack.runtimes.join(', ')}`;
    if (stack.frameworks.length) brief += `\nFrameworks: ${stack.frameworks.join(', ')}`;
    const langs = Object.entries(stack.languages || {}).sort((a, b) => b[1] - a[1]).map(([l]) => l);
    if (langs.length) brief += `\nLanguages: ${langs.join(', ')}`;
    brief += '\n';
  }

  brief += '\n## Term Mapping\n';
  brief += `When the user says "terminal" they mean: ${detectDevEnvironment().terminal}\n`;
  brief += 'When the user says "the app" or "phone" they mean: the Android PAN app\n';
  brief += 'When the user says "the server" they mean: PAN Node.js server (port 7777)\n';
  brief += 'When the user says "the dashboard" they mean: the web dashboard served by PAN\n';

  return brief;
}

export { scanStacks, getProjectStack, getAllStacks, startStackScanner, stopStackScanner, detectDevEnvironment, getEnvironmentBriefing, getProjectBriefing };

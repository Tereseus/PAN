// The person's own terminal as ΠAN's smart model (task 1091, the owner Nov 27): "whatever terminal
// they signed in with" during installation. Each terminal runs one prompt and prints the answer;
// ΠAN only starts it, on the person's own sign in, and reads what it says. Nothing is bundled and
// ΠAN pays nobody. A model id `cli:<terminal>` or `cli:<terminal>:<model>` reaches this file from
// llm.js (askAI). Claude Code keeps its own path there (anthropic:, the Agent SDK).
//
// Checked Nov 27 on the G16:
//   codex  Codex (ChatGPT login), `codex exec`: 4.4 to 4.9 s, both layout problems right.
//   agy    Antigravity (Google), `agy --print`: 3 of 3 right on the trains; default model 12 to 16 s,
//          cli:agy:gemini-3.8-flash-medium (or -low) about 9 s, which seems to be its start up floor.
// Not yet installed anywhere, so not tried: grok (Grok Build), qwen (Qwen Code), kimi (Kimi Code).

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const IS_WIN = process.platform === 'win32';
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

/** An empty folder for the terminal to start in: these runs read and write nothing of the person's. */
function emptyDir() {
  const d = path.join(os.tmpdir(), 'pan-cli-empty');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function onPath(name) {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const f = path.join(dir, name + ext);
      try { if (fs.statSync(f).isFile()) return f; } catch {}
    }
  }
  return null;
}

/** The newest file matching name under a folder of version folders (Codex keeps bin/<hash>/codex.exe). */
function newestUnder(root, file) {
  try {
    return fs.readdirSync(root).map((d) => path.join(root, d, file)).filter((f) => fs.existsSync(f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch { return null; }
}

export const TERMINALS = {
  codex: {
    name: 'Codex (ChatGPT)',
    find: () => onPath('codex') || (IS_WIN ? newestUnder(path.join(LOCAL, 'OpenAI', 'Codex', 'bin'), 'codex.exe') : null),
    // --ignore-user-config: the person's own Codex settings can name a model their login cannot use
    // (the owner's names gpt-6-sol, refused for ChatGPT accounts); the sign in is still theirs.
    // Without the person's config Codex thinks not at all (reasoning effort none) and got the trains
    // wrong (6 pm). Nov 27, three runs each: low 2 of 3 right, medium 3 of 3 in 4 to 14.5 s.
    args: (model, outFile, _prompt, _secs, effort = 'medium') => ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only',
      '-C', emptyDir(), '--color', 'never', '-o', outFile, '-c', `model_reasoning_effort="${effort}"`, ...(model ? ['-m', model] : []), '-'],
    stdin: true,
    answer: (stdout, outFile) => { try { return fs.readFileSync(outFile, 'utf8'); } catch { return lastBlock(stdout); } },
  },
  agy: {
    name: 'Antigravity (Google)',
    find: () => onPath('agy') || (IS_WIN ? (fs.existsSync(path.join(LOCAL, 'agy', 'bin', 'agy.exe')) ? path.join(LOCAL, 'agy', 'bin', 'agy.exe') : null) : null),
    args: (model, _out, prompt, secs) => ['--print', prompt, '--output-format', 'text', '--print-timeout', `${secs}s`, ...(model ? ['--model', model] : [])],
    stdin: false,
    answer: (stdout) => stdout,
  },
};

function lastBlock(s) {
  const parts = String(s || '').trim().split(/\n\s*\n/);
  return parts[parts.length - 1] || '';
}

/** Which terminals this computer has, for Setup and the Settings page. */
export function terminalsHere() {
  return Object.entries(TERMINALS).map(([id, t]) => ({ id, name: t.name, path: t.find() })).filter((t) => t.path);
}

/** "cli:codex" -> { kind: 'codex', model: '' }; "cli:agy:gemini-3-pro" -> { kind: 'agy', model: 'gemini-3-pro' }. */
export function parseCliModel(id) {
  const [, kind = '', ...rest] = String(id || '').split(':');
  return { kind, model: rest.join(':') };
}

/** One prompt through the person's terminal. Resolves with its answer, rejects on error or timeout. */
export function runCli(id, prompt, { timeoutMs = 60_000, signal = null } = {}) {
  const { kind, model } = parseCliModel(id);
  const t = TERMINALS[kind];
  if (!t) return Promise.reject(new Error(`no terminal called ${kind}`));
  const bin = t.find();
  if (!bin) return Promise.reject(new Error(`${t.name} is not installed on this computer`));
  const outFile = path.join(os.tmpdir(), `pan-cli-${process.pid}-${Date.now()}.txt`);
  const secs = Math.max(5, Math.round(timeoutMs / 1000));
  const args = t.args(model, outFile, prompt, secs);
  return new Promise((resolve, reject) => {
    // A .cmd needs the shell on Windows; an .exe does not.
    const child = spawn(bin, args, { cwd: emptyDir(), windowsHide: true, shell: IS_WIN && /\.(cmd|bat)$/i.test(bin), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { fs.unlinkSync(outFile); } catch {} fn(v); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} const e = new Error(`${t.name} timeout > ${timeoutMs}ms`); e.name = 'AbortError'; finish(reject, e); }, timeoutMs);
    signal?.addEventListener?.('abort', () => { try { child.kill(); } catch {} finish(reject, Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      const text = String(t.answer(out, outFile) || '').trim();
      if (code === 0 && text) finish(resolve, text);
      else finish(reject, new Error(`${t.name} exited ${code}: ${(err || out).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`));
    });
    if (t.stdin) child.stdin.end(prompt); else child.stdin.end();
  });
}

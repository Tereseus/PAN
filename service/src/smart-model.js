// The smart model: the big model PAN hands its hard work to (acting for the person on a screen,
// long questions, writing code). PAN talks, listens and remembers on the hub's own small models;
// the rest needs a model from one of the big labs, and today that is Claude, used through the
// person's OWN Claude sign in. PAN never sees a key and nothing of PAN's is hosted.
//
// The Claude program itself comes with PAN (the Agent SDK in node_modules brings it), so a new
// hub never lacks the program: what it lacks is the sign in. This file answers "is the smart
// model connected, and if not, what does the person do".
//
// parseAuthStatus and smartModelState are pure and tested (__tests__/smart-model.test.js);
// claudeProgram and checkSmartModel touch the disk and run the program.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What `claude auth status` printed, as { loggedIn, method }. null when it is not that. */
export function parseAuthStatus(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    if (typeof j.loggedIn !== 'boolean') return null;
    return { loggedIn: j.loggedIn, method: String(j.authMethod || 'none') };
  } catch { return null; }
}

/**
 * The state in plain words. `program`: the Claude program was found. `status`: parseAuthStatus's
 * answer, or null when the program did not answer.
 *   connected   signed in: everything PAN does is open
 *   signed_out  the program is there, nobody is signed in
 *   missing     the program that comes with PAN is not there (a broken install)
 *   unknown     the program is there but did not answer
 */
export function smartModelState({ program, status }) {
  if (!program) {
    return { state: 'missing', connected: false, say: 'The Claude program that comes with PAN is missing. Run PAN Setup again.', fix: 'reinstall' };
  }
  if (!status) {
    return { state: 'unknown', connected: false, say: 'Claude did not answer, so PAN cannot tell whether it is signed in.', fix: 'retry' };
  }
  if (status.loggedIn) {
    return { state: 'connected', connected: true, method: status.method, say: 'Claude is connected. PAN can use it for the hard work.', fix: null };
  }
  return { state: 'signed_out', connected: false,
    say: 'Claude is not signed in. PAN still talks, listens and remembers, but acting for you, long questions and code need it.', fix: 'sign_in' };
}

/** Where the Claude program that comes with PAN is. null when it is not there. */
export function claudeProgram() {
  try {
    // The package's own entry file sits beside cli.js (its package.json is not exported).
    const cli = path.join(path.dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))), 'cli.js');
    return existsSync(cli) ? cli : null;
  } catch { return null; }
}

let kept = null;   // { at, value }: the check starts a program, so its answer is kept half a minute

/** Run the check. Never throws. `fresh` skips the kept answer (right after a sign in). */
export async function checkSmartModel({ fresh = false, timeoutMs = 25000, now = Date.now } = {}) {
  if (!fresh && kept && now() - kept.at < 30000) return kept.value;
  const cli = claudeProgram();
  let status = null;
  if (cli) {
    status = await new Promise((resolve) => {
      execFile(process.execPath, [cli, 'auth', 'status', '--json'], { windowsHide: true, timeout: timeoutMs }, (_err, stdout) => resolve(parseAuthStatus(stdout)));
    });
  }
  const value = { ...smartModelState({ program: !!cli, status }), provider: 'claude' };
  kept = { at: now(), value };
  return value;
}

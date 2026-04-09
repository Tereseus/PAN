// PAN Mode Detection
//
// PAN runs in two distinct deployment modes:
//
//   1. "user"    — launched in a Windows interactive user session (Session 1+).
//                  Has a real desktop, console, and access to user-only APIs:
//                  PTY (node-pty's ConPTY), AutoHotkey hotkeys, mouse/keyboard
//                  hooks, screenshots, clipboard, tray icons, voice typing.
//                  This is the personal-workstation deployment.
//
//   2. "service" — launched as a Windows service (Session 0, SYSTEM/network
//                  service account). Headless. No desktop, no console, no
//                  input simulation, no PTY (conpty agent crashes), no AHK.
//                  This is the org/server deployment — clients hit the API
//                  from elsewhere; nobody is sitting at the machine.
//
// Same codebase, same DB, same config. Modules check `IS_USER_MODE` to decide
// whether to register. The dashboard reads `mode` from /health to know what
// to render (hides terminal tabs in service mode).

const sessionName = process.env.SESSIONNAME || '';
const username = process.env.USERNAME || '';
const userProfile = process.env.USERPROFILE || '';

// Detection signals (any one of these → service mode):
//   1. USERPROFILE points to the SYSTEM profile (definitive — Windows always
//      sets this for SYSTEM services and never for real users).
//   2. Username ends with "$" (computer/machine account, e.g. "TEDGL$").
//   3. Username is literally "SYSTEM" or "LOCAL SERVICE" / "NETWORK SERVICE".
//
// SESSIONNAME used to be the primary signal, but it doesn't reliably
// propagate through Start-Process / Tauri spawn / detached children even
// when the parent IS in an interactive session. So we trust USERPROFILE first.
const isSystemProfile = /\\config\\systemprofile/i.test(userProfile);
const isMachineAccount = username.endsWith('$');
const isServiceAccount = /^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$/i.test(username);
const isInteractiveSession = !(isSystemProfile || isMachineAccount || isServiceAccount);

export const PAN_MODE = isInteractiveSession ? 'user' : 'service';
export const IS_USER_MODE = PAN_MODE === 'user';
export const IS_SERVICE_MODE = PAN_MODE === 'service';

// Diagnostic info exposed via /health for debugging deployment issues.
export const MODE_INFO = {
  mode: PAN_MODE,
  sessionName: sessionName || null,
  username,
  userProfile,
  isSystemProfile,
  isMachineAccount,
  isServiceAccount,
  pid: process.pid,
  platform: process.platform,
};

console.log(`[PAN Mode] Running in ${PAN_MODE.toUpperCase()} mode (session=${sessionName || 'none'}, user=${username})`);

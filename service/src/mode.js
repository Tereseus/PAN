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

// Detection signals:
//   USERPROFILE is the primary signal. If it points to a real user home
//   (C:\Users\<anyone> that isn't the SYSTEM profile), it's user mode —
//   regardless of what USERNAME says. This means a Windows service can run
//   in user mode simply by setting USERPROFILE in its pan.xml config, which
//   any installer does automatically for the installing user. No hardcoded
//   username needed — it's portable across any install.
//
//   Service mode only when USERPROFILE clearly indicates a system account
//   (config\systemprofile) AND no other user-mode signal is present.
const isSystemProfile = /\\config\\systemprofile/i.test(userProfile);
// Real user profile: C:\Users\<anything> but NOT the system profile path
const isRealUserProfile = /[/\\]users[/\\][^/\\]+/i.test(userProfile) && !isSystemProfile;
const isMachineAccount = username.endsWith('$');
const isServiceAccount = /^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$/i.test(username);
// User mode if USERPROFILE looks like a real user home — that overrides USERNAME.
// Service mode only when the profile is clearly a system profile with no user override.
const isInteractiveSession = isRealUserProfile || !(isSystemProfile || isMachineAccount || isServiceAccount);

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

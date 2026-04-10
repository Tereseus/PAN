// Terminal Bridge — provides the same API as terminal.js but routes calls
// through IPC to the Carrier process when running as a Craft child.
//
// When PAN_CRAFT=1: all terminal operations go via process.send() → Carrier
// When running standalone: imports terminal.js directly (no bridge needed)
//
// This lets hooks.js, steward.js, and server.js use the same import regardless
// of whether they're in Carrier mode or standalone mode.

const IS_CRAFT = process.env.PAN_CRAFT === '1';

let directTerminal = null;

// IPC request/reply tracking
let ipcIdCounter = 0;
const ipcPending = new Map(); // id → { resolve, timer }

if (IS_CRAFT) {
  // Listen for IPC replies from Carrier
  process.on('message', (msg) => {
    if (!msg?.id || !msg?.type?.endsWith(':reply')) return;
    const pending = ipcPending.get(msg.id);
    if (pending) {
      clearTimeout(pending.timer);
      ipcPending.delete(msg.id);
      pending.resolve(msg.result);
    }
  });
}

function ipcRequest(type, data = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const id = ++ipcIdCounter;
    const timer = setTimeout(() => {
      ipcPending.delete(id);
      reject(new Error(`IPC timeout: ${type}`));
    }, timeoutMs);
    ipcPending.set(id, { resolve, timer });
    process.send({ type, id, ...data });
  });
}

function ipcFire(type, data = {}) {
  // Fire-and-forget — no reply expected
  try { process.send({ type, ...data }); } catch {}
}

async function getTerminal() {
  if (!directTerminal) {
    directTerminal = await import('./terminal.js');
  }
  return directTerminal;
}

// ==================== Exported API ====================
// Each function checks IS_CRAFT to decide: IPC or direct call

export async function startTerminalServer(httpServer) {
  if (IS_CRAFT) return; // Carrier owns terminal — Craft does nothing
  const t = await getTerminal();
  return t.startTerminalServer(httpServer);
}

export async function startDevTerminalServer(httpServer) {
  if (IS_CRAFT) return;
  const t = await getTerminal();
  return t.startDevTerminalServer(httpServer);
}

export async function listSessions() {
  if (IS_CRAFT) return ipcRequest('terminal:listSessions');
  const t = await getTerminal();
  return t.listSessions() || [];
}

export async function getActivePtyPids() {
  if (IS_CRAFT) return ipcRequest('terminal:getActivePtyPids');
  const t = await getTerminal();
  return t.getActivePtyPids() || [];
}

export function sendToSession(sessionId, text) {
  if (IS_CRAFT) return ipcFire('terminal:sendToSession', { sessionId, text });
  return directTerminal?.sendToSession(sessionId, text);
}

export function broadcastToSession(sessionId, messageType, data) {
  if (IS_CRAFT) return ipcFire('terminal:broadcastToSession', { sessionId, messageType, data });
  return directTerminal?.broadcastToSession(sessionId, messageType, data);
}

export async function broadcastNotification(notificationType, data) {
  if (IS_CRAFT) return ipcFire('terminal:broadcastNotification', { notificationType, data });
  // Use getTerminal() to ensure the module is loaded — directTerminal may be null
  // if this is called before startTerminalServer (e.g. from createAlert during boot)
  const t = await getTerminal();
  return t.broadcastNotification(notificationType, data);
}

export function killSession(sessionId) {
  if (IS_CRAFT) return ipcFire('terminal:killSession', { sessionId });
  return directTerminal?.killSession(sessionId);
}

export async function killAllSessions() {
  if (IS_CRAFT) return ipcRequest('terminal:killAllSessions', {}, 10000);
  return directTerminal?.killAllSessions();
}

export function setInFlightTool(cwd, tool, summary, claudeSessionId, isSubagent) {
  if (IS_CRAFT) return ipcFire('terminal:setInFlightTool', { cwd, tool, summary, claudeSessionId, isSubagent });
  return directTerminal?.setInFlightTool(cwd, tool, summary, claudeSessionId, isSubagent);
}

export function clearInFlightTool(cwd, claudeSessionId) {
  if (IS_CRAFT) return ipcFire('terminal:clearInFlightTool', { cwd, claudeSessionId });
  return directTerminal?.clearInFlightTool(cwd, claudeSessionId);
}

export function getInFlightTool(cwd) {
  if (IS_CRAFT) return ipcRequest('terminal:getInFlightTool', { cwd });
  return directTerminal?.getInFlightTool(cwd);
}

export function getPendingPermissions() {
  if (IS_CRAFT) return ipcRequest('terminal:getPendingPermissions');
  return directTerminal?.getPendingPermissions() || [];
}

export function clearPermission(permissionId) {
  if (IS_CRAFT) return ipcFire('terminal:clearPermission', { permissionId });
  return directTerminal?.clearPermission(permissionId);
}

export function addPendingPermission(permission) {
  if (IS_CRAFT) return ipcFire('terminal:addPendingPermission', { permission });
  return directTerminal?.addPendingPermission(permission);
}

export function respondToPermission(permissionId, response) {
  if (IS_CRAFT) return ipcFire('terminal:respondToPermission', { permissionId, response });
  return directTerminal?.respondToPermission(permissionId, response);
}

// Functions that only exist in direct mode (not needed by Craft)
export function getTerminalProjects() {
  if (IS_CRAFT) return ipcRequest('terminal:getTerminalProjects');
  return directTerminal?.getTerminalProjects() || [];
}

// Re-export for compatibility — listDevSessions/killDevSession only matter in standalone
export function listDevSessions() {
  return directTerminal?.listDevSessions?.() || [];
}
export function killDevSession(id) {
  return directTerminal?.killDevSession?.(id);
}

// Process registry — tracks all PIDs spawned by PAN
export async function getProcessRegistry() {
  if (IS_CRAFT) return ipcRequest('terminal:getProcessRegistry');
  const t = await getTerminal();
  return t.getProcessRegistry() || [];
}

export function registerProcess(info) {
  if (IS_CRAFT) return ipcFire('terminal:registerProcess', info);
  return directTerminal?.registerProcess(info);
}

export function deregisterProcess(pid, exitCode) {
  if (IS_CRAFT) return ipcFire('terminal:deregisterProcess', { pid, exitCode });
  return directTerminal?.deregisterProcess(pid, exitCode);
}

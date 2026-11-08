// Where PAN is, for the stdio MCP servers (mcp-server.js, quality-log-mcp.js). Claude starts
// them on whatever computer it runs on, from the repo's .mcp.json, so the address can't be
// written into that file: on the PAN computer PAN is on 127.0.0.1:7777, and on a computer
// paired with PAN Link it is the link's local port, 127.0.0.1:7779 (pan-link/README.md).
//
// In order: PAN_BASE_URL when set; the link's port when this computer has a paired link
// client (its client.json, where the PAN Link installers put it); else this computer's PAN.

import path from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

export const LINK_CLIENT_URL = 'http://127.0.0.1:7779';
export const LOCAL_PAN_URL = 'http://127.0.0.1:7777';

/** Where a paired link client keeps its state on this computer. */
export function linkClientState({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(local, 'PAN', 'link-client', 'client.json');
  }
  return path.posix.join(home, '.local', 'share', 'pan', 'link-client', 'client.json');
}

/** PAN's base URL for this computer, with no slash at the end. */
export function panBaseUrl({ env = process.env, platform = process.platform, home = homedir(), exists = existsSync } = {}) {
  const set = String(env.PAN_BASE_URL || '').trim();
  if (set) return set.replace(/\/+$/, '');
  if (exists(linkClientState({ env, platform, home }))) return LINK_CLIENT_URL;
  return LOCAL_PAN_URL;
}

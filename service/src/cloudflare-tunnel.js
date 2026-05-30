// cloudflare-tunnel.js — Zero-config public tunnel via Cloudflare Quick Tunnel.
//
// On first use, downloads the `cloudflared` binary (~30MB) automatically.
// Then starts `cloudflared tunnel --url localhost:<port>` and captures the
// public https://xxx.trycloudflare.com URL — no account, no config, no ACLs.
//
// The URL changes each restart (by design — old invite links expire naturally).
// Any device anywhere can reach PAN via this URL without Tailscale.

import { spawn, execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, createWriteStream, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Store cloudflared alongside the service binaries
const BIN_DIR = join(__dirname, '..', 'bin');
const CLOUDFLARED = join(BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

const DOWNLOAD_URL = process.platform === 'win32'
  ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  : process.arch === 'arm64'
    ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64'
    : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

let _url    = null;  // Current public tunnel URL
let _proc   = null;  // Child process handle

/** Returns the active Cloudflare tunnel URL, or null if not running. */
export function getTunnelURL() { return _url; }

/** Download the cloudflared binary if it's not already present. */
function downloadCloudflared() {
  return new Promise((resolve, reject) => {
    if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });
    console.log('[Cloudflare Tunnel] Downloading cloudflared binary...');

    const file = createWriteStream(CLOUDFLARED);

    function get(url) {
      https.get(url, { headers: { 'User-Agent': 'PAN-Server' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} downloading cloudflared`));
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          if (process.platform === 'win32') {
            // Remove Mark of the Web so Windows allows spawning the downloaded exe
            try { execSync(`powershell -NoProfile -Command "Unblock-File '${CLOUDFLARED}'"`, { windowsHide: true }); } catch {}
          } else {
            chmodSync(CLOUDFLARED, 0o755);
          }
          console.log('[Cloudflare Tunnel] Binary ready');
          resolve();
        });
        file.on('error', reject);
      }).on('error', reject);
    }

    get(DOWNLOAD_URL);
  });
}

/**
 * Start a Cloudflare Quick Tunnel for the given port.
 * Returns the public URL, or null if it couldn't start.
 * Safe to call multiple times — stops any existing tunnel first.
 */
export async function startCloudflareTunnel(port) {
  // Kills in-memory proc AND any orphaned cloudflared from prior restarts
  stopCloudflareTunnel();

  try {
    if (!existsSync(CLOUDFLARED)) await downloadCloudflared();
  } catch (err) {
    console.warn('[Cloudflare Tunnel] Download failed:', err.message);
    return null;
  }

  return new Promise(resolve => {
    console.log(`[Cloudflare Tunnel] Starting tunnel → localhost:${port}...`);

    // shell:true is required on Windows to spawn downloaded .exe files without EBUSY
    _proc = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${port}`], {
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let done = false;
    const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    function onData(chunk) {
      if (done) return;
      const text = chunk.toString();
      const match = text.match(URL_RE);
      if (match) {
        done = true;
        _url = match[0];
        console.log(`[Cloudflare Tunnel] Public URL: ${_url}`);
        resolve(_url);
      }
    }

    // cloudflared writes its logs to stderr
    _proc.stdout.on('data', onData);
    _proc.stderr.on('data', onData);

    _proc.on('exit', code => {
      console.log(`[Cloudflare Tunnel] Exited (code ${code})`);
      _url  = null;
      _proc = null;
    });

    _proc.on('error', err => {
      console.warn('[Cloudflare Tunnel] Process error:', err.message);
      if (!done) { done = true; resolve(null); }
    });

    // Give up waiting after 30 seconds
    setTimeout(() => {
      if (!done) {
        done = true;
        console.warn('[Cloudflare Tunnel] Timed out waiting for URL — falling back to LAN');
        resolve(null);
      }
    }, 30_000);
  });
}

/** Kill all cloudflared processes by name — handles orphans from prior restarts. */
function killAllCloudflared() {
  if (process.platform === 'win32') {
    // /T kills the whole process tree (cmd.exe shell + cloudflared child + conhost)
    spawnSync('taskkill', ['/F', '/T', '/IM', 'cloudflared.exe'], { windowsHide: true });
  } else {
    spawnSync('pkill', ['-f', 'cloudflared'], {});
  }
}

/** Stop the running tunnel (called on server shutdown or restart). */
export function stopCloudflareTunnel() {
  _url  = null;
  if (_proc) {
    // Kill the whole tree so cmd.exe shell + conhost don't linger on Windows
    if (process.platform === 'win32' && _proc.pid) {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(_proc.pid)], { windowsHide: true });
    } else {
      _proc.kill();
    }
    _proc = null;
  }
  // Always nuke any orphaned cloudflared from prior runs
  killAllCloudflared();
}

#!/usr/bin/env node
// PAN Installer — compiled to a self-contained .exe by @yao-pkg/pkg
// Zero dependencies: uses only built-in Node.js APIs.
//
// Config is encoded in the exe's own filename:
//   pan-[base64url(JSON({h:"hub-host",t:"token"}))].exe
//
// Flow:
//   1. Read config from own filename
//   2. Download Node.js v22 portable to %LOCALAPPDATA%\PAN-Client\node\
//   3. Download pan-client.js from hub
//   4. npm install ws
//   5. Write config file
//   6. Create startup task (Windows) or systemd service (Linux)
//   7. Launch client
'use strict';

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const cp     = require('child_process');
const { promisify } = require('util');

const IS_WIN   = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const IS_MAC   = process.platform === 'darwin';

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(`\n  ${msg}`); }
function ok(msg)  { process.stdout.write(`  ✓ ${msg}\n`); }
function err(msg) { process.stdout.write(`\n  ✗ ${msg}\n`); }

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    function get(u) {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'PAN-Installer/1.0' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${u}`));
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          process.stdout.write(`\r  Downloading... ${(bytes / 1_048_576).toFixed(1)} MB`);
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    }
    get(url);
  });
}

function run(cmd, cwd, opts = {}) {
  return cp.execSync(cmd, { cwd, stdio: 'pipe', windowsHide: true, ...opts });
}

// ── Read config from own filename ────────────────────────────────────────────

function readConfig() {
  const exe = path.basename(process.argv[0] || process.execPath);
  // Expected: pan-[base64url].exe or pan-[base64url] (linux)
  const match = exe.match(/^pan-([A-Za-z0-9_-]+?)(?:\.exe)?$/);
  if (!match) {
    err('Could not read install config from filename.');
    err(`Expected filename like: pan-[code].exe  Got: ${exe}`);
    pause(); process.exit(1);
  }
  try {
    const json = Buffer.from(match[1], 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    err('Install code is invalid or corrupted. Please generate a new invite link.');
    pause(); process.exit(1);
  }
}

function pause() {
  if (IS_WIN) {
    try { cp.execSync('pause', { stdio: 'inherit', windowsHide: false, shell: true }); } catch {}
  } else {
    process.stdout.write('\nPress Enter to exit...');
    try { cp.execSync('read', { stdio: 'inherit', shell: true }); } catch {}
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  console.log('');
  console.log('  ██████╗  █████╗ ███╗   ██╗');
  console.log('  ██╔══██╗██╔══██╗████╗  ██║');
  console.log('  ██████╔╝███████║██╔██╗ ██║');
  console.log('  ██╔═══╝ ██╔══██║██║╚██╗██║');
  console.log('  ██║     ██║  ██║██║ ╚████║');
  console.log('  ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝');
  console.log('');
  console.log('  Personal AI Network — Device Installer');
  console.log('  ─────────────────────────────────────');

  const cfg = readConfig();
  const hubHost  = cfg.h; // e.g. "abc.trycloudflare.com"
  const token    = cfg.t;
  const proto    = cfg.s ? 'https' : 'http';
  const wsProto  = cfg.s ? 'wss'   : 'ws';
  const hubHTTP  = `${proto}://${hubHost}`;
  const hubWS    = `${wsProto}://${hubHost}`;
  const deviceId = os.hostname();

  log(`Connecting to: ${hubHTTP}`);
  console.log('');

  // ── Paths ─────────────────────────────────────────────────────────────────
  const panDir  = IS_WIN
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'PAN-Client')
    : path.join(os.homedir(), '.local', 'share', 'pan-client');
  const nodeDir = path.join(panDir, 'node');
  const dataDir = path.join(panDir, 'data');

  for (const d of [panDir, nodeDir, dataDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  // ── Node.js ───────────────────────────────────────────────────────────────
  const nodeExe = IS_WIN
    ? path.join(nodeDir, 'node.exe')
    : path.join(nodeDir, 'bin', 'node');
  const npmCmd  = IS_WIN
    ? path.join(nodeDir, 'npm.cmd')
    : path.join(nodeDir, 'bin', 'npm');

  if (!fs.existsSync(nodeExe)) {
    log('Downloading Node.js...');
    const NODE_VER  = '22.16.0';
    const arch      = process.arch === 'arm64' ? 'arm64' : 'x64';
    const nodeURL   = IS_WIN
      ? `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-win-${arch}.zip`
      : IS_MAC
        ? `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-darwin-${arch}.tar.xz`
        : `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-${arch}.tar.xz`;

    const tmpArchive = path.join(os.tmpdir(), IS_WIN ? 'pan-node.zip' : 'pan-node.tar.xz');
    await download(nodeURL, tmpArchive);
    console.log('');

    log('Extracting Node.js...');
    if (IS_WIN) {
      run(
        `powershell -NoProfile -Command "Expand-Archive -Force '${tmpArchive}' '${os.tmpdir()}\\pan-node-extract'"`,
        panDir, { shell: true }
      );
      const extracted = fs.readdirSync(path.join(os.tmpdir(), 'pan-node-extract'))[0];
      const srcDir = path.join(os.tmpdir(), 'pan-node-extract', extracted);
      for (const f of fs.readdirSync(srcDir)) {
        const src = path.join(srcDir, f), dst = path.join(nodeDir, f);
        if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
        fs.renameSync(src, dst);
      }
    } else {
      run(`tar -xJf "${tmpArchive}" -C "${nodeDir}" --strip-components=1`, panDir, { shell: true });
    }
    try { fs.unlinkSync(tmpArchive); } catch {}
    ok('Node.js ready');
  } else {
    ok('Node.js already installed');
  }

  // ── pan-client.js ─────────────────────────────────────────────────────────
  const clientPath = path.join(panDir, 'pan-client.js');
  log('Downloading PAN client...');
  await download(`${hubHTTP}/client/pan-client.js`, clientPath);
  console.log('');

  // ── Dependencies ──────────────────────────────────────────────────────────
  log('Installing dependencies...');
  const pkgJson = path.join(panDir, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: 'pan-client', version: '1.0.0', type: 'commonjs' }));
  }
  try {
    run(`"${npmCmd}" install ws --no-audit --no-fund --save`, panDir, { shell: IS_WIN });
    ok('Dependencies installed');
  } catch (e) {
    err(`npm install failed: ${e.message}`);
    pause(); process.exit(1);
  }

  // ── Config ────────────────────────────────────────────────────────────────
  const cfgPath = path.join(panDir, 'pan-client-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    hub_ws:    hubWS,
    hub_http:  hubHTTP,
    token,
    device_id: deviceId,
    name:      deviceId,
  }, null, 2));
  ok('Config saved');

  // ── Startup task ──────────────────────────────────────────────────────────
  log('Registering startup task...');
  if (IS_WIN) {
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${nodeExe}"</Command>
      <Arguments>"${clientPath}"</Arguments>
      <WorkingDirectory>${panDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
    const xmlPath = path.join(os.tmpdir(), 'pan-task.xml');
    fs.writeFileSync(xmlPath, taskXml, 'utf16le');
    try {
      run(`schtasks /Create /TN "PAN-Client" /XML "${xmlPath}" /F`, panDir, { shell: true });
      ok('Startup task created (runs at login)');
    } catch {
      err('Could not create startup task — you may need to run as Administrator');
    }
    try { fs.unlinkSync(xmlPath); } catch {}
  } else {
    // Linux: systemd user service
    const svcDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    if (!fs.existsSync(svcDir)) fs.mkdirSync(svcDir, { recursive: true });
    fs.writeFileSync(path.join(svcDir, 'pan-client.service'), `[Unit]
Description=PAN Client
After=network.target

[Service]
ExecStart=${nodeExe} ${clientPath}
WorkingDirectory=${panDir}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`);
    try {
      run('systemctl --user daemon-reload && systemctl --user enable pan-client.service && systemctl --user start pan-client.service', panDir, { shell: true });
      ok('Systemd service enabled and started');
    } catch {
      // Fallback: just launch it in background
      cp.spawn(nodeExe, [clientPath], { cwd: panDir, detached: true, stdio: 'ignore' }).unref();
      ok('Client started (no systemd — running in background)');
    }
  }

  // ── Launch ────────────────────────────────────────────────────────────────
  log('Starting PAN client...');
  if (IS_WIN) {
    cp.spawn(nodeExe, [clientPath], {
      cwd: panDir, detached: true, stdio: 'ignore', windowsHide: false,
    }).unref();
  }

  console.log('');
  console.log('  ─────────────────────────────────────');
  console.log('  ✓ PAN installed successfully!');
  console.log(`  ✓ Connected to: ${hubHTTP}`);
  console.log('  ✓ Runs automatically at login');
  console.log('');
  console.log('  Waiting for hub owner to approve this device...');
  console.log('  You can close this window.');
  console.log('');

  // Keep window open briefly so user can read it
  await new Promise(r => setTimeout(r, 8000));
}

main().catch(e => {
  err(`Install failed: ${e.message}`);
  console.error(e);
  pause();
  process.exit(1);
});

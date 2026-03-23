// PAN System Tray Agent
// Runs in user session, shows tray icon, polls for commands, shows notifications
// This replaces pan-agent.ps1

const http = require('http');
const https = require('https');
const { exec, execFile, spawn } = require('child_process');
const notifier = require('node-notifier');
const os = require('os');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const PAN_URL = 'http://127.0.0.1:7777';
const POLL_INTERVAL = 2000;
const CLAUDE_PATH = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
const WEZTERM_PATH = 'C:\\Program Files\\WezTerm\\wezterm.exe';
const DEVICE_NAME = os.hostname();

// Check if WezTerm is available
let weztermAvailable = null;
function checkWezterm() {
  if (weztermAvailable !== null) return Promise.resolve(weztermAvailable);
  return new Promise((resolve) => {
    fs.access(WEZTERM_PATH, fs.constants.X_OK, (err) => {
      weztermAvailable = !err;
      console.log(`[PAN Tray] WezTerm available: ${weztermAvailable}`);
      resolve(weztermAvailable);
    });
  });
}
checkWezterm();

console.log(`[PAN Tray] Started on ${DEVICE_NAME}`);
console.log(`[PAN Tray] Polling ${PAN_URL} every ${POLL_INTERVAL / 1000}s`);
console.log(`[PAN Tray] Type commands here, or say "Hey PAN" on your phone`);
console.log('');

// Register this device
fetch(`${PAN_URL}/api/v1/devices/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: DEVICE_NAME,
    device_type: 'pc',
    capabilities: ['terminal', 'filesystem', 'claude']
  })
}).catch(() => {});

// Read .pan files for session lookup
function findSession(projectPath) {
  const panFile = path.join(projectPath, '.pan');
  try {
    const data = JSON.parse(fs.readFileSync(panFile, 'utf-8'));
    const claudeDir = data.claude_project_dir;
    if (!claudeDir) return null;

    const indexFile = path.join(claudeDir, 'sessions-index.json');
    if (!fs.existsSync(indexFile)) return null;

    const idx = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    if (idx.entries && idx.entries.length > 0) {
      return idx.entries[0].projectPath;
    }
  } catch {}
  return null;
}

// Execute actions from the queue
function handleAction(action) {
  console.log(`[PAN] Action: ${action.type} - ${JSON.stringify(action).slice(0, 100)}`);

  if (action.type === 'terminal') {
    const name = action.name || 'PAN Terminal';
    const targetPath = action.path || process.env.USERPROFILE + '\\Desktop';

    // Try to find original path for session resume
    const resumePath = findSession(targetPath) || targetPath;

    // Try WezTerm CLI first, fall back to wt.exe
    checkWezterm().then((hasWezterm) => {
      if (hasWezterm) {
        // Use WezTerm CLI to spawn a new pane
        const args = ['cli', 'spawn', '--cwd', resumePath];
        execFile(WEZTERM_PATH, args, { timeout: 10000, windowsHide: true }, (err, stdout) => {
          if (err) {
            console.log(`[PAN] WezTerm spawn failed, falling back to wt.exe: ${err.message}`);
            openWithWindowsTerminal(resumePath, name, action);
            return;
          }
          const paneId = parseInt(stdout.trim(), 10);
          console.log(`[PAN] WezTerm opened pane ${paneId}: ${name} at ${resumePath}`);

          notifier.notify({ title: 'PAN', message: `Opened: ${name} (WezTerm pane ${paneId})`, sound: false });

          reportSuccess(action.id, `Opened ${name} (WezTerm pane ${paneId})`);
        });
      } else {
        openWithWindowsTerminal(resumePath, name, action);
      }
    });
  }

  function openWithWindowsTerminal(resumePath, name, action) {
    const batPath = path.join(os.tmpdir(), `pan-t-${action.id || Date.now()}.bat`);
    fs.writeFileSync(batPath, `@echo off\ncd /d "${resumePath}"\necho === ${name} ===\n"${CLAUDE_PATH}" --continue\n`, 'ascii');

    spawn('wt.exe', [batPath], { detached: true, stdio: 'ignore', shell: true }).unref();

    notifier.notify({ title: 'PAN', message: `Opened: ${name}`, sound: false });
    console.log(`[PAN] Opened terminal (wt.exe): ${name} at ${resumePath}`);

    reportSuccess(action.id, `Opened ${name}`);
  }

  function reportSuccess(actionId, result) {
    if (actionId) {
      fetch(`${PAN_URL}/api/v1/devices/commands/${actionId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', result })
      }).catch(() => {});
    }
  }

  if (action.type === 'command') {
    const cmd = action.command;
    console.log(`[PAN] Executing: ${cmd}`);

    exec(`powershell.exe -Command "${cmd.replace(/"/g, '\\"')}"`, (err, stdout, stderr) => {
      const success = !err;
      const result = success ? (stdout || 'Done').trim() : (stderr || err.message).trim();

      console.log(`[PAN] ${success ? 'OK' : 'FAIL'}: ${result.slice(0, 100)}`);

      notifier.notify({
        title: success ? 'PAN - Done' : 'PAN - Failed',
        message: result.slice(0, 200),
        sound: !success
      });

      if (action.id) {
        fetch(`${PAN_URL}/api/v1/devices/commands/${action.id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: success ? 'completed' : 'failed',
            result: result.slice(0, 1000)
          })
        }).catch(() => {});
      }
    });
  }
}

// Poll for actions
async function poll() {
  try {
    const res = await fetch(`${PAN_URL}/api/v1/actions`);
    const actions = await res.json();
    for (const action of actions) {
      handleAction(action);
    }
  } catch {}
}

setInterval(poll, POLL_INTERVAL);

// Interactive command input from this terminal
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt('PAN> ');
rl.prompt();

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) { rl.prompt(); return; }

  if (text === 'status') {
    try {
      const res = await fetch(`${PAN_URL}/api/v1/stats`);
      const stats = await res.json();
      console.log('PAN Stats:', JSON.stringify(stats, null, 2));
    } catch (e) {
      console.log('Cannot reach PAN service');
    }
  } else if (text === 'devices') {
    try {
      const res = await fetch(`${PAN_URL}/api/v1/devices/list`);
      const devices = await res.json();
      for (const d of devices) {
        console.log(`  ${d.name} (${d.hostname}) - ${d.device_type} - last seen: ${d.last_seen}`);
      }
    } catch (e) {
      console.log('Cannot reach PAN service');
    }
  } else if (text === 'commands' || text === 'history') {
    try {
      const res = await fetch(`${PAN_URL}/api/v1/devices/commands/history`);
      const cmds = await res.json();
      for (const c of cmds) {
        const status = c.status === 'completed' ? '✓' : c.status === 'failed' ? '✗' : '⋯';
        console.log(`  ${status} [${c.command_type}] ${c.text || c.command || ''} (${c.status})`);
      }
    } catch (e) {
      console.log('Cannot reach PAN service');
    }
  } else if (text === 'help') {
    console.log('Commands: status, devices, commands, help, or type any text to send as a PAN command');
  } else {
    // Send as a PAN query
    try {
      const res = await fetch(`${PAN_URL}/api/v1/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const result = await res.json();
      console.log(`[${result.intent}] ${result.response_text}`);
    } catch (e) {
      console.log('Cannot reach PAN service');
    }
  }

  rl.prompt();
});

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const os = require('os');

const PAN_URL = 'http://127.0.0.1:7777';
const CONFIG_PATH = path.join(app.getPath('userData'), 'pan-config.json');
const CLAUDE_PATH = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');

let tray = null;
let setupWindow = null;
let commandsWindow = null;
let config = { deviceName: '', setupDone: false };

// Load config
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {}
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Register device with PAN service
async function registerDevice() {
  try {
    await fetch(`${PAN_URL}/api/v1/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: config.deviceName || os.hostname(),
        device_type: 'pc',
        capabilities: ['terminal', 'filesystem', 'claude']
      })
    });
  } catch {}
}

// Poll for pending actions
async function pollActions() {
  try {
    const res = await fetch(`${PAN_URL}/api/v1/actions`);
    const actions = await res.json();

    for (const action of actions) {
      handleAction(action);
    }
  } catch {}
}

function handleAction(action) {
  console.log(`[PAN Tray] Action received: ${action.type} - ${JSON.stringify(action).slice(0, 100)}`);

  if (action.type === 'terminal') {
    const name = action.name || 'PAN Terminal';
    const targetPath = action.path || path.join(os.homedir(), 'Desktop');

    // Find original path for session resume
    let resumePath = targetPath;
    const panFile = path.join(targetPath, '.pan');
    try {
      const panData = JSON.parse(fs.readFileSync(panFile, 'utf-8'));
      if (panData.claude_project_dir) {
        const indexFile = path.join(panData.claude_project_dir, 'sessions-index.json');
        if (fs.existsSync(indexFile)) {
          const idx = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
          if (idx.entries && idx.entries.length > 0 && fs.existsSync(idx.entries[0].projectPath)) {
            resumePath = idx.entries[0].projectPath;
          }
        }
      }
    } catch {}

    const batPath = path.join(os.tmpdir(), `pan-t-${Date.now()}.bat`);
    fs.writeFileSync(batPath, `@echo off\ncd /d "${resumePath}"\necho === ${name} ===\n"${CLAUDE_PATH}" --continue\n`, 'ascii');
    spawn('wt.exe', [batPath], { detached: true, stdio: 'ignore', shell: true }).unref();

    updateTrayTooltip(`Opened: ${name}`);
  }

  if (action.type === 'ui_automation') {
    console.log(`[PAN Tray] UI automation: ${action.command}`);
    const uiScript = path.join(__dirname, '..', 'src', 'ui-automation.py');
    const parts = action.command.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);

    const { execFile } = require('child_process');
    console.log(`[PAN Tray] Executing: python ${uiScript} ${cmd} ${args.join(' ')}`);
    execFile('python', [uiScript, cmd, ...args], {
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        result = { ok: false, error: err?.message || stderr || 'parse error' };
      }

      // Send result back to server
      fetch(`${PAN_URL}/api/v1/ui/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: action.id, result })
      }).catch(() => {});

      console.log(`[PAN UI] ${cmd}: ${result.ok ? 'OK' : result.error}`);
    });
  }

  if (action.type === 'command') {
    exec(`powershell.exe -Command "${action.command.replace(/"/g, '\\"')}"`, (err, stdout, stderr) => {
      const result = err ? (stderr || err.message) : (stdout || 'Done');
      updateTrayTooltip(result.trim().slice(0, 50));

      if (action.id) {
        fetch(`${PAN_URL}/api/v1/devices/commands/${action.id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: err ? 'failed' : 'completed',
            result: result.trim().slice(0, 1000)
          })
        }).catch(() => {});
      }
    });
  }
}

function updateTrayTooltip(text) {
  if (tray) tray.setToolTip(`ΠΑΝ — ${config.deviceName}\n${text}`);
}

// Create tray icon by rendering it offscreen
async function generateTrayIcon() {
  const iconWin = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  });

  await iconWin.loadFile(path.join(__dirname, 'icon-render.html'));

  // Wait for render
  await new Promise(r => setTimeout(r, 500));

  const image = await iconWin.webContents.capturePage();
  const resized = image.resize({ width: 32, height: 32 });

  // Save for reuse
  const pngPath = path.join(__dirname, 'pan-icon.png');
  fs.writeFileSync(pngPath, resized.toPNG());

  iconWin.close();
  return resized;
}

function createTray() {
  const pngPath = path.join(__dirname, 'pan-icon.png');

  if (fs.existsSync(pngPath)) {
    tray = new Tray(pngPath);
  } else {
    // Temporary empty icon — will be replaced after generation
    tray = new Tray(nativeImage.createFromBuffer(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABhSURBVFhH7c4xDQAgDETRsgFLOMAEJpCABSTgAAn4oKGBhLn8ZC75mqsxxhhjbKD+e2CM0d4+mtc5Z3v7aF7nnO3to3mdc7a3j+Z1ztneHmOMMcYYY4wxxhhjjDF2tUvuA9Rw0J5mxiwAAAAASUVORK5CYII=', 'base64')
    ));

    // Generate proper icon in background
    generateTrayIcon().then(icon => {
      if (tray) tray.setImage(icon);
    }).catch(() => {});
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: `ΠΑΝ — ${config.deviceName}`, enabled: false },
    { type: 'separator' },
    { label: 'Dashboard', click: () => showDashboard() },
    { label: 'Open ΠΑΝ Folder', click: () => {
      exec('explorer "' + path.join(os.homedir(), 'OneDrive', 'Desktop', 'PAN') + '"');
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);

  tray.setToolTip(`PAN - ${config.deviceName}`);
  tray.setContextMenu(contextMenu);
}

// Setup window
function showSetup() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }

  const iconPath = path.join(__dirname, 'pan-icon.png');
  setupWindow = new BrowserWindow({
    width: 600,
    height: 450,
    resizable: false,
    frame: true,
    title: 'PAN Setup',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  setupWindow.loadFile(path.join(__dirname, 'setup.html'));

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

// Dashboard window — loads web UI from PAN server
let dashboardWindow = null;
function showDashboard() {
  if (dashboardWindow) {
    dashboardWindow.focus();
    return;
  }

  const iconPath = path.join(__dirname, 'pan-icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
  dashboardWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'ΠΑΝ Dashboard',
    icon: icon,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  // Remove default menu (File/Edit/View/Window), keep just Help
  const { Menu: AppMenu } = require('electron');
  const dashMenu = AppMenu.buildFromTemplate([
    {
      label: 'Help',
      submenu: [
        { label: 'About ΠΑΝ', click: () => { require('electron').shell.openExternal('https://github.com/tereseus/pan'); } },
        { type: 'separator' },
        { label: 'Open DevTools', click: () => { dashboardWindow?.webContents.openDevTools(); } }
      ]
    }
  ]);
  dashboardWindow.setMenu(dashMenu);

  dashboardWindow.loadURL(`${PAN_URL}/dashboard/`);
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

// Commands window
function showCommands() {
  if (commandsWindow) {
    commandsWindow.focus();
    return;
  }

  const iconPath2 = path.join(__dirname, 'pan-icon.png');
  commandsWindow = new BrowserWindow({
    width: 500,
    height: 600,
    title: 'PAN Commands',
    icon: fs.existsSync(iconPath2) ? iconPath2 : undefined,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  commandsWindow.loadFile(path.join(__dirname, 'commands.html'));
  commandsWindow.on('closed', () => { commandsWindow = null; });
}

// IPC handlers
ipcMain.on('get-config', (event) => {
  event.returnValue = config;
});

ipcMain.on('save-device-name', (event, name) => {
  config.deviceName = name;
  config.setupDone = true;
  saveConfig();
  registerDevice();

  if (tray) {
    tray.setToolTip(`PAN - ${config.deviceName}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `ΠΑΝ — ${config.deviceName}`, enabled: false },
      { type: 'separator' },
      { label: 'Dashboard', click: () => showDashboard() },
      { label: 'Open ΠΑΝ Folder', click: () => {
        exec('explorer "' + path.join(os.homedir(), 'OneDrive', 'Desktop', 'PAN') + '"');
      }},
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]));
  }

  if (setupWindow) setupWindow.close();
  event.returnValue = true;
});

// App lifecycle
app.whenReady().then(() => {
  loadConfig();

  if (!config.setupDone) {
    showSetup();
  }

  if (!config.deviceName) {
    config.deviceName = os.hostname();
  }

  createTray();
  registerDevice();

  // Auto-open dashboard on start
  showDashboard();

  // Start polling
  setInterval(pollActions, 2000);

  // Hide dock icon on macOS (tray-only app)
  if (process.platform === 'darwin') app.dock.hide();
});

app.on('window-all-closed', (e) => {
  // Don't quit when windows close — keep tray running
  e.preventDefault?.();
});

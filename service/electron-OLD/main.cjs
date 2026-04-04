const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const os = require('os');

app.setAppUserModelId('dev.pan.app');

const PAN_URL = 'http://127.0.0.1:7777';
const CONFIG_PATH = path.join(app.getPath('userData'), 'pan-config.json');
const CLAUDE_PATH = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');

// File-based debug log so we can diagnose polling issues
const LOG_PATH = path.join(os.tmpdir(), 'pan-electron-debug.log');
function debugLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}
debugLog(`=== Electron starting === PID=${process.pid} SESSIONNAME=${process.env.SESSIONNAME}`);

// ==================== Window Registry ====================
// Every window gets a unique ID. Claude can list, screenshot, focus, close any window by ID.
const windowRegistry = new Map(); // id -> { win: BrowserWindow, url, title, createdAt }
let nextWindowId = 1;

function registerWindow(win, url, title) {
  const id = `win-${nextWindowId++}`;
  windowRegistry.set(id, { win, url, title, createdAt: new Date().toISOString() });
  win.on('closed', () => windowRegistry.delete(id));
  console.log(`[PAN Windows] Registered ${id}: ${title} (${url})`);
  return id;
}

function getWindowList() {
  const list = [];
  for (const [id, entry] of windowRegistry) {
    if (entry.win.isDestroyed()) { windowRegistry.delete(id); continue; }
    list.push({
      id,
      title: entry.title,
      url: entry.win.webContents.getURL(),
      visible: entry.win.isVisible(),
      focused: entry.win.isFocused(),
      bounds: entry.win.getBounds(),
      createdAt: entry.createdAt,
    });
  }
  return list;
}

async function screenshotWindow(windowId) {
  const entry = windowId ? windowRegistry.get(windowId) : null;
  let target;
  if (entry && !entry.win.isDestroyed()) {
    target = entry.win;
  } else {
    // Fallback: find any visible window
    const allWindows = BrowserWindow.getAllWindows().filter(w => w.isVisible() && !w.isDestroyed());
    target = allWindows.find(w => (w.webContents.getURL() || '').includes('7781'))
      || allWindows.find(w => (w.webContents.getURL() || '').includes('/v2/'))
      || allWindows[0];
  }
  if (!target) return { ok: false, error: 'No window found' };

  try {
    const image = await target.webContents.capturePage();
    const screenshotDir = path.join(os.tmpdir(), 'pan-clipboard');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, `screenshot_${Date.now()}.png`);
    fs.writeFileSync(screenshotPath, image.toPNG());
    console.log(`[PAN Windows] Screenshot saved: ${screenshotPath} (${image.getSize().width}x${image.getSize().height})`);
    return { ok: true, path: screenshotPath, url: target.webContents.getURL(), width: image.getSize().width, height: image.getSize().height };
  } catch (err) {
    console.error(`[PAN Windows] capturePage failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

// Single instance lock — if PAN is already running, focus the existing window
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

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
let pollCount = 0;
async function pollActions() {
  pollCount++;
  if (pollCount <= 3 || pollCount % 30 === 0) {
    debugLog(`pollActions called (#${pollCount}), fetching ${PAN_URL}/api/v1/actions`);
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${PAN_URL}/api/v1/actions`, { signal: controller.signal });
    clearTimeout(timeout);
    const actions = await res.json();
    if (pollCount <= 3) debugLog(`pollActions: response status=${res.status}, actions=${actions.length}`);
    if (actions.length > 0) {
      debugLog(`pollActions: got ${actions.length} actions: ${actions.map(a => a.type).join(', ')}`);
    }

    for (const action of actions) {
      try {
        debugLog(`handleAction: ${action.type} ${JSON.stringify(action).slice(0, 200)}`);
        await handleAction(action);
        debugLog(`handleAction: ${action.type} completed`);
      } catch (err) {
        debugLog(`handleAction FAILED: ${action.type} — ${err.stack}`);
        console.error(`[PAN Actions] handleAction failed for ${action.type}:`, err.message);
      }
    }
  } catch (err) {
    debugLog(`pollActions FAILED: ${err.message} ${err.stack}`);
    console.error(`[PAN Actions] pollActions failed:`, err.message);
  }
}

async function handleAction(action) {
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
      timeout: 30000,
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

  if (action.type === 'open_window') {
    const url = action.url;
    if (!url) return;
    const title = action.title || 'PAN Window';
    const width = action.width || 1200;
    const height = action.height || 800;

    const iconPath = path.join(__dirname, 'pan-icon.png');
    const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
    const win = new BrowserWindow({
      width, height, title, icon,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    win.loadURL(url);
    // Force title to stick — override the page's <title> tag
    win.on('page-title-updated', (e) => { e.preventDefault(); });
    win.setTitle(title);
    win.once('ready-to-show', () => {
      win.setTitle(title);
      if (action.maximize) win.maximize();
      win.focus();
    });
    const winId = registerWindow(win, url, title);

    // Report back so caller knows the window ID
    fetch(`${PAN_URL}/api/v1/windows/opened`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id: winId, title, url })
    }).catch(err => console.error(`[PAN Windows] opened POST failed:`, err.message));

    updateTrayTooltip(`Opened: ${title}`);
  }

  // List all tracked windows
  if (action.type === 'list_windows') {
    const list = getWindowList();
    fetch(`${PAN_URL}/api/v1/windows/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, windows: list })
    }).catch(err => console.error(`[PAN Windows] list POST failed:`, err.message));
  }

  // Screenshot a specific window by ID (or best guess)
  if (action.type === 'screenshot_window' || action.type === 'screenshot') {
    const result = await screenshotWindow(action.windowId);
    fetch(`${PAN_URL}/api/v1/screenshot/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    }).catch(err => console.error(`[PAN Windows] screenshot POST failed:`, err.message));
  }

  // Focus a specific window
  if (action.type === 'focus_window') {
    const entry = windowRegistry.get(action.windowId);
    if (entry && !entry.win.isDestroyed()) {
      if (entry.win.isMinimized()) entry.win.restore();
      entry.win.focus();
      entry.win.moveTop();
    }
  }

  // Close a specific window
  if (action.type === 'close_window') {
    const entry = windowRegistry.get(action.windowId);
    if (entry && !entry.win.isDestroyed()) {
      entry.win.close();
    }
  }

  if (action.type === 'dev_dashboard') {
    showDevDashboard(action.port || 7780);
    updateTrayTooltip('Dev Dashboard opened');
  }

  if (action.type === 'project_runner') {
    const projectPath = action.path;
    if (!projectPath) return;

    // Open a new Electron window for the project runner
    const runnerScript = path.join(__dirname, 'open-project-runner.cjs');
    spawn(process.execPath, [runnerScript, projectPath], {
      detached: true, stdio: 'ignore'
    }).unref();

    updateTrayTooltip(`Runner: ${action.name || projectPath}`);
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
      exec('explorer "' + path.resolve(path.join(__dirname, '..', '..')) + '"');
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

  const icoPath = path.join(__dirname, 'pan-icon.ico');
  const pngPath = path.join(__dirname, 'pan-icon.png');
  const iconFile = fs.existsSync(icoPath) ? icoPath : pngPath;
  const icon = fs.existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : undefined;
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

  registerWindow(dashboardWindow, `${PAN_URL}/v2/`, 'ΠΑΝ Dashboard');
  dashboardWindow.loadURL(`${PAN_URL}/v2/`).catch(err => {
    console.error('[PAN Electron] loadURL failed:', err.message);
  });
  dashboardWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[PAN Electron] did-fail-load:', errorCode, errorDescription, validatedURL);
  });
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

// Dev dashboard window — loads from Vite dev server for testing UI changes
let devWindow = null;
function showDevDashboard(port) {
  port = port || 5173;
  if (devWindow) {
    try {
      if (devWindow.isDestroyed()) { devWindow = null; }
      else { devWindow.focus(); return; }
    } catch { devWindow = null; }
  }

  const iconPath = path.join(__dirname, 'pan-icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
  devWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'ΠΑΝ Dashboard [DEV]',
    icon: icon,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  const { Menu: AppMenu } = require('electron');
  devWindow.setMenu(AppMenu.buildFromTemplate([
    {
      label: 'Dev',
      submenu: [
        { label: 'Open DevTools', click: () => { devWindow?.webContents.openDevTools(); } },
        { label: 'Reload', click: () => { devWindow?.webContents.reload(); } }
      ]
    }
  ]));

  devWindow.loadURL(`http://localhost:${port}/v2/terminal`);
  devWindow.on('closed', () => { devWindow = null; });
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
        exec('explorer "' + path.resolve(path.join(__dirname, '..', '..')) + '"');
      }},
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]));
  }

  if (setupWindow) setupWindow.close();
  event.returnValue = true;
});

// When a second instance launches, focus the existing dashboard
app.on('second-instance', () => {
  if (dashboardWindow) {
    if (dashboardWindow.isMinimized()) dashboardWindow.restore();
    dashboardWindow.focus();
  } else {
    showDashboard();
  }
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
  debugLog('Starting pollActions interval (2s)');
  pollActions(); // immediate first poll
  setInterval(pollActions, 2000);

  // Hide dock icon on macOS (tray-only app)
  if (process.platform === 'darwin') app.dock.hide();
});

app.on('window-all-closed', (e) => {
  // Don't quit when windows close — keep tray running
  e.preventDefault?.();
});

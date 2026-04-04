// Opens the PRE-based terminal renderer in an Electron window
// Usage: npx electron open-pre-terminal.cjs [port]
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const PORT = process.argv[2] || 7780;

app.whenReady().then(() => {
  const iconPath = path.join(__dirname, 'electron', 'pan-icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `PAN Terminal — PRE Renderer (:${PORT})`,
    icon: icon,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  win.loadURL(`http://127.0.0.1:${PORT}/terminal-pre.html?session=pre-test&project=PAN&cwd=C:\\Users\\tzuri\\Desktop\\PAN`);
  win.on('closed', () => app.quit());
});

#!/usr/bin/env node
// Opens a Project Runner Electron window for a specific project
// Usage: npx electron open-project-runner.cjs <project-path>
// Or:    npx electron open-project-runner.cjs --name "PAN-ATC"

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const PAN_URL = 'http://127.0.0.1:7777';

// Parse args
let projectPath = null;
let projectName = null;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--name' && args[i + 1]) {
    projectName = args[++i];
  } else if (!args[i].startsWith('--')) {
    projectPath = args[i];
  }
}

async function resolveProject() {
  if (projectPath) return projectPath;

  if (projectName) {
    try {
      const res = await fetch(`${PAN_URL}/api/v1/runner/projects`);
      const projects = await res.json();
      const match = projects.find(p =>
        p.name.toLowerCase() === projectName.toLowerCase()
      );
      if (match) return match.path;
    } catch {}
  }

  console.error('Usage: npx electron open-project-runner.cjs <project-path>');
  console.error('   Or: npx electron open-project-runner.cjs --name "PAN-ATC"');
  app.quit();
  return null;
}

async function createWindow(projPath) {
  let panData = {};
  try {
    panData = JSON.parse(fs.readFileSync(path.join(projPath, '.pan'), 'utf-8'));
  } catch {}

  const runnerConfig = panData.runner || {};
  const title = runnerConfig.title || `${panData.project_name || 'Project'} - Runner`;
  const width = runnerConfig.width || 1000;
  const height = runnerConfig.height || 700;

  const iconPath = path.join(__dirname, '..', 'PAN', 'service', 'electron', 'pan-icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  const win = new BrowserWindow({
    width, height, title, icon,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  const { Menu } = require('electron');
  win.setMenu(Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        { label: 'Reload', click: () => win.webContents.reload() },
        { label: 'DevTools', click: () => win.webContents.openDevTools() }
      ]
    }
  ]));

  const url = `${PAN_URL}/runner.html?path=${encodeURIComponent(projPath)}`;
  await win.loadURL(url);

  win.on('closed', () => app.quit());
}

app.whenReady().then(async () => {
  const projPath = await resolveProject();
  if (projPath) await createWindow(projPath);
});

app.on('window-all-closed', () => app.quit());

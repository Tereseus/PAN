#!/usr/bin/env node
// Installs PAN as a Windows service that auto-starts on boot

import { Service } from 'node-windows';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const svc = new Service({
  name: 'PAN',
  description: 'PAN — Personal AI Network. Persistent intelligence layer.',
  script: join(__dirname, 'pan.js'),
  scriptOptions: 'start',
  nodeOptions: [],
  env: [
    { name: 'ANTHROPIC_API_KEY', value: process.env.ANTHROPIC_API_KEY || '' },
    { name: 'USERPROFILE', value: process.env.USERPROFILE || 'C:\\Users\\tzuri' },
    { name: 'HOME', value: process.env.USERPROFILE || 'C:\\Users\\tzuri' },
    { name: 'APPDATA', value: process.env.APPDATA || 'C:\\Users\\tzuri\\AppData\\Roaming' },
    { name: 'LOCALAPPDATA', value: process.env.LOCALAPPDATA || 'C:\\Users\\tzuri\\AppData\\Local' },
    { name: 'PATH', value: process.env.PATH || '' }
  ]
});

const action = process.argv[2] || 'install';

svc.on('install', () => {
  console.log('[PAN] Service installed. Starting...');
  svc.start();
});

svc.on('start', () => {
  console.log('[PAN] Service started.');
});

svc.on('uninstall', () => {
  console.log('[PAN] Service uninstalled.');
});

svc.on('error', (err) => {
  console.error('[PAN] Service error:', err);
});

if (action === 'uninstall') {
  svc.uninstall();
} else {
  svc.install();
}

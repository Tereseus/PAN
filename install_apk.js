const { spawn } = require('child_process');
const path = require('path');

const cmdExe = 'C:\\Windows\\System32\\cmd.exe';
const apkPath = 'C:\\Users\\tzuri\\Desktop\\PAN\\android\\app\\build\\outputs\\apk\\debug\\app-debug.apk';

// Find adb
const adbPaths = [
  process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe',
  process.env.APPDATA + '\\..\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
  'C:\\Users\\tzuri\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
];

const fs = require('fs');
let adb = null;
for (const p of adbPaths) {
  try { fs.accessSync(p); adb = p; break; } catch(e) {}
}

if (!adb) {
  console.error('adb not found. Tried:', adbPaths);
  process.exit(1);
}

console.log('Using adb:', adb);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(adb, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { err += d; process.stderr.write(d); });
    child.on('close', code => resolve({ code, out, err }));
    child.on('error', reject);
  });
}

async function main() {
  console.log('Checking devices...');
  const { out } = await run(['devices']);
  if (!out.includes('device\n') && !out.includes('device\r')) {
    console.error('No device connected. Connect phone via USB or ensure ADB over WiFi/Tailscale.');
    process.exit(1);
  }

  console.log('\nInstalling APK...');
  const result = await run(['install', '-r', apkPath]);
  if (result.code === 0) {
    console.log('\nInstall successful!');
  } else {
    console.error('\nInstall failed with code:', result.code);
    process.exit(result.code);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

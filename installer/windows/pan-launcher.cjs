// PAN's launcher on an installed computer. Started at logon (and by PAN Setup) as
//     conhost.exe --headless <node.exe> pan-launcher.cjs <install folder>
// so nothing shows on screen. It keeps pan-link and PAN running and writes what it does to
// <data>\launcher.log. What it starts is decided in launch-plan.cjs.
//
// One launcher per install folder: a second one sees the first one's pid file and leaves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { launchPlan, restartDelayMs } = require('./launch-plan.cjs');

const installDir = process.argv[2];
if (!installDir) {
  console.error('usage: pan-launcher.cjs <install folder>');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(path.join(installDir, 'install.json'), 'utf8').replace(/^﻿/, ''));
const plan = launchPlan(config, os.hostname(), process.env);
fs.mkdirSync(plan.dataDir, { recursive: true });

const logPath = path.join(plan.dataDir, 'launcher.log');
function log(line) {
  try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`); } catch {}
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const pidPath = path.join(plan.dataDir, 'launcher.pid');
try {
  const other = parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
  if (other && other !== process.pid && alive(other)) {
    log(`another launcher is running (pid ${other}), leaving`);
    process.exit(0);
  }
} catch {}
fs.writeFileSync(pidPath, String(process.pid));

let stopping = false;
const children = new Map();

function start(prog, quickDeaths = 0) {
  if (stopping) return;
  const out = fs.openSync(prog.log, 'a');
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(prog.exe, prog.args, {
      cwd: prog.cwd, env: prog.env, windowsHide: true, stdio: ['ignore', out, out],
    });
  } catch (e) {
    log(`${prog.name}: could not start: ${e.message}`);
    fs.closeSync(out);
    setTimeout(() => start(prog, quickDeaths + 1), restartDelayMs(quickDeaths + 1));
    return;
  }
  fs.closeSync(out);
  children.set(prog.name, child);
  log(`${prog.name}: started, pid ${child.pid}`);
  child.on('error', (e) => log(`${prog.name}: ${e.message}`));
  child.on('exit', (code) => {
    children.delete(prog.name);
    if (stopping) return;
    const ranMs = Date.now() - startedAt;
    if (code === 0 && !prog.restartOnCleanExit) {
      log(`${prog.name}: stopped cleanly, not starting it again`);
      if (children.size === 0 || prog.name === 'PAN') shutdown(0);
      return;
    }
    const deaths = ranMs < 30000 ? quickDeaths + 1 : 0;
    const wait = restartDelayMs(deaths);
    log(`${prog.name}: left with code ${code} after ${Math.round(ranMs / 1000)} s, again in ${wait / 1000} s`);
    setTimeout(() => start(prog, deaths), wait);
  });
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  log('launcher stopping');
  for (const child of children.values()) {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
  try { fs.unlinkSync(pidPath); } catch {}
  setTimeout(() => process.exit(code), 1500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

log(`launcher ${process.pid} for ${installDir}, version ${config.version}`);
start(plan.link);
start(plan.pan);

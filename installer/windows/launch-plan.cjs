// What PAN's launcher starts on an installed computer, worked out from install.json.
// A pure rule (no files, no processes), so it is tested: launch-plan.test.cjs.
//
// These run for as long as the person is logged in:
//   pan-link  the way in for the person's phone and other computers
//   PAN       the service itself, on this computer's own address only
//   Ollama    the program that runs the models, when PAN Setup installed voice
//             (install.json "ollama"). Only when nothing answers on its port already:
//             a person's own Ollama, or Ollama's own tray app, is left to do the job.
//
// install.json is written by pan-setup.ps1 (Windows) or pan-setup.sh (Linux). The same plan
// serves both: only the folder layout of the bundle differs (node.exe and pan-link.exe on
// Windows, node/bin/node and pan-link on Linux).

const path = require('path');

const DEFAULTS = {
  port: 7777,           // PAN (Super-Carrier)
  carrierPort: 17760,
  craftPortBase: 17700,
  linkPort: 41720,      // pan-link, UDP, the only port other devices reach
  linkAdmin: '127.0.0.1:7792',
};

function need(value, what) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`install.json has no ${what}`);
  }
  return value;
}

function port(value, fallback, what) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`install.json: ${what} is not a port: ${value}`);
  return n;
}

/**
 * @param {object} config   install.json
 * @param {string} hostname this computer's name, shown on the phone when pairing
 * @param {object} baseEnv  the environment to start from (process.env)
 * @param {string} platform process.platform: 'win32', or anything else for the Linux layout
 */
function launchPlan(config, hostname, baseEnv = {}, platform = 'win32') {
  const windows = platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const installDir = need(config && config.installDir, 'installDir');
  const version = need(config.version, 'version');
  const dataDir = config.dataDir || p.join(installDir, 'data');
  const appDir = p.join(installDir, 'app', String(version));

  const panPort = port(config.port, DEFAULTS.port, 'port');
  const carrierPort = port(config.carrierPort, DEFAULTS.carrierPort, 'carrierPort');
  const craftPortBase = port(config.craftPortBase, DEFAULTS.craftPortBase, 'craftPortBase');
  const linkPort = port(config.linkPort, DEFAULTS.linkPort, 'linkPort');
  const linkAdmin = config.linkAdmin || DEFAULTS.linkAdmin;

  const node = windows ? p.join(appDir, 'node', 'node.exe') : p.join(appDir, 'node', 'bin', 'node');
  const env = { ...baseEnv };
  // An installed PAN never opens its ports to the network: other devices come in through
  // pan-link. Whatever the person's environment says, this stays shut.
  delete env.PAN_HOST;
  // PAN_DEV comes from install.json only (pan-setup.ps1 -Dev), never from the environment.
  // A dev PAN skips the parts that act on the whole computer (the steward, the orphan
  // reaper, the device heartbeat), which is what an install test beside a real PAN needs.
  delete env.PAN_DEV;
  if (config.dev === true) env.PAN_DEV = '1';
  Object.assign(env, {
    PAN_DATA_DIR: dataDir,
    PAN_PORT: String(panPort),
    PAN_CARRIER_INTERNAL_PORT: String(carrierPort),
    PAN_CRAFT_PORT_BASE: String(craftPortBase),
    PAN_LINK_ADMIN: `http://${linkAdmin}`,
    PAN_INSTALLED: '1',
  });

  return {
    dataDir,
    appDir,
    pan: {
      name: 'PAN',
      exe: node,
      args: [p.join(appDir, 'service', 'pan.js'), 'start'],
      cwd: p.join(appDir, 'service'),
      log: p.join(dataDir, 'hub.log'),
      env,
      // PAN leaves with code 0 when it was asked to stop; anything else is a crash.
      restartOnCleanExit: false,
    },
    link: {
      name: 'pan-link',
      exe: p.join(appDir, 'pan-link', windows ? 'pan-link.exe' : 'pan-link'),
      args: [
        'hub',
        '--data', dataDir,
        '--name', String(hostname || 'PAN').slice(0, 40),
        '--port', String(linkPort),
        '--backend', `http://127.0.0.1:${panPort}`,
        '--admin', linkAdmin,
      ],
      cwd: p.join(appDir, 'pan-link'),
      log: p.join(dataDir, 'pan-link.log'),
      env: baseEnv,
      restartOnCleanExit: true,
    },
    ollama: config.ollama ? {
      name: 'Ollama',
      exe: String(config.ollama),
      args: ['serve'],
      cwd: p.dirname(String(config.ollama)),
      log: p.join(dataDir, 'ollama.log'),
      env: baseEnv,
      restartOnCleanExit: true,
      onlyIfDown: 'http://127.0.0.1:11434/api/version',
    } : null,
    healthUrl: `http://127.0.0.1:${panPort}/health`,
    pairUrl: `http://127.0.0.1:${panPort}/pair/`,
  };
}

/** Wait before starting a program again: 5 s, longer when it keeps dying at once. */
function restartDelayMs(quickDeaths) {
  const n = Math.max(0, Math.min(Number(quickDeaths) || 0, 6));
  return Math.min(5000 * Math.pow(2, n), 5 * 60 * 1000);
}

module.exports = { launchPlan, restartDelayMs, DEFAULTS };

// What PAN's launcher starts on an installed computer, worked out from install.json.
// A pure rule (no files, no processes), so it is tested: launch-plan.test.cjs.
//
// Two programs run for as long as the person is logged in:
//   pan-link  the way in for the person's phone and other computers
//   PAN       the service itself, on this computer's own address only
//
// install.json is written by pan-setup.ps1.

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
 */
function launchPlan(config, hostname, baseEnv = {}) {
  const installDir = need(config && config.installDir, 'installDir');
  const version = need(config.version, 'version');
  const dataDir = config.dataDir || path.win32.join(installDir, 'data');
  const appDir = path.win32.join(installDir, 'app', String(version));

  const panPort = port(config.port, DEFAULTS.port, 'port');
  const carrierPort = port(config.carrierPort, DEFAULTS.carrierPort, 'carrierPort');
  const craftPortBase = port(config.craftPortBase, DEFAULTS.craftPortBase, 'craftPortBase');
  const linkPort = port(config.linkPort, DEFAULTS.linkPort, 'linkPort');
  const linkAdmin = config.linkAdmin || DEFAULTS.linkAdmin;

  const node = path.win32.join(appDir, 'node', 'node.exe');
  const env = { ...baseEnv };
  // An installed PAN never opens its ports to the network: other devices come in through
  // pan-link. Whatever the person's environment says, this stays shut.
  delete env.PAN_HOST;
  delete env.PAN_DEV;
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
      args: [path.win32.join(appDir, 'service', 'pan.js'), 'start'],
      cwd: path.win32.join(appDir, 'service'),
      log: path.win32.join(dataDir, 'hub.log'),
      env,
      // PAN leaves with code 0 when it was asked to stop; anything else is a crash.
      restartOnCleanExit: false,
    },
    link: {
      name: 'pan-link',
      exe: path.win32.join(appDir, 'pan-link', 'pan-link.exe'),
      args: [
        'hub',
        '--data', dataDir,
        '--name', String(hostname || 'PAN').slice(0, 40),
        '--port', String(linkPort),
        '--backend', `http://127.0.0.1:${panPort}`,
        '--admin', linkAdmin,
      ],
      cwd: path.win32.join(appDir, 'pan-link'),
      log: path.win32.join(dataDir, 'pan-link.log'),
      env: baseEnv,
      restartOnCleanExit: true,
    },
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

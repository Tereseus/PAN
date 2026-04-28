/**
 * setup-plugins.js — PAN Plugin Setup
 *
 * Idempotent setup for all Claude Code plugins and hooks required by PAN.
 * Safe to run multiple times — skips anything already configured.
 *
 * Run manually:   node service/src/setup-plugins.js
 * Run on boot:    called from server.js first-run bootstrap
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');
const LOCAL_MARKETPLACE_DIR = path.join(PLUGINS_DIR, 'local');
const LOCAL_MARKETPLACE_JSON = path.join(LOCAL_MARKETPLACE_DIR, '.claude-plugin', 'marketplace.json');
const SETTINGS_JSON = path.join(CLAUDE_DIR, 'settings.json');

const PAN_SERVICE_DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
const SKILL_LEARNER_PATH = path.join(PAN_SERVICE_DIR, 'hooks', 'skill-learner.js').replace(/\//g, '/');

const log = (msg) => console.log(`[setup-plugins] ${msg}`);
const warn = (msg) => console.warn(`[setup-plugins] WARN: ${msg}`);

// ─── 1. Check claude CLI is available ────────────────────────────────────────

function checkClaude() {
  try {
    execSync('claude --version', { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    warn('`claude` CLI not found. Skipping plugin setup. Install Claude Code first.');
    return false;
  }
}

// ─── 2. Get installed plugins ─────────────────────────────────────────────────

function getInstalledPlugins() {
  try {
    const result = spawnSync('claude', ['plugins', 'list', '--json'], {
      encoding: 'utf8', windowsHide: true,
    });
    if (result.stdout) {
      const d = JSON.parse(result.stdout);
      return new Set((d.plugins || []).map(p => p.name));
    }
  } catch {}
  // Fallback: read settings.json
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'));
    return new Set(Object.keys(settings.enabledPlugins || {}));
  } catch {}
  return new Set();
}

// ─── 3. Install a plugin ──────────────────────────────────────────────────────

function installPlugin(name, marketplace = null) {
  const spec = marketplace ? `${name}@${marketplace}` : name;
  log(`Installing ${spec}...`);
  const result = spawnSync('claude', ['plugins', 'install', spec], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.status === 0) {
    log(`  ✔ ${spec} installed`);
    return true;
  } else {
    warn(`  ✘ Failed to install ${spec}: ${result.stderr?.trim()}`);
    return false;
  }
}

// ─── 4. Ensure pan-local marketplace is registered ───────────────────────────

function ensureLocalMarketplace() {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8')); } catch {}

  const known = settings.extraKnownMarketplaces || {};
  if (known['pan-local']) {
    log('pan-local marketplace already registered');
    return;
  }

  log('Registering pan-local marketplace...');
  const result = spawnSync('claude', ['plugins', 'marketplace', 'add', LOCAL_MARKETPLACE_DIR], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.status === 0) {
    log('  ✔ pan-local marketplace registered');
  } else {
    warn(`  ✘ Failed to register pan-local: ${result.stderr?.trim()}`);
  }
}

// ─── 5. Write home-assistant plugin files ────────────────────────────────────

function ensureHomeAssistantPlugin() {
  const pluginDir = path.join(LOCAL_MARKETPLACE_DIR, 'home-assistant');
  const metaDir = path.join(pluginDir, '.claude-plugin');
  const skillDir = path.join(pluginDir, 'skills', 'home-assistant');
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (fs.existsSync(skillFile)) {
    log('home-assistant skill already exists');
    return;
  }

  log('Creating home-assistant plugin files...');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });

  fs.writeFileSync(path.join(metaDir, 'plugin.json'), JSON.stringify({
    name: 'home-assistant',
    version: '1.0.0',
    description: 'Control Home Assistant — lights, switches, scenes, automations, sensors, and media players via the HA REST API.',
    author: { name: 'PAN', email: 'pan@local' },
    license: 'MIT',
  }, null, 2));

  fs.writeFileSync(skillFile, HOME_ASSISTANT_SKILL_MD);
  log('  ✔ home-assistant plugin created');
}

// ─── 6. Ensure marketplace.json exists and has all local plugins ──────────────

function ensureMarketplaceJson() {
  fs.mkdirSync(path.dirname(LOCAL_MARKETPLACE_JSON), { recursive: true });

  let marketplace = {};
  try { marketplace = JSON.parse(fs.readFileSync(LOCAL_MARKETPLACE_JSON, 'utf8')); } catch {}

  const base = {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: 'pan-local',
    description: 'PAN local skills and plugins',
    owner: { name: 'PAN', email: 'pan@local' },
    plugins: [],
  };

  marketplace = { ...base, ...marketplace };

  // Ensure home-assistant is listed
  if (!marketplace.plugins.find(p => p.name === 'home-assistant')) {
    marketplace.plugins.push({
      name: 'home-assistant',
      description: 'Control Home Assistant — lights, switches, scenes, automations, sensors, and media players via the HA REST API.',
      category: 'productivity',
      source: './home-assistant',
    });
  }

  // Add any auto-learned skills that exist on disk but aren't in manifest
  try {
    const entries = fs.readdirSync(LOCAL_MARKETPLACE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const pluginJson = path.join(LOCAL_MARKETPLACE_DIR, entry.name, '.claude-plugin', 'plugin.json');
      if (!fs.existsSync(pluginJson)) continue;
      if (marketplace.plugins.find(p => p.name === entry.name)) continue;
      const meta = JSON.parse(fs.readFileSync(pluginJson, 'utf8'));
      marketplace.plugins.push({
        name: entry.name,
        description: meta.description || '',
        category: 'productivity',
        source: `./${entry.name}`,
      });
      log(`  + Re-registered auto-learned skill: ${entry.name}`);
    }
  } catch {}

  fs.writeFileSync(LOCAL_MARKETPLACE_JSON, JSON.stringify(marketplace, null, 2));
}

// ─── 7. Ensure skill-learner Stop hook is wired ───────────────────────────────

function ensureSkillLearnerHook() {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8')); } catch {}

  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = settings.hooks.Stop || [{ hooks: [] }];

  const stopHooks = settings.hooks.Stop[0].hooks;
  const alreadyWired = stopHooks.some(h =>
    h.type === 'command' && h.command?.includes('skill-learner')
  );

  if (alreadyWired) {
    log('skill-learner hook already wired');
    return;
  }

  const winPath = SKILL_LEARNER_PATH.replace(/\//g, '\\');
  stopHooks.push({
    type: 'command',
    command: `node ${winPath}`,
    timeout: 30,
  });

  fs.writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2));
  log('  ✔ skill-learner Stop hook wired');
}

// ─── 8. Main ──────────────────────────────────────────────────────────────────

const OFFICIAL_PLUGINS = [
  'discord',
  'github',
  'telegram',
  'skill-creator',
  'session-report',
  'hookify',
];

export async function setupPlugins() {
  log('Starting plugin setup...');

  if (!checkClaude()) return;

  // Ensure local marketplace files exist on disk first
  ensureMarketplaceJson();
  ensureHomeAssistantPlugin();

  // Register marketplace with claude CLI
  ensureLocalMarketplace();

  // Get what's already installed
  const installed = getInstalledPlugins();

  // Install official plugins
  for (const plugin of OFFICIAL_PLUGINS) {
    const key = `${plugin}@claude-plugins-official`;
    if (installed.has(plugin) || installed.has(key)) {
      log(`${plugin} already installed`);
    } else {
      installPlugin(plugin);
    }
  }

  // Install local plugins
  const localPlugins = ['home-assistant'];
  for (const plugin of localPlugins) {
    const key = `${plugin}@pan-local`;
    if (installed.has(plugin) || installed.has(key)) {
      log(`${plugin} already installed`);
    } else {
      installPlugin(plugin, 'pan-local');
    }
  }

  // Wire skill-learner hook
  ensureSkillLearnerHook();

  log('Plugin setup complete.');
}

// ─── Home Assistant SKILL.md (embedded so setup is self-contained) ────────────

const HOME_ASSISTANT_SKILL_MD = `---
name: home-assistant
description: Use this skill when the user wants to control smart home devices, lights, switches, scenes, automations, climate, media players, or sensors via Home Assistant. Trigger phrases include "turn on", "turn off", "dim", "set scene", "what is the temperature", "lock the door", "run automation", "play on", "pause", "set thermostat", "what lights are on", "home assistant", "HA".
version: 1.0.0
---

# Home Assistant Skill

Control any Home Assistant entity via the REST API using \`curl\`.

## Config

Required env vars:
- \`HASS_URL\` — e.g. \`http://homeassistant.local:8123\` or Tailscale IP
- \`HASS_TOKEN\` — Long-lived access token from HA Profile → Security

If missing, check PAN settings: \`curl -s http://127.0.0.1:7777/api/v1/settings | jq '.hass_url, .hass_token'\`

If still missing, tell user: "Set HASS_URL and HASS_TOKEN to enable Home Assistant control."

\`\`\`bash
BASE="\$HASS_URL"
AUTH="Authorization: Bearer \$HASS_TOKEN"
\`\`\`

## Find entity IDs

\`\`\`bash
# Search by friendly name
curl -s -H "\$AUTH" "\$BASE/api/states" | jq '[.[] | select(.attributes.friendly_name | ascii_downcase | contains("living")) | {entity_id, state, friendly_name: .attributes.friendly_name}]'

# All lights
curl -s -H "\$AUTH" "\$BASE/api/states" | jq '[.[] | select(.entity_id | startswith("light.")) | {entity_id, state, friendly_name: .attributes.friendly_name}]'
\`\`\`

## Lights

\`\`\`bash
# On/off/toggle
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/light/turn_on" -d '{"entity_id":"light.living_room"}'
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/light/turn_off" -d '{"entity_id":"light.living_room"}'

# Dim to 40%
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/light/turn_on" -d '{"entity_id":"light.living_room","brightness_pct":40}'

# Color
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/light/turn_on" -d '{"entity_id":"light.desk","rgb_color":[255,100,0],"brightness_pct":80}'
\`\`\`

## Switches / Scenes / Automations

\`\`\`bash
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/switch/turn_on" -d '{"entity_id":"switch.fan"}'
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/scene/turn_on" -d '{"entity_id":"scene.movie_night"}'
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/automation/trigger" -d '{"entity_id":"automation.morning_routine"}'
\`\`\`

## Climate

\`\`\`bash
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/climate/set_temperature" -d '{"entity_id":"climate.living_room","temperature":22}'
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/climate/set_hvac_mode" -d '{"entity_id":"climate.living_room","hvac_mode":"heat"}'
\`\`\`

## Media Players

\`\`\`bash
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/media_player/media_play_pause" -d '{"entity_id":"media_player.living_room_tv"}'
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/media_player/volume_set" -d '{"entity_id":"media_player.living_room_tv","volume_level":0.4}'
\`\`\`

## Locks / Sensors

\`\`\`bash
curl -s -X POST -H "\$AUTH" -H "Content-Type: application/json" "\$BASE/api/services/lock/lock" -d '{"entity_id":"lock.front_door"}'
curl -s -H "\$AUTH" "\$BASE/api/states/sensor.living_room_temperature" | jq '{state, unit: .attributes.unit_of_measurement}'
\`\`\`

## Errors

- \`401\` → token expired, regenerate in HA Profile → Security → Long-Lived Access Tokens
- \`404\` → entity_id wrong, search by friendly name
- Connection refused → HA down or HASS_URL wrong
`;

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  setupPlugins().catch(console.error);
}

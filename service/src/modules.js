// PAN Module Loader — loads user-created modules from the modules directory.
//
// Modules live in %LOCALAPPDATA%/PAN/modules/ (Windows) or
// ~/.local/share/pan/modules/ (Linux). Each module is a directory with:
//   pan-module.json  — manifest (name, version, description, entrypoint, hooks)
//   index.js         — default entrypoint
//
// PAN core (service/) is git-managed and auto-updated.
// User modules (modules/) are NEVER touched by PAN updates.
//
// Module API:
//   module.exports = (pan) => { ... }
//   pan.db        — read-only DB access (SELECT only)
//   pan.events    — EventEmitter (subscribe to PAN events)
//   pan.settings  — get/set module-scoped settings
//   pan.router    — express.Router() for custom API routes
//   pan.log       — scoped logger
//   pan.version   — PAN version

import fs from 'fs';
import path from 'path';
import { getDataDir } from './platform.js';
import { EventEmitter } from 'events';

const MODULE_DIR_NAME = 'modules';
let _modules = [];
let _events = new EventEmitter();

// Get the modules directory path
export function getModulesDir() {
  // Modules dir is sibling to data dir:
  // Windows: %LOCALAPPDATA%/PAN/modules/
  // Linux:   ~/.local/share/pan/modules/
  const dataDir = getDataDir();
  return path.resolve(dataDir, '..', MODULE_DIR_NAME);
}

// Discover all valid modules
export function discoverModules() {
  const dir = getModulesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const modules = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const modDir = path.join(dir, entry.name);
    const manifestPath = path.join(modDir, 'pan-module.json');

    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      modules.push({
        name: manifest.name || entry.name,
        version: manifest.version || '0.0.0',
        description: manifest.description || '',
        entrypoint: manifest.entrypoint || 'index.js',
        hooks: manifest.hooks || [],
        routes: manifest.routes || false,
        dir: modDir,
        manifest,
        loaded: false,
        error: null,
      });
    } catch (e) {
      console.error(`[Modules] Invalid manifest in ${entry.name}: ${e.message}`);
    }
  }

  return modules;
}

// Create sandboxed API for a module
function createModuleAPI(mod, db, app) {
  return {
    // Read-only DB — modules cannot write to PAN's core tables
    db: {
      get: (sql, ...params) => {
        if (!sql.trim().toUpperCase().startsWith('SELECT')) {
          throw new Error('Modules can only SELECT from the database');
        }
        return db.prepare(sql).get(...params);
      },
      all: (sql, ...params) => {
        if (!sql.trim().toUpperCase().startsWith('SELECT')) {
          throw new Error('Modules can only SELECT from the database');
        }
        return db.prepare(sql).all(...params);
      },
    },

    // Event bus — subscribe to PAN events
    events: {
      on: (event, handler) => _events.on(`module:${event}`, handler),
      off: (event, handler) => _events.off(`module:${event}`, handler),
    },

    // Module-scoped settings (stored in PAN DB under module namespace)
    settings: {
      get: (key) => {
        try {
          const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`mod:${mod.name}:${key}`);
          return row ? JSON.parse(row.value) : null;
        } catch { return null; }
      },
      set: (key, value) => {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`mod:${mod.name}:${key}`, JSON.stringify(value));
      },
    },

    // Express router for custom API routes (mounted at /api/modules/<name>/)
    router: null, // Set up during load if manifest declares routes

    // Scoped logger
    log: (...args) => console.log(`[Module:${mod.name}]`, ...args),

    // PAN metadata
    version: '1.0.0',
    moduleName: mod.name,
    moduleDir: mod.dir,
  };
}

// Load all modules
export async function loadModules(db, app) {
  const mods = discoverModules();
  console.log(`[Modules] Found ${mods.length} module(s) in ${getModulesDir()}`);

  for (const mod of mods) {
    try {
      const entryPath = path.join(mod.dir, mod.entrypoint);
      if (!fs.existsSync(entryPath)) {
        mod.error = `Entrypoint not found: ${mod.entrypoint}`;
        console.error(`[Modules] ${mod.name}: ${mod.error}`);
        continue;
      }

      const api = createModuleAPI(mod, db, app);

      // If module declares routes, create a router
      if (mod.manifest.routes && app) {
        const { Router } = await import('express');
        api.router = Router();
        app.use(`/api/modules/${mod.name}`, api.router);
      }

      // Import and initialize module
      const moduleInit = await import(`file://${entryPath}`);
      const init = moduleInit.default || moduleInit;

      if (typeof init === 'function') {
        await init(api);
      }

      mod.loaded = true;
      console.log(`[Modules] Loaded: ${mod.name} v${mod.version}`);
    } catch (e) {
      mod.error = e.message;
      console.error(`[Modules] Failed to load ${mod.name}: ${e.message}`);
    }
  }

  _modules = mods;
  return mods;
}

// Emit event to all modules
export function emitModuleEvent(event, data) {
  _events.emit(`module:${event}`, data);
}

// Get loaded modules status
export function getModulesStatus() {
  return _modules.map(m => ({
    name: m.name,
    version: m.version,
    description: m.description,
    loaded: m.loaded,
    error: m.error,
  }));
}

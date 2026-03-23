// NanoClaw — PAN skill loader
// Reads .md and .json skill files from skills/ directory
// Skills teach PAN new integrations without hardcoding them in router.js

import { readFileSync, readdirSync, watch } from 'fs';
import { join, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = join(__dirname, 'skills');

// In-memory skill registry
let skills = [];

// Parse YAML-like frontmatter from markdown skill files
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const rawMeta = match[1];
  const body = match[2].trim();
  const meta = {};

  for (const line of rawMeta.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Parse arrays: [item1, item2, item3]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    }
    meta[key] = value;
  }

  return { meta, body };
}

// Load a single skill file
function loadSkillFile(filePath) {
  try {
    const ext = extname(filePath).toLowerCase();
    const raw = readFileSync(filePath, 'utf-8');

    if (ext === '.json') {
      const data = JSON.parse(raw);
      return {
        name: data.name || basename(filePath, ext),
        triggers: Array.isArray(data.triggers) ? data.triggers : [],
        requires: Array.isArray(data.requires) ? data.requires : [],
        instructions: data.instructions || '',
        file: filePath,
      };
    }

    if (ext === '.md') {
      const { meta, body } = parseFrontmatter(raw);
      return {
        name: meta.name || basename(filePath, ext),
        triggers: Array.isArray(meta.triggers) ? meta.triggers : [],
        requires: Array.isArray(meta.requires) ? meta.requires : [],
        instructions: body,
        file: filePath,
      };
    }

    return null;
  } catch (e) {
    console.error(`[NanoClaw] Failed to load skill ${filePath}:`, e.message);
    return null;
  }
}

// Scan skills/ directory and load all skill files
function loadAllSkills() {
  try {
    const files = readdirSync(SKILLS_DIR);
    const loaded = [];

    for (const file of files) {
      const ext = extname(file).toLowerCase();
      if (ext !== '.md' && ext !== '.json') continue;

      const skill = loadSkillFile(join(SKILLS_DIR, file));
      if (skill) loaded.push(skill);
    }

    skills = loaded;
    console.log(`[NanoClaw] Loaded ${skills.length} skills: ${skills.map(s => s.name).join(', ')}`);
  } catch (e) {
    console.error('[NanoClaw] Failed to scan skills directory:', e.message);
    skills = [];
  }
}

// Match user text against skill triggers — returns the best matching skill or null
function findSkill(text) {
  const lower = text.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      const triggerLower = trigger.toLowerCase();
      if (lower.includes(triggerLower)) {
        // Longer trigger matches are more specific, so score by length
        const score = triggerLower.length;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = skill;
        }
      }
    }
  }

  return bestMatch;
}

// Build a prompt injection block for a matched skill
function getSkillPrompt(skill) {
  return `\n--- SKILL: ${skill.name} ---\nPAN has a loaded skill for this request. Follow these instructions:\n\n${skill.instructions}\n\nRequired tools: ${(skill.requires || []).join(', ') || 'none'}\n--- END SKILL ---\n`;
}

// Get all loaded skills (for debugging/status)
function listSkills() {
  return skills.map(s => ({ name: s.name, triggers: s.triggers, requires: s.requires }));
}

// Initial load
loadAllSkills();

// Hot-reload: watch the skills directory for changes
try {
  let reloadTimer = null;
  watch(SKILLS_DIR, { persistent: false }, (eventType, filename) => {
    // Debounce rapid changes
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      console.log(`[NanoClaw] Skill file changed (${filename}), reloading...`);
      loadAllSkills();
    }, 300);
  });
} catch (e) {
  console.warn('[NanoClaw] Could not watch skills directory:', e.message);
}

export { findSkill, getSkillPrompt, listSkills, loadAllSkills };

// NanoClaw — PAN skill loader
// Reads .md and .json skill files from skills/ directory
// Skills teach PAN new integrations without hardcoding them in router.js
//
// Supports parameterized triggers: "play {song} by {artist}"
// Extracted params are injected into skill instructions as {{song}}, {{artist}}

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
        conditions: data.conditions || {},
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
        conditions: meta.conditions ? (typeof meta.conditions === 'string' ? { requires_setting: meta.conditions } : meta.conditions) : {},
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

// ── Parameterized trigger matching ───────────────────────────────────────────
// Converts "play {song} by {artist}" to a named-group regex.
// Returns extracted params object, or null if no match.
function matchWithParams(text, trigger) {
  const lowerText = text.toLowerCase();
  const lowerTrigger = trigger.toLowerCase();

  // Fast path: no params — plain substring match
  if (!lowerTrigger.includes('{')) {
    return lowerText.includes(lowerTrigger) ? {} : null;
  }

  // Build named-capture regex from the trigger template
  // {song} → (?<song>.+?)   (lazy so multiple slots don't eat each other)
  const regexStr = lowerTrigger
    .replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '{' || c === '}' ? c : `\\${c}`))
    .replace(/\{(\w+)\}/g, '(?<$1>.+)');

  try {
    const regex = new RegExp(regexStr, 'i');
    const match = lowerText.match(regex);
    if (!match) return null;
    // Return named groups, trimmed
    const params = {};
    if (match.groups) {
      for (const [k, v] of Object.entries(match.groups)) {
        params[k] = v?.trim() ?? '';
      }
    }
    return params;
  } catch {
    // Malformed trigger regex — fall back to plain match
    return lowerText.includes(lowerTrigger.replace(/\{.*?\}/g, '').trim()) ? {} : null;
  }
}

// Score a trigger match — parameterized triggers score by literal character count
// (slots don't count), so "play {song} by {artist}" beats "play {song}" beats "play".
function triggerScore(trigger) {
  return trigger.replace(/\{.*?\}/g, '').replace(/\s+/g, ' ').trim().length;
}

// Match user text against skill triggers — returns { skill, params } or null
function findSkill(text) {
  let bestSkill = null;
  let bestParams = null;
  let bestScore = 0;

  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      const params = matchWithParams(text, trigger);
      if (params === null) continue;

      const score = triggerScore(trigger);
      if (score > bestScore) {
        bestScore = score;
        bestSkill = skill;
        bestParams = params;
      }
    }
  }

  if (!bestSkill) return null;
  return { skill: bestSkill, params: bestParams };
}

// Build a prompt injection block for a matched skill
// Substitutes {{param}} placeholders in instructions with extracted values
function getSkillPrompt(skillMatch) {
  // Accept both legacy skill object and new { skill, params } shape
  const skill  = skillMatch?.skill ?? skillMatch;
  const params = skillMatch?.params ?? {};

  let instructions = skill.instructions;

  // Substitute {{param}} → extracted value
  if (Object.keys(params).length > 0) {
    instructions = instructions.replace(/\{\{(\w+)\}\}/g, (_, key) =>
      params[key] !== undefined ? params[key] : `{{${key}}}`
    );
  }

  const paramNote = Object.keys(params).length > 0
    ? `\nExtracted parameters: ${JSON.stringify(params)}\n`
    : '';

  return `\n--- SKILL: ${skill.name} ---\nPAN has a loaded skill for this request.${paramNote}Follow these instructions:\n\n${instructions}\n\nRequired tools: ${(skill.requires || []).join(', ') || 'none'}\n--- END SKILL ---\n`;
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

#!/usr/bin/env node
/**
 * skill-learner.js — Hermes-style self-improving loop
 *
 * Runs as a Stop hook. Reads the session transcript, asks Cerebras whether
 * a novel reusable skill was demonstrated, and if so auto-generates a SKILL.md
 * and registers it in the pan-local marketplace.
 *
 * Wired in ~/.claude/settings.json under Stop hooks.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY || 'csk-5r22jpknpdp5685e3m6kyp8yvj6myc58tpk6rrvvped2fdpk';
const CEREBRAS_MODEL = 'qwen-3-235b-a22b-instruct-2507';
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'plugins', 'local');
const MARKETPLACE_JSON = path.join(SKILLS_DIR, '.claude-plugin', 'marketplace.json');

// Minimum turns before considering skill creation (avoid creating skills from tiny sessions)
const MIN_TURNS = 4;

async function callCerebras(messages) {
  const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CEREBRAS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CEREBRAS_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });
  if (!res.ok) throw new Error(`Cerebras error: ${res.status}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

function extractTurns(transcript) {
  const turns = [];
  for (const entry of transcript) {
    if (entry.type === 'user') {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && c.text?.trim().length > 3) {
            turns.push({ role: 'user', text: c.text.trim().slice(0, 500) });
          }
        }
      }
    } else if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && c.text?.trim()) {
            turns.push({ role: 'assistant', text: c.text.trim().slice(0, 500) });
          }
        }
      }
    }
  }
  // Deduplicate consecutive same-role same-text
  return turns.filter((t, i) =>
    i === 0 || !(t.role === turns[i-1].role && t.text === turns[i-1].text)
  );
}

function sanitizeSkillName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function registerInMarketplace(skillName, description) {
  let marketplace;
  try {
    marketplace = JSON.parse(fs.readFileSync(MARKETPLACE_JSON, 'utf8'));
  } catch {
    marketplace = {
      '$schema': 'https://anthropic.com/claude-code/marketplace.schema.json',
      name: 'pan-local',
      description: 'PAN local skills and plugins',
      owner: { name: 'PAN', email: 'pan@local' },
      plugins: [],
    };
  }

  // Don't add duplicates
  if (!marketplace.plugins.find(p => p.name === skillName)) {
    marketplace.plugins.push({
      name: skillName,
      description,
      category: 'productivity',
      source: `./${skillName}`,
    });
    fs.writeFileSync(MARKETPLACE_JSON, JSON.stringify(marketplace, null, 2));
  }
}

function writeSkillPlugin(skillName, description, skillContent) {
  const pluginDir = path.join(SKILLS_DIR, skillName);
  const metaDir = path.join(pluginDir, '.claude-plugin');
  const skillDir = path.join(pluginDir, 'skills', skillName);

  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });

  // plugin.json
  fs.writeFileSync(path.join(metaDir, 'plugin.json'), JSON.stringify({
    name: skillName,
    version: '1.0.0',
    description,
    author: { name: 'PAN (auto-learned)', email: 'pan@local' },
    license: 'MIT',
  }, null, 2));

  // SKILL.md
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);
}

async function main() {
  // Read stdin
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;

  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch {
    process.exit(0); // Not JSON, nothing to do
  }

  const transcript = hookData.transcript || hookData.messages || [];
  const turns = extractTurns(transcript);

  if (turns.length < MIN_TURNS) process.exit(0);

  // Build a compact summary of the session for evaluation
  const sessionSummary = turns
    .slice(-30) // last 30 turns max
    .map(t => `${t.role === 'user' ? 'USER' : 'PAN'}: ${t.text}`)
    .join('\n\n');

  const evalPrompt = `You are analyzing a Claude Code session to decide if a reusable skill should be auto-generated.

A skill is worth creating if:
- A non-trivial, repeatable task was completed (e.g. a specific API integration, a multi-step workflow, a debugging pattern)
- The task is likely to recur in future sessions
- The method is generalizable beyond this one session
- It's NOT just a simple one-liner or a task already covered by existing skills (home-assistant, github, discord, telegram, session-report, skill-creator, hookify)

SESSION TRANSCRIPT (last 30 turns):
${sessionSummary}

Respond with ONLY valid JSON in one of these two forms:

If a skill should be created:
{
  "create": true,
  "name": "kebab-case-skill-name",
  "description": "One sentence: when this skill should activate, including 3-5 trigger phrases",
  "skill_md": "Full SKILL.md content including YAML frontmatter (---\\nname: ...\\ndescription: ...\\nversion: 1.0.0\\n---\\n\\n# Title\\n...)"
}

If no skill needed:
{"create": false, "reason": "one line reason"}`;

  let response;
  try {
    response = await callCerebras([
      { role: 'system', content: 'You output only valid JSON. No markdown fences, no explanation outside the JSON.' },
      { role: 'user', content: evalPrompt },
    ]);
  } catch (e) {
    // Silently fail — don't break the session
    process.exit(0);
  }

  let decision;
  try {
    // Strip markdown fences if the model added them anyway
    const cleaned = response.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    decision = JSON.parse(cleaned);
  } catch {
    process.exit(0);
  }

  if (!decision.create) process.exit(0);

  const skillName = sanitizeSkillName(decision.name);
  if (!skillName) process.exit(0);

  // Check if skill already exists
  const existingSkillPath = path.join(SKILLS_DIR, skillName, 'skills', skillName, 'SKILL.md');
  if (fs.existsSync(existingSkillPath)) process.exit(0);

  try {
    writeSkillPlugin(skillName, decision.description, decision.skill_md);
    registerInMarketplace(skillName, decision.description);

    // Log to PAN server (best-effort)
    fetch('http://127.0.0.1:7777/api/v1/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: 'skill-learner',
        level: 'info',
        message: `Auto-created skill: ${skillName}`,
        data: { skillName, description: decision.description },
      }),
    }).catch(() => {});

    // Print to stdout so it shows in terminal
    console.log(`\n[skill-learner] Auto-created skill: ${skillName}\nInstall with: claude plugins install ${skillName}@pan-local\n`);
  } catch (e) {
    // Silently fail
  }

  process.exit(0);
}

main().catch(() => process.exit(0));

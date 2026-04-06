// PAN Memory Context Builder — assembles memory into a token-budgeted prompt section
//
// At query time, pulls from all three memory tiers and builds a markdown
// context string that fits within the token budget. Priority:
//   1. Semantic facts (accumulated knowledge — most stable)
//   2. Episodic memories (recent events — most relevant)
//   3. Procedural memories (how to do things — least often needed)

import * as episodic from './episodic.js';
import * as semantic from './semantic.js';
import * as procedural from './procedural.js';

// Rough token estimate: ~4 chars per token
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Build memory context for a query
async function buildContext(query, { tokenBudget = 50000, projectId = null } = {}) {
  let used = 0;
  const sections = [];

  // 1. Semantic facts — user preferences, domain knowledge, codebase facts
  const facts = await semantic.recall(query, { limit: 30 });
  if (facts.length > 0) {
    let factsText = '## Known Facts\n';
    for (const f of facts) {
      if (f.similarity < 0.3) continue; // skip irrelevant facts
      const line = `- **${f.subject}** ${f.predicate} ${f.object}${f.description ? ` — ${f.description}` : ''} (${f.category}, confidence: ${f.confidence})\n`;
      if (used + estimateTokens(line) > tokenBudget * 0.4) break; // cap facts at 40% of budget
      factsText += line;
      used += estimateTokens(line);
    }
    if (factsText !== '## Known Facts\n') {
      sections.push(factsText);
    }
  }

  // 2. Episodic memories — what happened recently
  const episodes = await episodic.recall(query, { limit: 20, projectId });
  if (episodes.length > 0) {
    let epText = '## Recent Memory\n';
    for (const ep of episodes) {
      if (ep.score < 0.2) continue;
      const outcomeTag = ep.outcome !== 'success' ? ` [${ep.outcome}]` : '';
      const line = `- [${ep.created_at}] ${ep.summary}${outcomeTag}${ep.detail ? `: ${ep.detail.slice(0, 200)}` : ''}\n`;
      if (used + estimateTokens(line) > tokenBudget * 0.8) break; // cap episodes at 80%
      epText += line;
      used += estimateTokens(line);
    }
    if (epText !== '## Recent Memory\n') {
      sections.push(epText);
    }
  }

  // 3. Procedural memories — relevant procedures
  const procs = await procedural.recall(query, { limit: 5 });
  if (procs.length > 0) {
    let procText = '## Known Procedures\n';
    for (const p of procs) {
      if (p.score < 0.3) continue;
      const stepsSummary = p.steps.map((s, i) => `  ${i + 1}. ${s.action || s}`).join('\n');
      const block = `- **${p.name}**: ${p.description}\n${stepsSummary}\n`;
      if (used + estimateTokens(block) > tokenBudget) break;
      procText += block;
      used += estimateTokens(block);
    }
    if (procText !== '## Known Procedures\n') {
      sections.push(procText);
    }
  }

  const context = sections.join('\n');
  return { context, tokens: used, stats: { facts: facts.length, episodes: episodes.length, procedures: procs.length } };
}

// Quick stats about memory state
function getStats() {
  return {
    episodes: episodic.count(),
    facts: semantic.count(),
    procedures: procedural.count(),
  };
}

export { buildContext, getStats };

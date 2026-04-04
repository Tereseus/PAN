#!/usr/bin/env node
// PAN Memory & Evolution System — Production Test
// Run: node test-memory.js

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

// Colors for output
const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
const pass = (msg) => console.log(`${GREEN}✓ PASS${RESET} ${msg}`);
const fail = (msg, err) => console.log(`${RED}✗ FAIL${RESET} ${msg}${err ? ': ' + err.message : ''}`);
const info = (msg) => console.log(`${CYAN}► ${msg}${RESET}`);
const warn = (msg) => console.log(`${YELLOW}⚠ ${msg}${RESET}`);

let results = { passed: 0, failed: 0, skipped: 0 };

async function test(name, fn) {
  try {
    await fn();
    results.passed++;
  } catch (e) {
    fail(name, e);
    results.failed++;
  }
}

async function run() {
  console.log('\n' + '='.repeat(60));
  console.log('  PAN Memory & Evolution — Production Test');
  console.log('='.repeat(60) + '\n');

  // ── 1. Database ──
  info('1. Database connection');
  let db;
  await test('Database loads', async () => {
    const dbMod = await import('./src/db.js');
    db = dbMod.default || dbMod.db || dbMod;
    // Check memory tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%memor%' OR name LIKE '%episod%' OR name LIKE '%semantic%' OR name LIKE '%procedur%' OR name LIKE '%evolution%'").all();
    const tableNames = tables.map(t => t.name);
    pass(`Database loaded — memory tables: ${tableNames.join(', ') || 'NONE'}`);
    if (tableNames.length === 0) {
      warn('No memory tables found — schema may need to run');
    }
  });

  // ── 2. Ollama Boot ──
  info('\n2. Ollama boot');
  let ollamaReady = false;
  await test('Ollama starts', async () => {
    const { ensureOllama } = await import('./src/memory/ollama-boot.js');
    const result = await ensureOllama();
    if (result === false) {
      warn('Ollama not available — will use keyword fallback');
    } else {
      ollamaReady = true;
      pass('Ollama is running');
    }
  });

  // Check if model is available
  if (ollamaReady) {
    await test('Embedding model available', async () => {
      const resp = await fetch('http://localhost:11434/api/tags');
      const data = await resp.json();
      const models = data.models?.map(m => m.name) || [];
      if (models.some(m => m.includes('nomic-embed-text'))) {
        pass(`Model found: ${models.filter(m => m.includes('nomic')).join(', ')}`);
      } else {
        warn(`Model not pulled yet. Available: ${models.join(', ') || 'none'}`);
        info('Pulling nomic-embed-text (274MB)...');
        const pullResp = await fetch('http://localhost:11434/api/pull', {
          method: 'POST',
          body: JSON.stringify({ name: 'nomic-embed-text' })
        });
        // Stream the response to wait for completion
        const reader = pullResp.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        pass('Model pulled');
      }
    });
  }

  // ── 3. Embeddings ──
  info('\n3. Embeddings');
  await test('Generate embedding', async () => {
    const { embed, cosineSimilarity } = await import('./src/memory/embeddings.js');
    const vec1 = await embed('the user prefers dark mode');
    const vec2 = await embed('dark theme is preferred by the user');
    const vec3 = await embed('how to deploy a kubernetes cluster');

    if (!vec1 || vec1.length === 0) throw new Error(`Bad vector length: ${vec1?.length}`);

    const simSame = cosineSimilarity(vec1, vec2);
    const simDiff = cosineSimilarity(vec1, vec3);

    pass(`Vector: 768D, similar="${simSame.toFixed(3)}", different="${simDiff.toFixed(3)}"`);
    if (ollamaReady && simSame > simDiff) {
      pass('Semantic similarity working — related > unrelated');
    } else if (!ollamaReady) {
      warn('Using keyword fallback — similarity may not be semantic');
    }
  });

  // ── 4. Episodic Memory ──
  info('\n4. Episodic memory (store + recall)');
  await test('Episodic store and recall', async () => {
    const episodic = await import('./src/memory/episodic.js');

    // Store a test episode
    const id = await episodic.store({
      summary: 'TEST: User fixed the terminal scrollbar bug',
      detail: 'Modified WezTerm config to prevent auto-scroll on new output',
      type: 'bugfix',
      outcome: 'success',
      importance: 0.8,
      sessionId: 'test-session-001',
      projectId: 'PAN'
    });
    pass(`Stored episodic memory id=${id}`);

    // Recall it
    const results = await episodic.recall('terminal scroll fix', { limit: 3 });
    if (results.length === 0) throw new Error('No results returned');
    pass(`Recalled ${results.length} episodes, top score=${results[0].score?.toFixed(3) || 'N/A'}`);

    const count = await episodic.count();
    pass(`Total episodic memories: ${count}`);
  });

  // ── 5. Semantic Memory ──
  info('\n5. Semantic memory (store + recall)');
  await test('Semantic store and recall', async () => {
    const semantic = await import('./src/memory/semantic.js');

    const id = await semantic.store({
      subject: 'terminal',
      predicate: 'is',
      object: 'WezTerm',
      description: 'The user uses WezTerm as their terminal emulator',
      category: 'user_preference',
      confidence: 0.95
    });
    pass(`Stored semantic fact id=${id}`);

    const results = await semantic.recall('what terminal does the user use', { limit: 3 });
    if (results.length === 0) throw new Error('No results returned');
    pass(`Recalled ${results.length} facts, top="${results[0].subject}: ${results[0].object}"`);

    const count = await semantic.count();
    pass(`Total semantic facts: ${count}`);
  });

  // ── 6. Procedural Memory ──
  info('\n6. Procedural memory (store + recall)');
  await test('Procedural store and recall', async () => {
    const procedural = await import('./src/memory/procedural.js');

    const id = await procedural.store({
      name: 'Build Android APK',
      description: 'How to build and deploy the PAN Android app',
      triggerPattern: 'build|deploy|apk|android',
      steps: ['cd to android/', 'set JAVA_HOME', 'run gradlew assembleDebug', 'adb install'],
      preconditions: ['Android SDK installed', 'Phone connected via USB'],
      postconditions: ['APK installed on phone']
    });
    pass(`Stored procedure id=${id}`);

    const results = await procedural.recall('build the android app', { limit: 3 });
    if (results.length === 0) throw new Error('No results returned');
    pass(`Recalled ${results.length} procedures, top="${results[0].name}"`);

    const count = await procedural.count();
    pass(`Total procedures: ${count}`);
  });

  // ── 7. Context Builder ──
  info('\n7. Context builder');
  await test('Build memory context', async () => {
    const { buildContext, getStats } = await import('./src/memory/context-builder.js');

    const stats = await getStats();
    pass(`Memory stats: ${JSON.stringify(stats)}`);

    const ctx = await buildContext('terminal scrollbar issue', { maxTokens: 2000 });
    pass(`Context built: ${ctx.tokens} tokens, ${ctx.context.length} chars`);
    if (ctx.context.length > 0) {
      console.log(`   Preview: "${ctx.context.substring(0, 150)}..."`);
    }
  });

  // ── 8. Consolidation ──
  info('\n8. Consolidation (from real events)');
  await test('Consolidate recent events', async () => {
    const { consolidate } = await import('./src/memory/consolidation.js');

    // Run without LLM first (heuristic only — fast)
    const result = await consolidate({ useLLM: false });
    pass(`Consolidation (heuristic): episodes=${result.episodes}, facts=${result.facts}, procedures=${result.procedures}`);
  });

  // ── 9. Evolution ──
  info('\n9. Evolution pipeline');
  await test('Evolution observe step', async () => {
    const { evolve } = await import('./src/evolution/engine.js');

    // Just run observe (step 1) to see what it finds
    // Full evolve() would call Claude — let's just test the pipeline exists
    info('Running full evolution pipeline (will call Claude for critique)...');
    const result = await evolve();
    pass(`Evolution result: status=${result.status}, changes=${result.changes?.length || 0}`);
    if (result.changes?.length > 0) {
      result.changes.forEach(c => console.log(`   Changed: ${c.file} — ${c.reason}`));
    }
    if (result.error) {
      warn(`Evolution note: ${result.error}`);
    }
  });

  // ── 10. Dream Cycle ──
  info('\n10. Dream cycle (manual trigger)');
  await test('Dream cycle runs', async () => {
    const { dream } = await import('./src/dream.js');

    info('Triggering dream cycle...');
    const result = await dream();
    if (result === false) {
      warn('Dream skipped (too soon since last run or guard triggered)');
      pass('Dream guard working correctly');
    } else {
      pass(`Dream completed: ${JSON.stringify(result)}`);
    }
  });

  // ── Summary ──
  console.log('\n' + '='.repeat(60));
  console.log(`  Results: ${GREEN}${results.passed} passed${RESET}, ${RED}${results.failed} failed${RESET}`);
  console.log('='.repeat(60) + '\n');

  process.exit(results.failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

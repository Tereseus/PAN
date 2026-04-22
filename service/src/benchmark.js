// PAN Benchmark — Intuition suite
// Scores the AI voice router on 7 capability axes defined in docs/AI-MODEL-SELECTION.md:
//   Hearing, Reflex, Clarity, Reasoning, Memory, Voice, Form (label only)
//
// Usage: runIntuitionBenchmark(model) → { hearing, reflex_ms, clarity, reasoning, memory, voice, passed, details }

import { run, get, insert, all } from './db.js';
import { claude } from './llm.js';

// ── Rate limiter ─────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Scout failure topics ─────────────────────────────────────────────────────
// Maps each failing axis to targeted search topics for Scout
const AXIS_TOPICS = {
  hearing:   ['voice router garbled STT handling 2026', 'speech recognition noise robustness AI models'],
  reflex_ms: ['low latency LLM inference 2026', 'Cerebras Groq voice assistant speed comparison'],
  clarity:   ['LLM JSON schema compliance structured output reliability', 'function calling JSON mode AI 2026'],
  reasoning: ['ambient speech detection LLM prompt engineering', 'voice assistant intent classification 2026'],
  memory:    ['multi-turn conversation context LLM voice assistant', 'dialogue history routing AI'],
  voice:     ['LLM personality consistency prompting', 'character persistence AI assistant'],
};

async function notifyScoutOfFailures(scores, model) {
  try {
    // Find which axes failed their floors
    const failing = [];
    if (scores.hearing   < FLOORS.hearing)   failing.push('hearing');
    if (scores.reflex_ms > FLOORS.reflex_ms) failing.push('reflex_ms');
    if (scores.clarity   < FLOORS.clarity)   failing.push('clarity');
    if (scores.reasoning < FLOORS.reasoning) failing.push('reasoning');
    if (scores.memory    < FLOORS.memory)    failing.push('memory');
    if (scores.voice     < FLOORS.voice)     failing.push('voice');

    if (failing.length === 0) return;

    // Build targeted search topics from failing axes
    const newTopics = failing.flatMap(axis => AXIS_TOPICS[axis] || []);
    const failureSummary = failing.map(axis => {
      const got = axis === 'reflex_ms' ? `${scores.reflex_ms}ms` : `${scores[axis]}/10`;
      const floor = axis === 'reflex_ms' ? `<${FLOORS[axis]}ms` : `${FLOORS[axis]}/10`;
      return `${axis}: ${got} (floor ${floor})`;
    }).join(', ');

    // Merge into existing scout_topics without duplicates
    const configRow = get("SELECT value FROM settings WHERE key = 'autodev_config'");
    const config = configRow ? JSON.parse(configRow.value) : {};
    const existing = config.scout_topics || [];
    const merged = [...new Set([...existing, ...newTopics])];
    config.scout_topics = merged;

    // Write benchmark failure context so Scout knows WHY it's searching
    config.last_benchmark_failure = {
      suite: 'intuition',
      model,
      failing_axes: failing,
      scores,
      summary: failureSummary,
      at: new Date().toISOString(),
    };

    run("INSERT OR REPLACE INTO settings (key, value) VALUES ('autodev_config', ?)",
      [JSON.stringify(config)]);

    console.log(`[PAN Benchmark] ⚠️  Notified Scout of ${failing.length} failing axes: ${failureSummary}`);
    console.log(`[PAN Benchmark] Scout will search: ${newTopics.join(' | ')}`);

    // Trigger an immediate Scout run in the background (don't await — don't block)
    import('./scout.js').then(({ scout }) => {
      console.log('[PAN Benchmark] Triggering immediate Scout scan for benchmark failures...');
      scout().catch(e => console.error('[PAN Benchmark] Scout trigger error:', e.message));
    }).catch(() => {});

  } catch (e) {
    console.error('[PAN Benchmark] Failed to notify Scout:', e.message);
  }
}

// ── Hearing test cases ───────────────────────────────────────────────────────
// Garbled STT inputs → expected intent (partial match OK)
const HEARING_CASES = [
  { text: 'hey pam opn the termnal',            expected: 'terminal' },
  { text: 'what the wether tomoro',              expected: 'query' },
  { text: 'pley somthing by kendik lamar',       expected: 'music' },
  { text: 'set a alrm for sevn AM',              expected: ['command', 'timer', 'system', 'calendar'] },
  { text: 'hey pan wats my next meating',        expected: ['calendar', 'query'] },
  { text: 'remindme to by milk latr',            expected: ['memory', 'command'] },
  { text: 'hey pan open spotify',                expected: 'music' },
  { text: 'serch for best resturants near me',   expected: ['query', 'browser'] },
  { text: 'hey pam send mesage to mom',          expected: ['command', 'social', 'memory'] },
  { text: 'pan whats the captial of france',     expected: 'query' },
];

// ── Reasoning test cases ─────────────────────────────────────────────────────
// Ambient speech NOT directed at PAN → should return intent: ambient
const REASONING_CASES = [
  "yeah I'll be there in 5 minutes",
  "can you pass me the salt",
  "no I don't think that's right",
  "let me check my phone real quick",
  "the weather looks nice today",
  "I was thinking we could go tomorrow",
  "did you see the game last night",
  "hold on let me finish this",
  "that makes sense to me",
  "ok I'll call you back",
];

// ── Floor definitions ────────────────────────────────────────────────────────
const FLOORS = {
  hearing:   8.0,   // out of 10
  reflex_ms: 400,   // P50 must be UNDER 400ms (B grade)
  clarity:   9.0,   // out of 10
  reasoning: 9.0,   // out of 10
  memory:    8.0,   // out of 10 (subjective call from multi-turn test)
  voice:     8.0,   // out of 10 (subjective)
};

// ── Helper: call route() directly ───────────────────────────────────────────
async function callRoute(text, context = {}) {
  // Lazy import so benchmark.js doesn't create a circular dep at load time
  const { route } = await import('./router.js');
  return route(text, { source: 'benchmark', ...context });
}

// ── Sub-test: Hearing ────────────────────────────────────────────────────────
async function testHearing() {
  const results = [];
  for (const { text, expected } of HEARING_CASES) {
    const t0 = Date.now();
    let intent = 'error';
    try {
      const res = await callRoute(text);
      intent = res.intent || 'unknown';
    } catch (e) {
      intent = 'error';
    }
    const expectedArr = Array.isArray(expected) ? expected : [expected];
    const correct = expectedArr.includes(intent);
    results.push({ text, expected: expectedArr, got: intent, correct, ms: Date.now() - t0 });
  }
  const correct = results.filter(r => r.correct).length;
  const score = (correct / HEARING_CASES.length) * 10;
  return { score: +score.toFixed(2), correct, total: HEARING_CASES.length, results };
}

// ── Sub-test: Reflex ─────────────────────────────────────────────────────────
async function testReflex() {
  const latencies = [];
  const SIMPLE = 'what time is it';
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    try { await callRoute(SIMPLE); } catch {}
    latencies.push(Date.now() - t0);
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const grade = p50 < 200 ? 'A' : p50 < 400 ? 'B' : p50 < 600 ? 'C' : 'D';
  return { p50_ms: p50, p95_ms: p95, grade, latencies };
}

// ── Sub-test: Clarity ────────────────────────────────────────────────────────
// Check that route() returns an object with intent + response (valid structured output)
const CLARITY_PROMPTS = [
  'what is the weather today',
  'open the terminal',
  'play some music',
  'remind me to call back',
  'what time is it',
  'set a timer for 5 minutes',
  'search for coffee shops nearby',
  'what is 2 + 2',
  'open spotify',
  'save a note: pick up groceries',
  'what day is it today',
  'show me my tasks',
  'open the PAN project',
  'how far is the moon',
  'create a new file',
  'what is the capital of Japan',
  'add milk to my grocery list',
  'send a message to Alex',
  'how many days until Friday',
  'tell me a joke',
];

async function testClarity() {
  const results = [];
  for (const prompt of CLARITY_PROMPTS) {
    let valid = false;
    try {
      const res = await callRoute(prompt);
      // Valid = has intent field + response field (string)
      valid = typeof res === 'object' && res !== null
        && typeof res.intent === 'string'
        && typeof res.response === 'string';
    } catch {}
    results.push({ prompt, valid });
  }
  const validCount = results.filter(r => r.valid).length;
  const score = (validCount / CLARITY_PROMPTS.length) * 10;
  return { score: +score.toFixed(2), valid: validCount, total: CLARITY_PROMPTS.length, results };
}

// ── Sub-test: Reasoning ──────────────────────────────────────────────────────
async function testReasoning() {
  const results = [];
  for (const text of REASONING_CASES) {
    let intent = 'error';
    try {
      const res = await callRoute(text, { source: 'voice' }); // voice source triggers ambient check
      intent = res.intent || 'unknown';
    } catch {}
    const correct = intent === 'ambient';
    results.push({ text, got: intent, correct });
  }
  const correct = results.filter(r => r.correct).length;
  const score = (correct / REASONING_CASES.length) * 10;
  return { score: +score.toFixed(2), correct, total: REASONING_CASES.length, results };
}

// ── Sub-test: Memory ─────────────────────────────────────────────────────────
// 5-turn conversation where the final turn requires referencing turn 1
async function testMemory() {
  const turns = [
    'my favorite color is electric blue',
    'what projects are you tracking right now',
    'remind me to check the build tomorrow morning',
    'what was the last thing I asked you about',
    'what is my favorite color', // requires memory of turn 1
  ];

  let history = '';
  let lastResponse = '';
  let memoryHit = false;

  for (let i = 0; i < turns.length; i++) {
    const text = turns[i];
    try {
      const res = await callRoute(text, {
        conversation_history: history,
        source: 'benchmark',
      });
      lastResponse = res.response || '';
      // Check if the final turn correctly references "electric blue"
      if (i === turns.length - 1) {
        memoryHit = lastResponse.toLowerCase().includes('electric blue') ||
                    lastResponse.toLowerCase().includes('blue');
      }
      history += `User: ${text}\nPAN: ${lastResponse}\n`;
    } catch {}
  }

  // Score: 10 if exact match, 7 if partial, 0 if missed
  const score = memoryHit ? 9 : 4;
  return { score, memoryHit, lastResponse, turns };
}

// ── Sub-test: Voice (character consistency) ──────────────────────────────────
async function testVoice(model) {
  const personality = 'Direct, sharp, never over-explains. Speaks in short punchy sentences. Never says "Certainly" or "Of course".';
  const testTurns = [
    'how are you doing today',
    'what do you think about AI',
    'tell me something interesting',
    'what should I have for dinner',
    'describe yourself in three words',
  ];

  const responses = [];
  for (const text of testTurns) {
    try {
      const res = await callRoute(text, { source: 'dashboard' });
      responses.push(res.response || '');
    } catch { responses.push(''); }
  }

  // Ask a secondary claude call to judge character consistency (score 1-10)
  const judgePrompt = `Personality definition: "${personality}"

Here are 5 responses from the AI. Score how well they maintain this personality on a scale of 1-10.
Return ONLY a JSON object like: {"score": 7, "reason": "brief reason"}

Responses:
${responses.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;

  let voiceScore = 7; // default if judge fails
  let judgeReason = 'judge unavailable';
  try {
    const judgeRaw = await claude(judgePrompt, { caller: 'benchmark_judge', timeout: 20000 });
    // Strip thinking tags
    const cleaned = judgeRaw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const judged = JSON.parse(jsonMatch[0]);
      voiceScore = Math.max(1, Math.min(10, judged.score || 7));
      judgeReason = judged.reason || '';
    }
  } catch {}

  return { score: voiceScore, reason: judgeReason, responses };
}

// ── Check pass/fail against floors ──────────────────────────────────────────
function checkFloors(scores) {
  return (
    scores.hearing   >= FLOORS.hearing   &&
    scores.reflex_ms <= FLOORS.reflex_ms &&  // lower is better
    scores.clarity   >= FLOORS.clarity   &&
    scores.reasoning >= FLOORS.reasoning &&
    scores.memory    >= FLOORS.memory    &&
    scores.voice     >= FLOORS.voice
  );
}

// ── Main export ──────────────────────────────────────────────────────────────
export async function runIntuitionBenchmark(model) {
  console.log(`[PAN Benchmark] Starting intuition suite for model: ${model}`);
  const t0 = Date.now();

  const details = {};

  console.log('[PAN Benchmark] → Hearing...');
  details.hearing = await testHearing();
  await delay(2000); // let Cerebras rate limit breathe

  console.log('[PAN Benchmark] → Reflex...');
  details.reflex = await testReflex();
  await delay(2000);

  console.log('[PAN Benchmark] → Clarity...');
  details.clarity = await testClarity();
  await delay(2000);

  console.log('[PAN Benchmark] → Reasoning...');
  details.reasoning = await testReasoning();
  await delay(2000);

  console.log('[PAN Benchmark] → Memory...');
  details.memory = await testMemory();
  await delay(2000);

  console.log('[PAN Benchmark] → Voice...');
  details.voice = await testVoice(model);

  const scores = {
    hearing:   details.hearing.score,
    reflex_ms: details.reflex.p50_ms,
    reflex_grade: details.reflex.grade,
    clarity:   details.clarity.score,
    reasoning: details.reasoning.score,
    memory:    details.memory.score,
    voice:     details.voice.score,
  };

  const passed = checkFloors(scores) ? 1 : 0;
  const elapsed = Date.now() - t0;

  // Store in DB
  try {
    insert(
      `INSERT INTO ai_benchmark (suite, model, scores, passed, details)
       VALUES (:suite, :model, :scores, :passed, :details)`,
      {
        ':suite':   'intuition',
        ':model':   model,
        ':scores':  JSON.stringify(scores),
        ':passed':  passed,
        ':details': JSON.stringify(details),
      }
    );
    console.log(`[PAN Benchmark] Stored results (passed=${passed})`);
  } catch (e) {
    console.error('[PAN Benchmark] Failed to store results:', e.message);
  }

  console.log(`[PAN Benchmark] Done in ${elapsed}ms. Scores:`, scores, `Passed: ${!!passed}`);

  // If any axis failed — wake Scout with targeted search topics
  if (!passed) {
    await notifyScoutOfFailures(scores, model);
  }

  return { scores, passed: !!passed, details, elapsed_ms: elapsed, model, suite: 'intuition' };
}

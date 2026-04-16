// service/src/perf/stages.js
//
// The single source of truth for PAN's readiness/perf formalism.
//
// Every measurable thing in PAN is a Stage. A Stage has:
//   - id:          unique key (dotted, e.g. "craft.pty_spawn")
//   - name:        human-readable label ("PTY spawned")
//   - domain:      where it runs — "carrier" | "craft" | "client"
//   - phase:       when it matters — "boot" | "attach" | "widget" | "hot_path" | "service"
//   - depends_on:  array of stage ids that must be ready first (forms a DAG)
//   - probe:       how to verify ready — { method, ...args, timeout_ms }
//   - budget:      soft/hard time limits — { warn_ms, bad_ms, hard_ms }
//   - required:    if false, failure doesn't block system_ready (on-demand services)
//   - schedule:    how often to re-probe — { tier: "boot" | "attach" | "hot" | "widget" | "service" }
//
// The engine reads this registry, runs probes, computes:
//   system_ready      = AND(stage ready for all required stages)
//   interactive_ready = AND(stage ready for INTERACTIVE_SET)
//   critical_path_ms  = longest path through the DAG for REQUIRED stages
//   swap_safe         = system_ready AND no_failures_in_window
//
// The math doc is generated from this file — edit here, doc stays in sync.

// Schedule tiers map to re-probe intervals (user-approved defaults):
//   boot:    every 60s  (carrier/craft already up, cheap to re-verify)
//   attach:  every 10s  (the attach stuff is what breaks most often)
//   hot:     on event   (hot-path = per keystroke; no polling)
//   widget:  on open    (only probe when user opens the widget)
//   service: every 60s full probe + every 5s cheap liveness (user-approved)
export const SCHEDULE = {
  boot:    { full_ms: 60_000, liveness_ms: 60_000 },
  attach:  { full_ms: 10_000, liveness_ms: 10_000 },
  hot:     { full_ms: 0,      liveness_ms: 0       }, // event-driven, no polling
  widget:  { full_ms: 0,      liveness_ms: 0       }, // on-open
  service: { full_ms: 60_000, liveness_ms: 5_000   },
};

// Stages that MUST be ready for the system to be considered functional.
// These define system_ready and drive Lifeboat auto-rollback decisions.
// Order does not matter — depends_on defines execution order.
export const STAGES = [
  // ==================== Carrier Boot ====================
  {
    id: 'carrier.boot',
    name: 'Carrier running',
    domain: 'carrier',
    phase: 'boot',
    depends_on: [],
    probe: { method: 'mark', marker: 'carrier_boot' },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 10_000 },
    required: true,
    schedule: 'boot',
    help: 'The carrier process owns the main port + Lifeboat. It should always be ready.',
  },
  {
    id: 'carrier.port_clean',
    name: 'Craft port available',
    domain: 'carrier',
    phase: 'boot',
    depends_on: ['carrier.boot'],
    // Mark-based, not recurring: Carrier sets this the moment it confirms
    // port 17700 is free (or has been cleared of stale processes) during boot,
    // immediately before spawning primary Craft. After that, Craft itself
    // owns the port — re-probing with port_unbound would ALWAYS fail, which
    // is a useless permanent-red dashboard signal.
    probe: { method: 'mark', marker: 'craft_port_clean' },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: true,
    schedule: 'boot',
    help: 'Carrier confirmed port 17700 was free (or cleared stale holders) before spawning Craft.',
  },

  // ==================== Craft Boot ====================
  {
    id: 'craft.http',
    name: 'Craft HTTP up',
    domain: 'craft',
    phase: 'boot',
    depends_on: ['carrier.boot'],
    probe: { method: 'http', port: 17700, path: '/health', expect_status: 200 },
    budget: { warn_ms: 2000, bad_ms: 5000, hard_ms: 15_000 },
    required: true,
    schedule: 'boot',
    help: 'Craft HTTP server answers /health. This is what the old swap gate checked (alone, insufficient).',
  },
  {
    id: 'craft.db',
    name: 'Database open',
    domain: 'craft',
    phase: 'boot',
    depends_on: ['craft.http'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/db', expect_status: 200 },
    budget: { warn_ms: 100, bad_ms: 500, hard_ms: 3000 },
    required: true,
    schedule: 'boot',
    help: 'Craft can SELECT 1 from SQLite. Proves schema + connection pool are working.',
  },
  {
    id: 'craft.jsonl_watcher',
    name: 'JSONL watcher live',
    domain: 'craft',
    phase: 'boot',
    depends_on: ['craft.http'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/jsonl', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 1500, hard_ms: 5000 },
    required: true,
    schedule: 'boot',
    help: 'Craft touches a test file, confirms the JSONL watcher detected the change within budget.',
  },
  {
    id: 'craft.mcp_server',
    name: 'MCP server registered',
    domain: 'craft',
    phase: 'boot',
    depends_on: ['craft.http'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/mcp', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false, // Claude CLI can work without MCP, it's degraded but not broken
    schedule: 'boot',
    help: 'MCP server lists all 15 tools. If down, Claude loses access to PAN-specific tools.',
  },

  // ==================== Attach (runs on every refresh/swap) ====================
  {
    id: 'pty.spawn',
    name: 'PTY spawn test',
    domain: 'carrier',
    phase: 'attach',
    depends_on: ['carrier.boot'],
    probe: { method: 'pty_echo', timeout_ms: 2000 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: true,
    schedule: 'attach',
    help: 'Carrier opens a throwaway PTY, writes a marker, reads it back. Proves PTY subsystem works.',
  },
  {
    id: 'ws.handshake',
    name: 'WebSocket accepts',
    domain: 'carrier',
    phase: 'attach',
    depends_on: ['carrier.boot'],
    probe: { method: 'ws_handshake', path: '/ws/terminal' },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: true,
    schedule: 'attach',
    help: 'WebSocket upgrade succeeds on /terminal. If this fails, clients cannot connect.',
  },
  {
    id: 'claude.cli',
    name: 'Claude CLI available',
    domain: 'carrier',
    phase: 'attach',
    depends_on: ['carrier.boot'],
    probe: { method: 'spawn', cmd: 'claude', args: ['--version'], timeout_ms: 5000 },
    budget: { warn_ms: 1500, bad_ms: 4000, hard_ms: 10_000 },
    required: false, // Carrier can run without Claude installed
    schedule: 'attach',
    help: 'Claude CLI executes --version in the expected time. Cold starts are slow on Windows.',
  },

  // ==================== Services (all 12 — all visible, always) ====================
  // Each service's probe is "can it actually do its job" — not "is process alive."
  {
    id: 'svc.core',
    name: 'Core',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.http'],
    probe: { method: 'http', port: 17700, path: '/health', expect_status: 200 },
    budget: { warn_ms: 200, bad_ms: 1000, hard_ms: 5000 },
    required: true,
    schedule: 'service',
    help: 'Core server — the PAN Craft process. Always required.',
  },
  {
    id: 'svc.local_intel',
    name: 'Local Intelligence',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.http'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/local_intel', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 10_000 },
    required: false,
    schedule: 'service',
    help: 'On-device Gemini Nano classifier. Used by the phone for voice routing.',
  },
  {
    id: 'svc.resonance',
    name: 'Resonance',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.http'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/resonance', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 10_000 },
    required: false,
    schedule: 'service',
    help: 'Voice-shell daemon for phone push-to-talk.',
  },
  {
    id: 'svc.whisper',
    name: 'Whisper STT',
    domain: 'external',
    phase: 'service',
    depends_on: [],
    probe: { method: 'http', port: 7782, path: '/health', expect_status: 200, timeout_ms: 1000 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'service',
    help: 'Whisper STT server on :7782. Used for dictation and phone fallback.',
  },
  {
    id: 'svc.voice_shell',
    name: 'Voice Shell',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.http'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/voice_shell', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'service',
    help: 'Voice shell router — classifies and executes voice commands.',
  },
  {
    id: 'svc.augur',
    name: 'Augur',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.db'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/augur', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'service',
    help: 'Memory classifier. Runs every 5 minutes to categorize new events.',
  },
  {
    id: 'svc.cartographer',
    name: 'Cartographer',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.db'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/cartographer', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'service',
    help: 'Builds the memory graph (entities + relations).',
  },
  {
    id: 'svc.dream',
    name: 'Dream Cycle',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.db'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/dream', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'service',
    help: 'Every 6 hours — consolidates episodic → semantic memory.',
  },
  {
    id: 'svc.archivist',
    name: 'Archivist',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.db'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/archivist', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'service',
    help: 'Long-term memory writer — persists summaries and decisions.',
  },
  {
    id: 'svc.scout',
    name: 'Scout',
    domain: 'external',
    phase: 'service',
    depends_on: [],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/scout', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 10_000 },
    required: false,
    schedule: 'service',
    help: 'Cerebras 120B background worker. Runs research tasks.',
  },
  {
    id: 'svc.orchestrator',
    name: 'Orchestrator',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.http'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/orchestrator', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'service',
    help: 'Coordinates multi-step workflows across services.',
  },
  {
    id: 'svc.evolution',
    name: 'Evolution Engine',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.db'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/evolution', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'service',
    help: 'Every 6 hours — merges / decays / bumps memory importance.',
  },
  {
    id: 'svc.forge',
    name: 'Forge',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.http'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/forge', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'service',
    help: 'Code generation + training pipeline for voice/personality packs.',
  },
  {
    id: 'svc.tether',
    name: 'Tether',
    domain: 'craft',
    phase: 'service',
    depends_on: ['craft.http'],
    probe: { method: 'http', port: 17700, path: '/api/v1/perf/probe/tether', expect_status: 200 },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'service',
    help: 'Tailscale link monitor — keeps phone connection alive.',
  },

  // ==================== Hot Path (per-keystroke) ====================
  // These are populated by client-side events, not server polling.
  {
    id: 'hot.keystroke_ack',
    name: 'Keystroke → server ack',
    domain: 'client',
    phase: 'hot_path',
    depends_on: ['ws.handshake'],
    probe: { method: 'event', event: 'sendAck' },
    budget: { warn_ms: 300, bad_ms: 1500, hard_ms: 5000 },
    required: false,
    schedule: 'hot',
    help: 'Time from pressing Enter to the /pipe endpoint returning HTTP 200.',
  },
  {
    id: 'hot.echo_back',
    name: 'Echo back on WS',
    domain: 'client',
    phase: 'hot_path',
    depends_on: ['ws.handshake'],
    probe: { method: 'event', event: 'sendEcho' },
    budget: { warn_ms: 500, bad_ms: 2000, hard_ms: 5000 },
    required: false,
    schedule: 'hot',
    help: 'Time until your own message arrives back via WebSocket.',
  },
  {
    id: 'hot.assistant_first',
    name: 'Assistant first reply',
    domain: 'client',
    phase: 'hot_path',
    depends_on: ['ws.handshake', 'claude.cli'],
    probe: { method: 'event', event: 'sendAssistant' },
    budget: { warn_ms: 5000, bad_ms: 15_000, hard_ms: 60_000 },
    required: false,
    schedule: 'hot',
    help: 'Time until the assistant\'s first token arrives via JSONL.',
  },
];

// Stages that must all be ready for the UI to be "usable."
// Used to compute interactive_ready and the "Refresh → usable" wall-clock.
export const INTERACTIVE_SET = [
  'carrier.boot',
  'craft.http',
  'craft.db',
  'pty.spawn',
  'ws.handshake',
];

// Stages that block a hot-swap from being committed.
// If any of these fail during the rollback window, Lifeboat auto-rolls back.
export const SWAP_GATE = [
  'craft.http',
  'craft.db',
  'craft.jsonl_watcher',
  'pty.spawn',
  'ws.handshake',
];

// Export a lookup map for engine use.
export const STAGE_BY_ID = Object.fromEntries(STAGES.map(s => [s.id, s]));

// Validation: make sure all depends_on references point to real stages.
for (const s of STAGES) {
  for (const dep of s.depends_on) {
    if (!STAGE_BY_ID[dep]) {
      throw new Error(`[perf/stages] ${s.id} depends on unknown stage "${dep}"`);
    }
  }
}

// ==================== Math Doc Generator ====================
// Generates the Markdown spec from this registry so the doc never drifts
// from the running code. Served at GET /api/v1/perf/trace?format=markdown.
export function toMarkdown() {
  const lines = [];
  lines.push('# PAN Performance Spec');
  lines.push('');
  lines.push('**Auto-generated from `service/src/perf/stages.js`. Do not edit by hand.**');
  lines.push('');
  lines.push('## Formulas');
  lines.push('');
  lines.push('```');
  lines.push('stage_ready(s)     = s.state == "ready" AND (now - s.last_probe_at) < stage_ttl');
  lines.push('system_ready       = AND(stage_ready(s) for s in REQUIRED stages)');
  lines.push('interactive_ready  = AND(stage_ready(s) for s in INTERACTIVE_SET)');
  lines.push('critical_path_ms   = longest path through DAG (depends_on edges)');
  lines.push('swap_safe          = AND(stage_ready(s) for s in SWAP_GATE)');
  lines.push('                     AND no_failures_since(swap_started_at)');
  lines.push('```');
  lines.push('');
  lines.push('## Schedule tiers');
  lines.push('');
  lines.push('| Tier | Full probe | Cheap liveness |');
  lines.push('|------|------------|----------------|');
  for (const [tier, sched] of Object.entries(SCHEDULE)) {
    const full = sched.full_ms ? `${sched.full_ms / 1000}s` : 'on-event';
    const live = sched.liveness_ms ? `${sched.liveness_ms / 1000}s` : 'on-event';
    lines.push(`| ${tier} | ${full} | ${live} |`);
  }
  lines.push('');
  lines.push('## Stages');
  lines.push('');
  const phases = ['boot', 'attach', 'service', 'widget', 'hot_path'];
  for (const phase of phases) {
    const phaseStages = STAGES.filter(s => s.phase === phase);
    if (!phaseStages.length) continue;
    lines.push(`### ${phase}`);
    lines.push('');
    lines.push('| ID | Name | Domain | Depends on | Probe | warn/bad/hard (ms) | Required |');
    lines.push('|----|------|--------|------------|-------|--------------------|----------|');
    for (const s of phaseStages) {
      const deps = s.depends_on.length ? s.depends_on.join(', ') : '—';
      const probe = s.probe.method;
      const budget = `${s.budget.warn_ms}/${s.budget.bad_ms}/${s.budget.hard_ms}`;
      const req = s.required ? 'yes' : 'no';
      lines.push(`| \`${s.id}\` | ${s.name} | ${s.domain} | ${deps} | ${probe} | ${budget} | ${req} |`);
    }
    lines.push('');
  }
  lines.push('## Interactive set');
  lines.push('');
  lines.push('These stages must all be ready for the UI to accept input reliably:');
  lines.push('');
  for (const id of INTERACTIVE_SET) lines.push(`- \`${id}\``);
  lines.push('');
  lines.push('## Swap gate');
  lines.push('');
  lines.push('A hot-swap is safe to commit only when all of these are ready AND no failures occurred during the rollback window:');
  lines.push('');
  for (const id of SWAP_GATE) lines.push(`- \`${id}\``);
  lines.push('');
  return lines.join('\n');
}

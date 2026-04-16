// service/src/perf/engine.js
//
// The PerfEngine — reads the stage registry, runs probes on schedule,
// maintains per-stage state, broadcasts updates, and computes:
//
//   system_ready      — AND(required stage.ready)
//   interactive_ready — AND(INTERACTIVE_SET stage.ready)
//   critical_path_ms  — longest path through DAG (actual wall-clock)
//   swap_safe         — AND(SWAP_GATE stage.ready) AND no_failures_in_window
//
// Lives on the Carrier (long-lived, survives Craft swaps).
//
// API (for other modules in carrier.js):
//   engine.start()              — begin probe loops
//   engine.stop()               — stop
//   engine.mark(markerId, ms?)  — set a "mark" probe as ready (e.g. carrier_boot)
//   engine.recordEvent(name, ms) — record a hot-path event timing (from client)
//   engine.snapshot()           — current state for HTTP /api/v1/perf/trace
//   engine.isSwapSafe()         — for Lifeboat decisions
//   engine.forceProbe(id)       — manual re-probe of one stage (for POST probe/:id)
//   engine.onChange(cb)         — subscribe to state changes (for WS broadcast)

import { STAGES, STAGE_BY_ID, SCHEDULE, INTERACTIVE_SET, SWAP_GATE } from './stages.js';
import { runProbe } from './probes.js';

export class PerfEngine {
  constructor({ carrierPort, terminalServer } = {}) {
    this.carrierPort = carrierPort || 7777;
    this.terminalServer = terminalServer || null;
    this.startedAt = Date.now();

    // Per-stage runtime state. Keyed by stage id.
    // { state, last_probe_at, last_probe_ms, ready_at, errors[] }
    this.state = {};
    for (const s of STAGES) {
      this.state[s.id] = {
        state: 'pending',
        last_probe_at: 0,
        last_probe_ms: 0,
        ready_at: 0,
        errors: [],
      };
    }

    // Manual "mark" probe values (set by carrier when boot finishes, etc.)
    this.marks = {};
    // Hot-path event timings (pushed by client via POST /api/v1/perf/event)
    this.events = {};

    // Probe timers (one per scheduled stage)
    this._timers = [];
    this._running = false;

    // Change listeners (for WS broadcast). Called with the full snapshot.
    this._listeners = [];

    // Track failures during rollback windows to feed swap_safe.
    this._swapStartedAt = 0;

    // Debounced broadcast — coalesce rapid changes into a single WS push.
    this._broadcastTimer = null;
  }

  start() {
    if (this._running) return;
    this._running = true;

    // Schedule each stage according to its tier.
    for (const s of STAGES) {
      const sched = SCHEDULE[s.schedule];
      if (!sched || !sched.full_ms) {
        // hot/widget — event-driven, no polling. Kick off one initial probe.
        this._probe(s.id).catch(() => {});
        continue;
      }

      // Initial probe, then on interval.
      this._probe(s.id).catch(() => {});
      const timer = setInterval(() => this._probe(s.id).catch(() => {}), sched.full_ms);
      this._timers.push(timer);
    }
  }

  stop() {
    this._running = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    if (this._broadcastTimer) clearTimeout(this._broadcastTimer);
  }

  // Set a "mark" probe as satisfied.
  // Used by boot code: engine.mark('carrier_boot', 0)
  mark(markerId, ms = 0) {
    this.marks[markerId] = { ms, at: Date.now() };
    // Find any stage that uses this marker and immediately probe it.
    for (const s of STAGES) {
      if (s.probe.method === 'mark' && s.probe.marker === markerId) {
        this._probe(s.id).catch(() => {});
      }
    }
  }

  // Record a hot-path event (called from the client timing endpoint).
  recordEvent(name, ms) {
    this.events[name] = { ms, at: Date.now() };
    for (const s of STAGES) {
      if (s.probe.method === 'event' && s.probe.event === name) {
        this._probe(s.id).catch(() => {});
      }
    }
  }

  async forceProbe(id) {
    return this._probe(id);
  }

  onChange(cb) {
    this._listeners.push(cb);
  }

  // Called at the start of a hot-swap rollback window.
  // swap_safe will incorporate failures after this timestamp.
  markSwapStart() {
    this._swapStartedAt = Date.now();
  }
  markSwapEnd() {
    this._swapStartedAt = 0;
  }

  isSwapSafe() {
    // All SWAP_GATE stages must be ready, no failures since swap started.
    for (const id of SWAP_GATE) {
      const st = this.state[id];
      if (!st || st.state !== 'ready') return { safe: false, reason: `${id} is ${st?.state || 'missing'}` };
      // Had an error since swap started?
      if (this._swapStartedAt) {
        const recent = st.errors.filter(e => e.at >= this._swapStartedAt);
        if (recent.length > 0) return { safe: false, reason: `${id} failed during rollback window: ${recent[0].error}` };
      }
    }
    return { safe: true };
  }

  snapshot() {
    const stages = STAGES.map(def => {
      const rt = this.state[def.id];
      return {
        id: def.id,
        name: def.name,
        domain: def.domain,
        phase: def.phase,
        depends_on: def.depends_on,
        required: def.required,
        schedule: def.schedule,
        help: def.help,
        budget: def.budget,
        probe_method: def.probe.method,
        state: rt.state,
        last_probe_at: rt.last_probe_at,
        last_probe_ms: rt.last_probe_ms,
        ready_at: rt.ready_at,
        error: rt.errors[rt.errors.length - 1]?.error || null,
      };
    });

    const requiredStages = stages.filter(s => s.required);
    const system_ready = requiredStages.every(s => s.state === 'ready');
    const interactive_stages = stages.filter(s => INTERACTIVE_SET.includes(s.id));
    const interactive_ready = interactive_stages.every(s => s.state === 'ready');

    return {
      now: Date.now(),
      engine_started_at: this.startedAt,
      system_ready,
      interactive_ready,
      swap_safe: this.isSwapSafe(),
      critical_path_ms: this._criticalPath(stages),
      counts: {
        ready: stages.filter(s => s.state === 'ready').length,
        pending: stages.filter(s => s.state === 'pending').length,
        running: stages.filter(s => s.state === 'running').length,
        failed: stages.filter(s => s.state === 'failed').length,
        total: stages.length,
      },
      stages,
    };
  }

  // ==================== internals ====================

  async _probe(id) {
    const def = STAGE_BY_ID[id];
    if (!def) return;
    const rt = this.state[id];

    // Don't probe if deps haven't been ready at least once — mark pending.
    // A dep that was ready before but is currently re-probing (state="running")
    // still counts as ready: it has a recent valid result, the re-probe hasn't
    // invalidated it yet. Without this, every 60s re-probe cascades "pending"
    // through the whole DAG and the dashboard flaps red.
    for (const depId of def.depends_on) {
      const dep = this.state[depId];
      const depReady = dep && (dep.state === 'ready' || (dep.state === 'running' && dep.ready_at > 0));
      if (!depReady) {
        if (rt.state !== 'pending') {
          rt.state = 'pending';
          this._notifyChange();
        }
        return;
      }
    }

    const wasReady = rt.state === 'ready';
    rt.state = 'running';
    const ctx = {
      carrierPort: this.carrierPort,
      primaryCraftPort: this.primaryCraftPort || 17700,
      terminalServer: this.terminalServer,
      marks: this.marks,
      events: this.events,
      currentBudget: def.budget,
    };
    const result = await runProbe(def.probe, ctx);
    rt.last_probe_at = Date.now();
    rt.last_probe_ms = result.ms || 0;

    if (result.ok) {
      if (!rt.ready_at) rt.ready_at = rt.last_probe_at;
      rt.state = 'ready';
      // Cascade: the first time this stage becomes ready, kick off any
      // stages that depend on it. Otherwise dependents sit in "pending"
      // until their own polling interval fires (up to 60s for boot tier),
      // which inflates critical_path_ms and stalls the dashboard.
      if (!wasReady) {
        for (const other of STAGES) {
          if (other.id === id) continue;
          if (other.depends_on.includes(id)) {
            this._probe(other.id).catch(() => {});
          }
        }
      }
    } else {
      rt.state = 'failed';
      rt.errors.push({ at: Date.now(), error: result.error || 'unknown' });
      if (rt.errors.length > 20) rt.errors.splice(0, rt.errors.length - 20);
    }

    this._notifyChange();
  }

  _notifyChange() {
    if (this._broadcastTimer) return;
    this._broadcastTimer = setTimeout(() => {
      this._broadcastTimer = null;
      const snap = this.snapshot();
      for (const cb of this._listeners) {
        try { cb(snap); } catch {}
      }
    }, 100);
  }

  // Longest path through the DAG of required stages = actual wall-clock cost.
  // Uses ready_at - engine_started_at for duration per node.
  _criticalPath(stages) {
    const byId = Object.fromEntries(stages.map(s => [s.id, s]));
    const memo = {};
    const durationOf = (s) => {
      if (s.state !== 'ready' || !s.ready_at) return 0;
      return Math.max(0, s.ready_at - this.startedAt);
    };
    const pathTo = (id) => {
      if (memo[id] !== undefined) return memo[id];
      const s = byId[id];
      if (!s) return 0;
      if (!s.depends_on || s.depends_on.length === 0) {
        memo[id] = durationOf(s);
        return memo[id];
      }
      let maxDep = 0;
      for (const dep of s.depends_on) {
        const v = pathTo(dep);
        if (v > maxDep) maxDep = v;
      }
      // Our duration already includes time-since-start, so we take the max
      // of our own finish time vs. the longest dep finish time.
      memo[id] = Math.max(maxDep, durationOf(s));
      return memo[id];
    };

    let longest = 0;
    for (const s of stages) {
      if (!s.required) continue;
      const v = pathTo(s.id);
      if (v > longest) longest = v;
    }
    return longest;
  }
}

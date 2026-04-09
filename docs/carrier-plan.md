# Carrier — The 7-Phase Plan

**Status:** designed 2026-04-07. Phases 1–2 done, parts of Phase 3 in progress.
**North-star:** drive PAN restart count toward zero.

Carrier is the long-lived runtime that holds **Craft** (running PAN versions),
hot-swaps them with zero downtime, and gives AutoDev (Forge) a substrate to
launch and test variants against real traffic.

See also: `project_carrier.md`, `project_autodev_moat.md`,
`project_visual_comparison_funnel.md`, `project_guardian_tripwire.md`,
`project_restart_count.md` in memory.

---

## Vocabulary
- **Carrier** — long-lived runtime. Owns the listening socket and PTYs. Almost never restarts.
- **Craft** — one running version of a PAN service. Carrier holds many.
- **Lifeboat** — tiny embedded HTTP rollback listener inside Carrier (~50 lines, no deps).
- **Shadow Traffic** — mirrored real requests sent to a Craft for comparison without affecting the live response.
- **Forge** — AutoDev's themed name. Hammers out Craft variants.
- **Crucible** — user-facing variant grid where Forge's candidates are compared and the winner picked.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Carrier (long-lived, almost never restarts)        │
│  - owns listening socket :7777                      │
│  - owns all PTYs                                    │
│  - holds reconnect-token registry                   │
│  - runs Lifeboat (rollback listener)                │
│  - launches and lands Craft                         │
└────────────┬─────────────────────┬──────────────────┘
             │                     │
        ┌────▼────┐           ┌────▼────┐
        │ Craft A │           │ Craft B │
        │ ACTIVE  │           │ STANDBY │
        └─────────┘           └─────────┘
```

## Rolling deploy flow (0ms user-visible downtime)
1. Carrier launches Craft B with new code, hands it the listening socket
2. B boots, runs health check, signals **ready**
3. Carrier flips active flag from A to B
4. New HTTP requests are accepted by B
5. A enters **drain mode**: finishes in-flight, sends `{type:"server_swap", reconnect_token}` to every WS client
6. WS clients reconnect with token → B restores subscriptions
7. Once A has zero in-flight HTTP and zero WS clients → Carrier retires A

Three layers of rollback safety: 60s auto-revert timer, persistent overlay UI
hitting Lifeboat (not Craft B), and AHK/phone escape hatches.

---

# The 7 Phases

## Phase 1 — Foundations ✅ DONE
Pre-Carrier infrastructure that the runtime depends on.
- `reap-orphans.js` — kills stale Claude/node on startup with safe ancestor filtering
- PTY exit detection — `PtyExit` events logged, red crash banner, thinking state clears
- AHK respawn loop fixed — exponential backoff with hard stop
- `db-registry.js` — multi-DB registry for variant scoping
- Dual-mode (Session 1 user context) refactor — node-pty conpty agent works

## Phase 2 — Carrier + Lifeboat + Craft Swap ✅ DONE (basic)
- ~300-line Carrier process that owns the listening socket
- Passes socket to each Craft via `child.send(socket)` (cluster pattern)
- Lifeboat embedded HTTP listener for rollback + status (no deps)
- Three-layer rollback safety wired:
  - Layer 1: 60s auto-rollback timer
  - Layer 2: floating overlay outside dashboard component tree
  - Layer 3: AHK `Win+Shift+R` + phone Settings rollback button
- Kills ~70% of restart count immediately

## Phase 3 — Reconnect Tokens + WS Continuity 🚧 IN PROGRESS
- Carrier holds reconnect-token registry across swaps
- WS clients receive `server_swap` message and reconnect with token
- New Craft restores their subscriptions transparently
- Target: <50ms WS disconnect/reconnect, invisible to user

## Phase 4 — PTY Handoff
- Move PTY ownership fully to Carrier so Craft never owns terminal processes
- Transfer via Unix domain socket / Windows named pipe (fiddly on Windows)
- Terminal sessions survive Craft swap with zero scrollback loss

## Phase 5 — Claude Session Handoff
- Trigger at ~95% of context window (Claude Opus 4.6 1M = ~950k)
- Old Claude session writes a tight 200–500 token brief of current state
- Carrier launches new Claude Craft, injects brief + transcript pointer
- Same terminal, same scrollback — only the underlying PID changes
- Auto-deferred while user is typing
- This is **PAN Remembers as invisible infrastructure** — ~3–5s instead of ~30s, no CLAUDE.md file IO, no SessionStart hook chain

## Phase 6 — Shadow Traffic + Variant Routing (Forge unlock)
- Mirror real requests to active Craft AND one or more shadow Craft
- Compare outputs, latency, error rates
- Canary deploys: route 10% of real traffic to new Craft
- Multi-tenant experiments via existing db-registry scoping
- Auto-promote winners, auto-retire losers based on restart count, error rate, latency
- This is what makes AutoDev *qualitatively* different from "agent that edits files"

## Phase 7 — Crucible (Visual Variant Comparison)
- User-facing variant grid where Forge's N candidate Craft are surveyed
- L1 / L2 / L3 funnel for fast variant comparison without vision-LLM bottleneck (see `project_visual_comparison_funnel.md`)
- User picks the winner from survivors
- Winner gets promoted via the standard rolling deploy flow

---

## State transfer table

| State | Lives in | Survives swap because |
|---|---|---|
| HTTP request handlers | Craft | new Craft takes the socket |
| WebSocket clients | Craft → reattach | Carrier holds reconnect tokens |
| **PTY terminal processes** | **Carrier** | Craft never owned them |
| SQLite DB | shared file | WAL mode handles concurrent reads |
| In-memory caches | Craft (lost on swap) | rebuilt by new Craft |
| Memory-search vec index | shared file | same DB |
| Steward services | Craft | re-registered on boot |
| Transcript watchers | Craft | re-opens at same file offset |

---

## Honest scope warning
This is real systems engineering, not a 30-min patch. Restructures the boot
path, moves PTY ownership, needs careful Windows testing for domain sockets /
named pipes. Once shipped, every PAN service inherits lifecycle constraints
(init / dispose / handoff). Worth it because the payoff matches the product
thesis exactly.

## Inspiration / prior art
- **Erlang/OTP hot code loading** — used by WhatsApp, Discord. Decades of production proof.
- **Phoenix LiveView** — live module reloads with stateful WebSocket continuity.
- **Kubernetes rolling deploys** — same pattern, container-level instead of in-process.
- **No consumer dev tool currently does this.** Replit Agent, Cursor, Devin, Aider, OpenInterpreter — none have a runtime substrate. Genuinely novel for the AI-developer-tool space.

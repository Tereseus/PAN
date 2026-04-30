# Super-Carrier Architecture

## Overview

PAN runs a three-tier process hierarchy. From outermost to innermost:

```
Super-Carrier (port 7777, permanent)
    └─ Carrier (port 17760, restartable)
           └─ Craft (port 17700+, hot-swappable)
```

Each layer can be restarted independently. The outermost layer never restarts.
Browsers and phones always connect to port 7777 — they never see the internal ports.

---

## Roles

### Super-Carrier (`service/src/super-carrier.js`)
- **Port:** 7777 (public-facing — the only port browsers/phones/phone use)
- **Never restarts** — lives for the lifetime of the machine session
- **Owns:** All incoming HTTP and WebSocket connections
- **Proxies to:** Carrier on port 17760
- **WebSocket buffering:** Stores up to 200 WS frames in memory during Carrier
  restarts. Browser holds its connection open; frames replay when Carrier comes back.
- **Health endpoint:** Responds to `GET /health` instantly even during Carrier restarts
- **Spawns Carrier as:** a `node carrier.js` child process with `fork()`
- **Env vars injected into Carrier:**
  - `PAN_PORT` — public port (7777)
  - `PAN_CARRIER_INTERNAL_PORT` — Carrier's own port (17760)
  - `PAN_UNDER_SUPER_CARRIER=1` — tells Carrier it's not the outer process
- **Health polling:** Probes `http://localhost:17760/health` every 300ms to detect
  when Carrier has finished restarting
- **Auto-respawn:** If Carrier exits with non-zero code, Super-Carrier immediately
  respawns it. Exit code 0 = intentional stop (clean shutdown).

### Carrier (`service/src/carrier.js`)
- **Port:** 17760 (internal only — not exposed outside localhost)
- **Restartable** via `POST /api/carrier/restart`
- **Owns:** PTY sessions, WebSocket sessions, reconnect tokens, perf engine, Steward
- **Proxies to:** Craft on port 17700 (and 17701 for beta pipeline)
- **Writes reconnect tokens to DB** before restarting so PTYs survive
- **Respawns Craft on startup** — no Craft is carried across Carrier restarts

### Craft (`service/src/server.js`)
- **Port:** 17700 (primary), 17701 (beta)
- **Hot-swappable** via `POST /api/carrier/swap` (Lifeboat widget)
- **Owns:** HTTP routes, DB handlers, MCP server, dashboard routes, all business logic
- **Does NOT own:** PTY sessions, WebSocket, reconnect tokens (those stay in Carrier)

---

## When to Use Each Restart

| Changed file | Use |
|---|---|
| `super-carrier.js` | Restart the machine / `PAN.bat` |
| `carrier.js`, `stages.js`, `probes.js`, `engine.js` | `POST /api/carrier/restart` |
| Everything else (`server.js`, routes, schema, MCP) | `POST /api/carrier/swap` (Lifeboat) |

---

## What Survives Each Restart Type

| What | Craft swap | Carrier restart | Super-Carrier restart |
|---|---|---|---|
| PTY sessions | ✅ | ✅ (via reconnect tokens) | ❌ |
| Claude CLI children | ✅ | ✅ (if token reattach succeeds) | ❌ |
| WebSocket (browser) | ✅ | ✅ (Super-Carrier buffers frames) | ❌ |
| DB connections | ✅ | ✅ | ✅ |
| In-flight requests | ✅ (old Craft serves them) | ❌ | ❌ |
| Perf engine state | ✅ | ❌ | ❌ |

---

## Startup Sequence

```
1. PAN.bat (or pan-loop.bat) spawns: node super-carrier.js
2. Super-Carrier binds port 7777
3. Super-Carrier forks: node carrier.js (on port 17760)
4. Carrier binds 17760, runs port-cleanup on 17700, spawns Craft
5. Craft binds 17700, runs startup: DB, routes, MCP, services
6. Craft answers /health on 17700
7. Super-Carrier confirms 17760 is up (polls every 300ms)
8. Traffic flows: browser → 7777 → 17760 → 17700
```

---

## Port Map

| Port | Process | Accessible from |
|---|---|---|
| 7777 | Super-Carrier | Browser, phone, Tailscale, Cloudflare tunnel |
| 17760 | Carrier | localhost only |
| 17700 | Craft (primary) | localhost only |
| 17701 | Craft (beta) | localhost only |
| 17702+ | Craft (pending) | localhost only |
| 7781 | Dev server (full copy) | localhost only |
| 7790 | Tauri shell | localhost only |

---

## Services Panel Display

The dashboard Services panel shows all three layers:

```
Super-Carrier  PID xxxxx  port 7777   uptime Xh Ym
Carrier        PID xxxxx  port 17760  uptime Xh Ym
Craft          PID xxxxx  port 17700  uptime Xm Ys  [Lifeboat ↻]
```

Carrier uptime resets on `POST /api/carrier/restart`.
Craft uptime resets on every Lifeboat swap.
Super-Carrier uptime only resets on machine restart.

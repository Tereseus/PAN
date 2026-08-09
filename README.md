# ΠΑΝ — Personal AI Network

A local-first memory layer for your own machine. PAN watches what you do, records it to an encrypted database on your hardware, and exposes it to Claude Code (or any MCP client) so your AI tooling has continuous context instead of starting cold every session.

Your data stays on your disk. The database is local and encrypted, and the models run on your own hardware via Ollama.

One honest caveat: voice requests default to a cloud model first because latency is what makes voice usable, so prompt text does leave the machine on that path. Pin the chain to a single local model and nothing does. See [Fallback chain](#fallback-chain).

---

## What it actually is

Three things, wired together:

1. **A capture layer.** Foreground window tracking, periodic screen analysis, and optional webcam presence detection write structured events to a local database.
2. **A local model.** Gemma 4 (`gemma4:e2b`) runs under Ollama and handles classification, vision, and chat. Embeddings come from `qwen3-embedding:0.6b` at 1024 dimensions.
3. **An MCP server.** Claude Code connects to it and can query everything above — search memory, read past sessions, look up what you were doing on a given day, record notes.

That is the core. If you strip everything else out, PAN is an encrypted SQLite database with vector search, a local model that indexes it, and an MCP endpoint that lets an AI assistant read it.

## Storage and search

- **SQLite with SQLCipher** at `%LOCALAPPDATA%/PAN/data/pan.db`, encrypted at rest
- **FTS5** for full-text search across events and conversations
- **sqlite-vec** virtual tables for semantic search over 1024-dim embeddings
- Junk telemetry is filtered before storage and embedding (`service/src/event-filters.js`) so the database stays useful rather than merely large

## Models

Configured in the `models` table, not hardcoded. Defaults:

| Job | Provider | Model |
|-----|----------|-------|
| `chat_local` | `ollama@local` | `gemma4:e2b` |
| `vision` | `ollama@local` | `gemma4:e2b` |
| `embedding` | `ollama@local` | `qwen3-embedding:0.6b` |

`ollama@local` means Ollama on the same machine as PAN. Point a job at `ollama@<hostname>` to use another device on your network instead. `gemma4:e4b` is the heavier option if you have the RAM and want better vision detail.

### Fallback chain

Requests walk a chain of backends and move to the next one on failure. The default order depends on what is asking:

| Caller | Default chain |
|--------|---------------|
| Voice | cloud reasoning → cloud fallback → local |
| Background jobs | local → cloud reasoning |

Voice goes cloud-first because latency is what makes a voice assistant usable, and a stalled first token is caught by a 7 second watchdog. Background work goes local-first because nothing is waiting on it.

Override either with the `ai_fallback_chain_voice` and `ai_fallback_chain_background` settings. **Set a chain to a single entry to disable fallback entirely** and keep every request on one backend, which is the configuration to use if you want nothing leaving the machine. Vision analysis is local-only regardless.

## Components in this repo

| Path | What it is |
|------|-----------|
| `service/` | The server. Node.js, Express, SQLite, MCP server, model routing. |
| `service/dashboard/` | SvelteKit dashboard — terminal, projects, data browser, settings. |
| `android/` | Android app. Voice and text control, memory lookups, command dispatch. See below. |
| `browser-extension/` | Manifest V3 extension for reading and controlling browser tabs. |
| `pan-client/` | Agent for other machines on your network. Registers over WebSocket, receives commands. |

The dashboard and phone app are optional. The server, database, and MCP endpoint are the parts that matter.

### The Android app

A remote for the database on your computer, by voice or text. Speech is captured with Google's on-device STT and sent to the hub over Tailscale, so it works from anywhere without exposing a port.

**Memory lookups.** Ask what you were working on last Tuesday, or what was said about a topic, and it searches the database on your computer and answers. Voice requests take the cloud-first chain above, so answers come back in about a second rather than waiting on local inference.

**Commands to your machines.** Any computer running `pan-client` registers with the hub over WebSocket and accepts dispatched commands, so the phone can drive machines it is not on.

**Home Assistant control is planned, not built.** `docs/HOME-ASSISTANT.md` is a design document with no implementation behind it yet. Do not clone this expecting to control your house.

---

## Quick Start

```bash
git clone https://github.com/Tereseus/PAN.git
cd PAN/service
npm install
node pan.js start
```

Dashboard at `http://localhost:7777/v2/terminal`.

You will also need [Ollama](https://ollama.com) with the models pulled:

```bash
ollama pull gemma4:e2b
ollama pull qwen3-embedding:0.6b
```

### Connecting Claude Code

The repo ships a `.mcp.json` pointing at `service/src/mcp-server.js`. Claude Code picks it up automatically when you open the project. Set `PAN_BASE_URL` if your hub runs on another machine.

### Dev server

```bash
PAN_DEV=1 PAN_PORT=7781 node pan.js start --no-carrier
```

Separate port and database, so it cannot corrupt production data.

---

## Runtime

PAN runs as three nested processes so code can be reloaded without dropping connections:

| Process | Port | Role |
|---------|------|------|
| Super-Carrier | 7777 | Permanent. Owns the public port, buffers WebSocket frames during reloads. |
| Carrier | 17760 | Restartable. WebSocket, PTY sessions, reconnect tokens. |
| Craft | 17700+ | Hot-swappable. This is `server.js` — the part you actually edit. |

Swapping the Craft reloads server code while terminals and running sessions survive. Restarting the Carrier does not.

---

## Secrets

Secrets are read from the environment first, then the database. Never commit them.

```
PAN_ANTHROPIC_API_KEY=...
PAN_CEREBRAS_API_KEY=...
PAN_TAILSCALE_OAUTH_CLIENT_SECRET=...
```

`service/src/secrets.js` omits these from API responses rather than masking them, so they cannot leak through the settings endpoint.

---

## System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | Any i5 (2018+) | i5 10th gen or newer |
| RAM | 8 GB | 16 GB |
| Storage | 128 GB SSD | 256 GB+ SSD |
| OS | Windows 10/11 | Windows 11 |

Roughly 1.5 MB/day of text data. A local model needs enough RAM to hold Gemma 4 resident; `keep_alive: -1` pins it so the first request of the day is not slow.

---

## Key Files

| File | Purpose |
|------|---------|
| `service/src/server.js` | Craft — routes, API, boot sequence |
| `service/src/carrier.js` | Carrier — HTTP, PTY, WebSocket, hot-swap orchestration |
| `service/src/mcp-server.js` | MCP server — the interface Claude Code talks to |
| `service/src/db.js` | Schema, migrations, model registry |
| `service/src/llm-fallback.js` | Model fallback chain and per-provider timeouts |
| `service/src/secrets.js` | Env-first secret resolution, response redaction |
| `service/src/memory/semantic.js` | Fact extraction, deduplication, contradiction detection |
| `service/src/event-filters.js` | Drops junk telemetry before it reaches storage or embeddings |
| `service/src/screen-watcher.js` | Periodic screen analysis via the local vision model |
| `service/src/activity-tracker.js` | Foreground window tracking |

---

## Status

**Working:** local capture and storage, semantic + full-text search, MCP integration with Claude Code, local Gemma 4 for chat and vision, the fallback chain, dashboard, Android app for voice and text, browser extension, command dispatch to other machines over Tailscale, hot-swap runtime.

**Rough edges:** the installer is unfinished and the dashboard has known bugs. If you pin the chain to a local-only model, expect voice latency to track your hardware rather than the sub-second cloud path.

**Not built:** Home Assistant control. `docs/HOME-ASSISTANT.md` describes an intended design and nothing implements it.

---

## Notes

PAN does not require a specific AI provider. Any project with a `.pan` file gets captured regardless of which assistant you use. The model is pluggable; the data is yours and stays on your disk.

**License:** Open Source

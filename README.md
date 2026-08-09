# ΠΑΝ — Personal AI Network

A local-first memory layer for your own machine. PAN watches what you do, records it to an encrypted database on your hardware, and exposes it to Claude Code (or any MCP client) so your AI tooling has continuous context instead of starting cold every session.

Everything runs locally. The database is on your disk, the models run on your own GPU/CPU via Ollama, and nothing is sent to a cloud provider unless you configure a fallback and it is actually needed.

---

## What it actually is

Three things, wired together:

1. **A capture layer.** Foreground window tracking, periodic screen analysis, and optional webcam presence detection write structured events to a local database.
2. **A local model.** Gemma 4 (`gemma4:e4b`) runs under Ollama and handles classification, vision, and chat. Embeddings come from `qwen3-embedding:0.6b` at 1024 dimensions.
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
| `chat_local` | `ollama@local` | `gemma4:e4b` |
| `vision` | `ollama@local` | `gemma4:e4b` |
| `embedding` | `ollama@local` | `qwen3-embedding:0.6b` |

`ollama@local` means Ollama on the same machine as PAN. Point a job at `ollama@<hostname>` to use another device on your network instead.

Requests fall back in order: local Gemma 4 → Cerebras → Claude. If the local model answers, nothing leaves the machine. Vision analysis is deliberately local-only.

## Components in this repo

| Path | What it is |
|------|-----------|
| `service/` | The server. Node.js, Express, SQLite, MCP server, model routing. |
| `service/dashboard/` | SvelteKit dashboard — terminal, projects, data browser, settings. |
| `android/` | Android app. Voice capture via Google STT, talks to the server over Tailscale. |
| `browser-extension/` | Manifest V3 extension for reading and controlling browser tabs. |
| `pan-client/` | Agent for other machines on your network. Registers over WebSocket, receives commands. |

The dashboard and phone app are optional. The server, database, and MCP endpoint are the parts that matter.

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
ollama pull gemma4:e4b
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

**Working:** local capture and storage, semantic + full-text search, MCP integration with Claude Code, local Gemma 4 for chat and vision, model fallback chain, dashboard, Android voice app, browser extension, multi-machine clients over Tailscale, hot-swap runtime.

**Rough edges:** the installer is unfinished, the dashboard has known bugs, and voice latency depends heavily on how fast your local model answers.

---

## Notes

PAN does not require a specific AI provider. Any project with a `.pan` file gets captured regardless of which assistant you use. The model is pluggable; the data is yours and stays on your disk.

**License:** Open Source

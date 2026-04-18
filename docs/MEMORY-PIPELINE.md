# ΠΑΝ Memory Pipeline

This document defines the exact flow for session memory and context injection.
**Read this before touching hooks.js, terminal.js, or anything that writes to CLAUDE.md.**

---

## What "ΠΑΝ Remembers" Actually Is

When a new tab opens, Claude reads CLAUDE.md and outputs "ΠΑΝ Remembers: ..." as its
first message. That text is Claude summarizing what's in the `<!-- PAN-CONTEXT -->` block.
It is NOT hardcoded anywhere — it's Claude reading injected context and condensing it.

---

## Full Pipeline: Tab Open → ΠΑΝ Remembers

```
User opens new tab (dashboard + button)
        │
        ▼
terminal.js: PTY session created
        │
        ├─ session.claudeSessionIds = []   ← tab starts with no Claude sessions yet
        │
        ▼
terminal.js:786 — injectSessionContext(cwd, orgId, tabClaudeSessionIds)
        │
        │   ┌─ PART 1: This Tab ──────────────────────────────────────────┐
        │   │ Query: events WHERE session_id IN (tabClaudeSessionIds)     │
        │   │ Shows: what THIS specific PTY tab was working on            │
        │   │ Limit: 12 events, 2000 chars                                │
        │   └─────────────────────────────────────────────────────────────┘
        │
        │   ┌─ PART 2: Recent Project Work ───────────────────────────────┐
        │   │ Query: most recent session WHERE data LIKE '%cwd%'          │
        │   │        AND session_id NOT IN (tabClaudeSessionIds)          │
        │   │ Note: uses UserPromptSubmit to find session (Stop events    │
        │   │       do NOT embed cwd in their data)                       │
        │   │ Shows: what the project was doing in OTHER recent tabs      │
        │   │ Limit: 10 events, 1800 chars                                │
        │   └─────────────────────────────────────────────────────────────┘
        │
        │   ┌─ TASKS ─────────────────────────────────────────────────────┐
        │   │ Query: project_tasks WHERE project_id = X AND status != done│
        │   │ Format: [#id status P<priority>] title                      │
        │   │ #id allows auto-closer to pattern-match and close tasks     │
        │   │ Limit: 10 tasks, 600 chars                                  │
        │   └─────────────────────────────────────────────────────────────┘
        │
        │   Total cap: 4100 chars (~1025 tokens)
        │   Written to CLAUDE.md between <!-- PAN-CONTEXT-START/END -->
        │
        ▼
Claude launches: claude -p --model <model>
        │
        ▼
Claude reads CLAUDE.md (including injected context)
        │
        ▼
Claude outputs: "ΠΑΝ Remembers: [summary of This Tab + Recent Project Work]"
        │
        ▼
Session runs — user ↔ Claude exchange
        │
        ▼
Each exchange: hooks fire → events stored in DB
  • UserPromptSubmit → event { session_id, data: { prompt, cwd, ... } }
  • Stop            → event { session_id, data: { last_assistant_message } }
  NOTE: Stop events do NOT store cwd — only UserPromptSubmit does.
        │
        ▼
Tab closes / SessionEnd hook fires
        │
        ▼
hooks.js:SessionEnd — injectSessionContext(cwd, orgId, [sessionId])
        │   Updates CLAUDE.md so the NEXT tab that opens sees this session
        │   in Part 2 (Recent Project Work)
        ▼
Done — next tab open restarts from top of pipeline
```

---

## Key Files

| File | Function | What it does |
|------|----------|--------------|
| `service/src/routes/hooks.js` | `injectSessionContext(cwd, orgId, tabClaudeSessionIds)` | Builds and writes CLAUDE.md context block |
| `service/src/terminal.js` | `pipeSetModel(sessionId, modelId)` | Switches model — pipe mode via adapter, PTY mode via `/model` command |
| `service/src/terminal.js` | line ~786 | Calls inject before Claude launches |
| `service/src/server.js` | `POST /api/v1/inject-context` | API endpoint — accepts `{ cwd, tab_session_ids }` |
| `CLAUDE.md` | `<!-- PAN-CONTEXT-START/END -->` | Injection target markers |

---

## Noise Filters (Never Injected)

These prompt patterns are stripped from context injection to prevent loops:

- `<task-...` — task notification XML
- `<tool-use-id>` — raw tool receipts
- `You are PAN` — background agent calls
- `CURRENT STATE` — dream cycle state dumps
- `ΠΑΝ Remembers:` / `PAN Remembers:` — **self-injection loop breaker**
- Empty strings (length < 2)

---

## Model Switching

**PTY mode** (Claude TUI in dashboard): `pipeSetModel` sends `/model <name>\r` to the PTY.
This uses Claude Code's built-in `/model` command — no tab restart needed.

**Pipe mode** (Agent SDK): `pipeSetModel` calls `_llmAdapter.setModel(modelId)` directly.

The dashboard model dropdown calls `POST /api/v1/terminal/set-model` with `{ session_id, model }`.

---

## Task Auto-Closer Integration

Tasks are injected with their DB id:
```
- [#42 in_progress P1] Multi-channel send — Discord, email, Signal
```

The auto-closer watches Claude's output for `#\d+` references and can mark tasks done
when Claude says things like "completed #42" or "closed #42 ✓".

---

## Injection Limits

| Section | Event limit | Char limit |
|---------|-------------|------------|
| This Tab | 12 events | 2000 chars |
| Recent Project Work | 10 events | 1800 chars |
| Tasks | 10 tasks | ~600 chars |
| **Total hard cap** | — | **4100 chars** |

Alert fires at 4000 chars (`INJECTED_CONTEXT_WARN`). CLAUDE.md total warned at `CLAUDE_MD_WARN_SIZE`.

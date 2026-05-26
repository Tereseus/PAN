# Voice Router Test Matrix — Epic #986 + Fallback #996

> **Save-point doc — referenced from tasks #993, #994, #995, #996.**
> When you (Claude) read this in a future session, this is the test plan
> the user expected to see in "ΠΑΝ Remembers". Walk through it row by row.

## Terminology

| Term | Means |
|---|---|
| **phone** | The literal Android app (`android/app/...`) — Google STT → server router via `/api/v1/query`. |
| **dashboard voice** | The browser dashboard's talk-to-PAN UI — Whisper → `/api/v1/chat/stream`. |
| **non-streaming chat** | `/api/v1/chat` (returns full response in one JSON). |

These are NOT the same surface. Bugs are often specific to one path.

## What shipped (server-side, committed)

| Batch / Task | Commit | Status | What runs |
|---|---|---|---|
| #986 Batch 1 — situation/memory/mind blocks | (prior session) | ✅ done | router prompt injection |
| #986 Batch 2 — streaming + cancellation | a425981 | ✅ done | `/api/v1/chat/stream`, `/api/v1/cancel`, AbortSignal in `askAIStream` |
| #986 Batch 3 — conv:idle trigger | (already shipped) | ✅ done | intuition emits `conv:idle` 10–30min |
| #986 Batch 4 — TTS prosody | a425981, 827ccb5 | ✅ done | `tts-prosody.js`, attached to `done` events, `/api/v1/chat` + `/api/v1/query` |
| #996 — AI backend fallback chain | af64cc4 | ✅ done | `llm-fallback.js`, wired into `handleUnified` + `routeStream` |

## What is NOT shipped (waiting on phone-side work)

| Task | Status | Blocker |
|---|---|---|
| #993 Batch 2 phone | in_progress | Android: SSE consumer + barge-in cancel call |
| #994 Batch 4 phone | done | Android: prosody → Piper/Android TTS rate/pitch |
| #995 chunk-extractor early finalize | in_progress | router.js extractResponseField bug — breaks loop too early |

## Test matrix

| # | Surface | Path | How to invoke | Expected | Verifies |
|---|---|---|---|---|---|
| T1 | non-streaming chat | `/api/v1/chat` | `curl -X POST http://127.0.0.1:7777/api/v1/chat -d '{"message":"hi","source":"dashboard"}' -H "Content-Type: application/json"` | JSON with `response`, `intent`, `prosody`, `importance` | Batch 4 prosody surfaced |
| T2 | dashboard voice | `/api/v1/chat/stream` | dashboard mic → Whisper → stream | SSE: `stream_start` → N×`chunk` → `done` with `result.prosody` | Batch 2 streaming + Batch 4 prosody |
| T3 | dashboard voice barge-in | `/api/v1/cancel` | start streaming, then `curl -X POST .../api/v1/cancel -d '{"stream_id":"..."}'` | `done` event with `cancelled: true` | Batch 2 cancel |
| T4 | phone | `/api/v1/query` | phone app sends voice → STT → query | JSON with `response`, `prosody`, `importance` | Batch 4 phone surface |
| T5 | phone streaming | `/api/v1/query/stream` | phone app SSE consume | SSE chunks + done | #993 (not shipped) |
| T6 | conv:idle | wait 10+ min silent | observe intuition tick | `conv:idle` candidate emitted | Batch 3 |
| T7 | fallback — happy path | normal chat | `/api/v1/chat` with any message | `debug.served_by` absent (single attempt) | #996 no regression |
| T8 | fallback — bad first link | set chain | `INSERT INTO settings (key,value) VALUES ('ai_fallback_chain_voice','["cerebras:does-not-exist-xyz","cerebras:qwen-3-235b"]')` then chat | `debug.served_by = "cerebras:qwen-3-235b"`, `debug.fallback_attempts` has 2 entries (404 then ok) | #996 fallback fires |
| T9 | fallback — telemetry | after T8 | `SELECT data FROM events WHERE event_type='ai_fallback_attempt' ORDER BY id DESC LIMIT 5` | rows for both attempts with reason | #996 events |
| T10 | fallback — disabled | opt-out | `INSERT INTO settings (key,value) VALUES ('ai_fallback_enabled','false')` then T8 | chain = `[ai_model]` only, no retries | #996 opt-out |
| T11 | prosody for low importance | say something casual | response has `prosody.rate ≈ 0.92`, `prosody.pitch ≈ 0.95` | Batch 4 importance < 0.3 banding |
| T12 | prosody question rise | model emits `"response": "...?"` | `prosody.segments` has a final-rise entry with `pitch: 1.05` | Batch 4 trailing-? |
| T13 | chunk extractor bug | streaming voice request | observe done event — `result.response` is "I didn't catch that..." while chunks streamed correct text | #995 reproduction |

## Critical commands

```bash
# Service health
curl -s http://127.0.0.1:7777/health

# Hot-swap Craft (load new server code WITHOUT killing this Claude session)
curl -s -X POST http://127.0.0.1:7777/api/carrier/swap

# Inspect fallback telemetry
node -e "import('./service/src/db.js').then(m => console.log(JSON.stringify(m.all(\"SELECT data FROM events WHERE event_type='ai_fallback_attempt' ORDER BY id DESC LIMIT 10\"), null, 2)))"

# Force a fallback test (clean up after!)
node -e "import('./service/src/db.js').then(m => { m.run(\"INSERT OR REPLACE INTO settings (key,value) VALUES ('ai_fallback_chain_voice', :v)\", { ':v': '[\"cerebras:does-not-exist-xyz\",\"cerebras:qwen-3-235b\"]' }); console.log('SET'); })"

# Restore default chain
node -e "import('./service/src/db.js').then(m => { m.run(\"DELETE FROM settings WHERE key='ai_fallback_chain_voice'\"); console.log('CLEARED'); })"
```

## Save-point system (where this doc gets surfaced)

| Aspect | Detail |
|---|---|
| System | **Session Summary pipeline** + `session_summaries` table |
| Files | `service/src/session-summary.js` + `service/src/routes/hooks.js` |
| Triggers | SessionEnd hook; watermark on Stop (default 30 min / 10 turns) |
| Injection | `CLAUDE.md` between `<!-- PAN-CONTEXT-START -->` markers (6500 char cap) |
| Tasks visible in recap | Yes — Open Tasks block reads from `project_tasks` rows |
| Manual save | None today (filed as follow-up) |

The matrix above lives in this file AND is referenced from tasks #993/#994/#995/#996, so it survives across sessions through both surfaces.

# Voice Router Epic #986 — Test Matrix

> **Why this file exists:** This is the "save-point" for the user to come back tomorrow and
> verify every shipped batch of the voice-router epic still works end-to-end. The
> save-point system is the **Session Summary pipeline** (`session_summaries` table +
> `service/src/session-summary.js` + SessionEnd hook). Task descriptions of #993/#994/
> #995/#996 reference this file so it appears in tomorrow's ΠΑΝ Remembers.

## Terminology

| Term | Means |
|---|---|
| **phone** | The literal Android app — STT mic, Google streaming STT, server pipe |
| **dashboard voice** | The browser dashboard's talk-to-PAN UI (the green call button). Streams from `/api/v1/chat/stream`. **NOT** the phone. |
| **phone endpoint** | `/api/v1/query` and `/api/v1/query/stream` — what the Android app calls |
| **dashboard endpoint** | `/api/v1/chat` and `/api/v1/chat/stream` — what the browser uses |

## What shipped (server-side, both endpoints)

| Batch | Feature | Status | Commits |
|---|---|---|---|
| 1 | Situation / memory / mind blocks on prompt | shipped earlier | — |
| 2 | Streaming + cancellation on `/chat/stream` | shipped | a425981 |
| 3 | `conv:idle` trigger (10–30min silent) → PAN nudges | shipped earlier | — |
| 4 | TTS prosody surfacing (importance + rate/pitch/segments) | shipped | a425981, 827ccb5 |
| #996 | AI backend fallback chain (cerebras→claude→ollama) | shipped today | (this commit) |

## Test matrix (run tomorrow to verify)

### 1. Dashboard voice — happy path
```bash
curl -s -X POST http://127.0.0.1:7777/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"say hi in three words","source":"dashboard"}' | jq
```
**Expect:**
- `response` ≈ "Hi there, owner." (non-empty)
- `intent` = "query"
- `prosody` = `{rate, pitch, segments[], importance, source}` (non-null)
- `debug.fallback_attempts` = `null` (first attempt succeeded → no metadata surfaced)

### 2. Dashboard voice — streaming
Open dashboard, click the green call button, say "what time is it".
**Expect:** chunks render incrementally in the bubble; final `done` event includes prosody.

### 3. Phone endpoint — happy path
```bash
curl -s -X POST http://127.0.0.1:7777/api/v1/query \
  -H "Content-Type: application/json" \
  -d '{"text":"what time is it","source":"phone","device_id":"pixel-10-pro"}' | jq
```
**Expect:**
- Both `prosody` and `importance` are present (#986 Batch 4 fix in 827ccb5).

### 4. Cancellation
Start a stream, then `POST /api/v1/cancel {"stream_id": "<id>"}` mid-flight.
**Expect:** stream emits `cancelled` event, no more chunks, no `done`.

### 5. Conv:idle trigger
Stay silent for 10+ minutes in a chat session. Watch intuition logs.
**Expect:** PAN says "You went quiet — want to pick up where we paused?" (subject: `Quiet — picking up?`).

### 6. TTS prosody mapping (importance → rate/pitch)
| Importance | Expected rate | Expected pitch |
|---|---|---|
| < 0.3 (casual) | 0.92 | 0.95 |
| 0.3–0.7 (normal) | 1.00 | 1.00 |
| ≥ 0.7 (critical) | 1.00 | 1.00 (heuristics may bump) |

Additional segments:
- Trailing `?` → final segment at pitch 1.05 (final-rise)
- `!` → rate +0.05, pitch +0.05
- ALL-CAPS spans of 2+ chars → rate 1.05, pitch 1.05
- >25 words → mild speed-up (+0.03 rate)

### 7. Fallback chain (#996) — happy path
```bash
curl -s -X POST http://127.0.0.1:7777/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"hi","source":"dashboard"}' | jq '.debug | {fallback_attempts, served_by}'
```
**Expect:** `fallback_attempts: null` (no fallback when primary works).

### 8. Fallback chain (#996) — forced failure
```bash
# Force a fallback by breaking the first link of the chain
node -e "import('./service/src/db.js').then(m => m.run(\"INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_fallback_chain_voice', :v)\", { ':v': '[\\\"cerebras:does-not-exist-xyz\\\",\\\"cerebras:qwen-3-235b\\\"]' }))"

curl -s -X POST http://127.0.0.1:7777/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"hi","source":"dashboard"}' | jq '.debug | {fallback_attempts, served_by}'

# Restore default
node -e "import('./service/src/db.js').then(m => m.run(\"DELETE FROM settings WHERE key='ai_fallback_chain_voice'\"))"
```
**Expect:**
- `served_by: "cerebras:qwen-3-235b"`
- `fallback_attempts` = `[{model: "cerebras:does-not-exist-xyz", ok: false, reason: "model-unknown"}, {model: "cerebras:qwen-3-235b", ok: true}]`

### 9. Fallback chain (#996) — telemetry persistence
```bash
sqlite3 "$LOCALAPPDATA/PAN/data/pan.db" "SELECT data FROM events WHERE event_type='ai_fallback_attempt' ORDER BY id DESC LIMIT 5;"
```
**Expect:** per-attempt rows with `{caller, model, attempt_n, reason, ok, ms}`.

### 10. Fallback chain (#996) — opt-out
```bash
# Disable fallback explicitly
node -e "import('./service/src/db.js').then(m => m.run(\"INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_fallback_enabled', 'false')\"))"
# Verify single-backend semantics (no retries)
# Then re-enable
node -e "import('./service/src/db.js').then(m => m.run(\"DELETE FROM settings WHERE key='ai_fallback_enabled'\"))"
```

## Known open issues

| Bug | Title | What it blocks |
|---|---|---|
| #483 | ΠΑΝ Remembers summary too thin — barely any info | Resumption between days |
| #993 | Batch 2 phone wiring (streaming on phone path) | Phone gets chunks |
| #994 | Batch 4 phone wiring (TTS prosody on phone path) | Phone gets prosody |
| #995 | routeStream chunk extractor finalizes too early (P1) | Some streams fall to "I didn't catch that" |
| #996 | This (fallback chain) — done as of this commit | — |

## Files of interest

| File | Purpose |
|---|---|
| `service/src/tts-prosody.js` | Pure prosody planner — `planFromResult(result)` |
| `service/src/router.js` | Voice router — `route()`, `routeStream()`, `handleUnified()` |
| `service/src/llm-fallback.js` | #996 — `askAIWithFallback`, `askAIStreamWithFallback`, `classifyError` |
| `service/src/llm.js` | Backend dispatch — `askAI`, `askAIStream`, `getBackend` |
| `service/src/routes/api.js` | `/api/v1/chat`, `/api/v1/chat/stream`, `/api/v1/query`, `/api/v1/cancel` |
| `service/src/session-summary.js` | Save-point pipeline — builds + reads `session_summaries` rows |
| `service/src/routes/hooks.js` | SessionEnd hook + watermark trigger (30min/10turn) |

# Domain Knowledge

## PAN Architecture
- Three layers: Phone App (Android), Server (Node.js port 7777), Pendant (ESP32-S3)
- Server uses `claude -p` CLI with subscription auth ($0 cost)
- Database: SQLite via better-sqlite3, stored in %LOCALAPPDATA%/PAN/data/
- Projects discovered by .pan files on Desktop directories
- Remote access via Tailscale encrypted tunnel

## Voice Pipeline
- Phone: Google Streaming STT → classify (on-device or server) → route
- Local commands: time, battery, flashlight, timer, alarm, nav, search, media
- Server commands: file ops, project terminals, complex questions
- TTS: Android TextToSpeech with echo prevention

## Key Technical Decisions
- better-sqlite3 over sql.js (direct disk writes, no data loss)
- Ollama for local embeddings (nomic-embed-text, 768 dims)
- Cerebras for fast voice responses (free tier: 1M tokens/day, ~73ms)
- Claude Agent SDK for subscription-based AI calls ($0)

- **Verification rule**: No feature moves from 'Open Tasks' to 'What Works' until end-to-end tested AND confirmed working by user. Mark suspect items with [NEEDS_VERIFY] tag.

- Local classification: use OS-provided models (Gemini Nano, Galaxy AI) when available; fallback to regex
- **Voice hotkey:** currently broken; must be diagnosed and fixed before voice-first thesis works
- **Dream cycle:** uses user's subscription (not Cerebras), runs scheduled jobs via watchdog, must auto-report failures

- **ENFORCEMENT**: When suggesting a task from project_status.md, first search the current conversation to verify it still applies. If user already confirmed it's done, mark it [VERIFIED_SOLVED] and remove from next suggestion.
- Stale tasks (no mention in last 12 hours) must be re-confirmed before showing to user.

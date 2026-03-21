# ΠΑΝ Platform Issues & Feature Requests

Problems PAN encountered during development that require platform-level changes.
PAN periodically checks these — when resolved, PAN auto-adapts.

## Android

### 1. Single AudioRecord Limitation
**Problem:** Android only allows one `AudioRecord` instance at a time. PAN needs STT (Google SpeechRecognizer) AND raw audio recording simultaneously. Can't have both.
**Impact:** Phone can't collect voice training data while STT is active. Pendant is the workaround.
**What would fix it:** Android allowing concurrent `AudioRecord` with different audio sources (VOICE_RECOGNITION + MIC/CAMCORDER on different physical mics). Pixel has 3 mics — let apps use them independently.
**Filed:** Not yet
**Status:** Unresolved
**Workaround:** Pendant mic over BLE (separate device), or PC mic for training data

### 2. SpeechRecognizer Steals Audio Focus
**Problem:** Google's `SpeechRecognizer` takes exclusive audio focus, pausing music/media every time it starts listening. PAN needs always-on listening without interrupting music.
**Impact:** Can't use PAN while listening to music/podcasts. Defeats always-on assistant purpose.
**What would fix it:** A `SpeechRecognizer` mode that coexists with media playback. Or an API flag like `AUDIO_FOCUS_NONE` for background STT.
**Filed:** Not yet
**Status:** Unresolved
**Workaround:** Pendant mic (separate BLE audio stream), or headphones

### 3. Gemini Nano ML Kit API Not Working
**Problem:** `Generation.getClient()` hangs indefinitely on Pixel 10 Pro. AI Edge SDK also fails silently. On-device AI was supposed to give instant classification.
**Impact:** All AI decisions go through server instead of being instant on-device. Adds latency.
**What would fix it:** Stable ML Kit GenAI Prompt API that actually works on Pixel devices.
**Filed:** Not yet
**Status:** Beta API, possibly not fully rolled out
**Workaround:** Server-side Claude via API (fast enough with Haiku)

### 4. No Background Browser Tab Access
**Problem:** Can't read browser tab content from an Android app without an accessibility service or a browser extension. No API for "what's in my Chrome tabs?"
**Impact:** PAN can't check messages, read emails, or search browser content from the phone natively.
**What would fix it:** Android intent or API for querying browser tab content (with user permission).
**Filed:** Not yet
**Status:** Unresolved
**Workaround:** Browser extension on desktop, accessibility service on phone (not built yet)

## Windows

### 5. Windows UI Automation Tree Walking Is Extremely Slow
**Problem:** `uiautomation.WalkControl()` takes 10-30+ seconds on complex apps (Chrome, VS Code). Makes real-time UI element discovery impractical.
**Impact:** Can't quickly list interactive elements in a window for voice-controlled clicking.
**What would fix it:** Faster UI Automation API, or a cached/indexed UI tree that updates incrementally.
**Filed:** Not yet
**Status:** Known Windows limitation
**Workaround:** Browser extension for web apps, pyautogui screenshot + Claude Vision for native apps

### 6. Windows Voice Typing (Win+H) Has No API/Event
**Problem:** No way to programmatically detect when Windows Voice Typing activates/deactivates. PAN needs to know "user is speaking via dictation" to trigger voice recording.
**Impact:** Can't automatically record user's voice for training when they use dictation.
**What would fix it:** Windows event/callback when voice typing starts/stops. Or a registry key that updates in real-time.
**Filed:** Not yet
**Status:** Unresolved
**Workaround:** Hotkey-based trigger (same mouse button that activates Win+H via AutoHotkey)

### 7. Windows Service (LOCAL SYSTEM) Can't Access User Desktop
**Problem:** PAN service runs as LOCAL SYSTEM which has no GUI access. Can't take screenshots, control windows, or interact with the user's desktop session.
**Impact:** All UI automation must be routed through a separate user-session process (Electron tray).
**What would fix it:** A Windows service mode that runs in the user's session, or a standard API for cross-session UI access.
**Filed:** Not yet
**Status:** By design (security boundary)
**Workaround:** Electron tray app polls server for commands, executes in user session

## Anthropic / Claude

### 8. OAuth Token Doesn't Work With Anthropic API
**Problem:** Claude Code's OAuth token (`sk-ant-oat01-*`) is rejected by the Anthropic Messages API. Error: "OAuth authentication is currently not supported."
**Impact:** PAN can't use the existing Claude subscription for API calls. Required buying separate API credits ($10).
**What would fix it:** Allow OAuth tokens for API access, or provide a way to generate API keys from a Claude subscription.
**Filed:** Not yet
**Status:** Unresolved
**Why it matters:** Users already pay $100/month for Claude Max. Making them also buy API credits for their own automation tools is friction that kills adoption.

### 9. `claude -p` Subprocess Overhead
**Problem:** Spawning `claude -p` for each PAN query takes 3-5 seconds of process startup overhead before any AI processing begins.
**Impact:** Voice responses were 8+ seconds until we switched to direct API. Users without API keys are stuck with slow responses.
**What would fix it:** `claude serve` mode — persistent local HTTP API server. Or a Node.js SDK that connects to the existing Claude Code auth without spawning a process.
**Filed:** Not yet
**Status:** Unresolved
**Why it matters:** Every automation tool built on Claude Code hits this. A local API server mode would make Claude Code a real development platform, not just a CLI tool.

### 10. No Streaming for `claude -p`
**Problem:** `claude -p` buffers the entire response before outputting. Can't start TTS on the first sentence while Claude generates the rest.
**Impact:** User waits for the entire response to generate before hearing anything.
**What would fix it:** `claude -p --stream` that outputs tokens as they arrive.
**Filed:** Not yet
**Status:** Unresolved

### 11. Permission Prompts for Every Tool Call
**Problem:** Claude Code asks for user permission on every Bash/Read/Write call. When automating UI (screenshot → analyze → click → verify), this means 4+ permission prompts for one action.
**Impact:** Automation is impossible without the user sitting there clicking "allow" repeatedly.
**What would fix it:** Trusted tool profiles — register PAN as a trusted automation suite, auto-allow its specific tool patterns. Or `--allow-tools "Bash(python:*)" "Read(*)"` persistent flags.
**Filed:** Not yet
**Status:** Partially addressed with --allowedTools flag, but resets per session

## Chrome / Browsers

### 12. Strict CSP Blocks Extension Script Injection
**Problem:** Instagram, Facebook, and other React apps have CSP that blocks `eval()` even from browser extensions running in MAIN world. Can't execute dynamic JavaScript.
**Impact:** Can't reliably edit messages, interact with hover menus, or manipulate React state on these sites.
**What would fix it:** Browser extensions should be exempt from page CSP when running in MAIN world (they already have full page access via other APIs).
**Filed:** Not yet (Chromium bug tracker)
**Status:** By design (security boundary)
**Workaround:** Use `document.execCommand` and proper DOM API calls instead of eval

## Data Privacy

### 13. Voice Training Data Contains Everything
**Problem:** Mic records all audio in the room — user's voice, TV, music, other people. Training a voice model on this produces garbage.
**Impact:** Need deliberate recording triggers or speaker diarization to isolate user's voice.
**What would fix it:** On-device speaker diarization that runs in real-time. Or Android providing a "user speech only" audio source that filters out media playback.
**Status:** Solved with hotkey trigger (mouse button). Speaker diarization (resemblyzer) planned for automatic separation.

---

## Auto-Check Strategy

PAN should periodically:
1. Check Anthropic changelog / GitHub releases for OAuth API support
2. Check Android developer blog for AudioRecord changes
3. Check Chrome extension API updates for CSP exemptions
4. Query ML Kit version for Gemini Nano stability fixes
5. Test each workaround to see if the underlying issue was fixed
6. Auto-adapt when a platform fix makes a workaround unnecessary




- **Post-fix verification**: After code changes for any Known Issue, MUST explicitly state "User confirmed working" with timestamp before moving to closed/archived status. Trust user confirmation > internal testing.


### BridgeVoice / Voice Stack Research (2026-04-08)
- Tauri 2.0 (Rust) + whisper.cpp (OpenAI C++ port) = local speech-to-text, offline-capable
- Text injection via OS-level clipboard/accessibility APIs: hotkey listener → transcribe → Ctrl+V inject
- Two modes: local whisper.cpp (Tiny→Large-v3, 75MB→3.1GB, English only) or cloud Groq Whisper (99+ languages, <1s latency)
- Implementation: 30 lines of Tauri code (global-shortcut plugin + system paste)
- PAN can leverage existing Tauri shell (no new dependency) + offline whisper.cpp (via service/bin/dictate-vad.py equivalent)

# PAN's current voice conversation loop: evidence map of the pipeline and its defects (as of 2026-11-02)

Evidence basis. Code was read from the PAN repo at HEAD `35a621fd` (2026-11-02); `git status` shows no uncommitted changes under `service/src` or the Android sources. The hub runs its own copy of PAN, and the notes record repeated drift between the hub copy and the repo, so hub behaviour can differ from what is cited here. Link conventions: `service/...` and `android/...` are repo paths (Android paths are shortened from `android/app/src/main/java/dev/pan/app/`). `notes/...` are the owner's private project notes. `F:/pan-finetune/...` is the private fine-tune workspace. `pan-memory:N` is a PAN event id found with `pan_search`. `git:` is a commit hash. No live logs were available: PAN's API at 127.0.0.1:7777 did not answer from this machine, and adb and ssh were out of scope. All timings below therefore come from code comments, notes and PAN memory, not from fresh measurements.

## 1. Step by step: what happens from the start of speech to the end of PAN's audio, and where the time goes

### Takeaway
The loop is strictly sequential and half-duplex. (1) The phone listens continuously and decides end of turn. (2) It then uploads the turn's text plus its full audio. (3) The hub re-transcribes the audio in one batch with Parakeet. (4) It always builds the full context, tools included, (5) then runs OmniΠ on the hub CPU. (6) The router streams the `"response"` field back over SSE. (7) The phone waits for a complete sentence, synthesizes the whole sentence, and plays it. From end of speech to first audio is an estimated ~2.5–4 s. About 2 s of that is OmniΠ: re-reading its prompt (~1.3 s) and writing ~25 label tokens before the reply text (~0.7 s).

### Cited Findings
**Stage 0, phone, continuous capture.** One `AudioRecord` at 16 kHz on `VOICE_COMMUNICATION` with `AcousticEchoCanceler` attached and no NoiseSuppressor. Silero VAD runs on every 512-sample (32 ms) window. The recognizer is fed only while the VAD gate is open: speech plus a 1.5 s hangover, plus a 600 ms pre-roll when the gate opens — [SherpaStreamingStt.kt:494-519, 601-701](android/stt/SherpaStreamingStt.kt#L494), constants at [:137-167](android/stt/SherpaStreamingStt.kt#L137).

**Stage 1, phone, streaming ASR.** sherpa-onnx streaming zipformer transducer. The checkpoint is the 70M `sherpa-onnx-streaming-zipformer-en-2023-06-26` (chunk-16-left-128, int8 encoder), run with 2 threads and greedy search — [SherpaStreamingStt.kt:120-134, 396-421](android/stt/SherpaStreamingStt.kt#L120).
- The notes still describe the 20M model ([notes/reference_pan_streaming_stt.md](notes/reference_pan_streaming_stt.md)), so the notes are stale here.
- Partial transcripts are emitted with `isFinal=false` ([SherpaStreamingStt.kt:804-808](android/stt/SherpaStreamingStt.kt#L804)), but the service only acts on finals: `if (text.isNotBlank() && isFinal) onSpeech(text)` — [PanForegroundService.kt:448-449, 503-507](android/service/PanForegroundService.kt#L448).

**Stage 2, phone, end of turn.** The candidate fires after 0.35 s of trailing silence, then Smart Turn v3.2 plus the dangling-word veto decide whether to commit (details in section 2) — [SherpaStreamingStt.kt:704-803](android/stt/SherpaStreamingStt.kt#L704).
- On commit the recognizer is reset, and the whole turn's PCM (up to 20 s) is snapshotted.
- The text goes through `stripEcho`. The audio is kept only if no echo words were stripped — [SherpaStreamingStt.kt:779-802](android/stt/SherpaStreamingStt.kt#L779).

**Stage 3, phone, `onSpeech`.** Checks run in this order (details in sections 3, 5, 6 and 9):
1. dedup (3 s)
2. post-TTS cooldown (300 ms)
3. "PAN is speaking" guard
4. substring mute/unmute
5. persist the user turn
6. phone-local branches
7. `addToHistory("User", text)`
8. cancel any in-flight query
9. launch `askPanStream`

Source: [PanForegroundService.kt:985-1242](android/service/PanForegroundService.kt#L985).

**Stage 4, phone to hub.** `POST /api/v1/query/stream` carries `text`, `context` (the phone's history string), `sensors`, `can_camera`, and `audio` (base64 16 kHz PCM16 LE) — [PanServerClient.kt:300-331](android/network/PanServerClient.kt#L300).
- OkHttp connect timeout is 10 s and read timeout 30 s — [NetworkModule.kt:51-52](android/di/NetworkModule.kt#L51).
- The hub sends `ping`, then an SSE keepalive every 5 s — [api.js:1482-1486](service/src/routes/api.js#L1482).

**Stage 5, hub ASR, awaited before anything else.** `transcribePcm16(audio)` runs NVIDIA Parakeet TDT 0.6B v2 int8 through sherpa-onnx-node: `OfflineRecognizer`, 4 CPU threads, one batch decode of the whole clip, clips limited to 0.3–30 s. The result replaces the text and goes back to the phone as a `heard` event — [api.js:1488-1499](service/src/routes/api.js#L1488); [hub-asr.js:28-82](service/src/hub-asr.js#L28). Measured speeds, from three sources:
- ~370 ms — [notes/project_omnipi.md](notes/project_omnipi.md)
- "about 0.5 s per sentence on the hub CPU" — [FEATURES.md:1198](docs/FEATURES.md#L1198)
- 0.77 s including sending the audio, in a synthetic-voice test — [pan-memory:1030014](pan-memory:1030014)

**Stage 6, hub.** Supersede: abort the same device's previous turn — [api.js:1501-1521](service/src/routes/api.js#L1501). If the phone sent no history, rebuild it — [api.js:1543-1562](service/src/routes/api.js#L1543).

**Stage 7, hub, `routeStream` setup.**
- Fast paths: quick system, thread relay, ambient regex — [router.js:2005-2039](service/src/router.js#L2005).
- Recall pre-gate when `RECALL_RE` matches — [router.js:2048-2148](service/src/router.js#L2048).
- Then all context blocks are built ([router.js:2155-2172](service/src/router.js#L2155)), `buildToolBlocks` is awaited ([router.js:2197-2198](service/src/router.js#L2197), deadline 1.5 s per tool at [tools.js:435](service/src/tools.js#L435)), the self block is computed ([router.js:2204-2221](service/src/router.js#L2204)), and the full ~2,600-token prompt string is assembled ([router.js:2230-2371](service/src/router.js#L2230)).
- All of this happens even when OmniΠ will answer. Measured "setup ~200ms" — [notes/project_omnipi.md](notes/project_omnipi.md).

**Stage 8, hub, OmniΠ.** `voiceStream()` streams `studentPrompt` through `askAIStreamWithFallback` with the chain `[voice_student_model]` — [router.js:2402-2441](service/src/router.js#L2402). The Ollama call is `/api/chat`, `stream:true`, `think:false`, `keep_alive:-1`, `num_predict` = 300; no `num_ctx` is set — [llm.js:286-313](service/src/llm.js#L286); [router.js:2404](service/src/router.js#L2404).
- Measured: OmniΠ "re-reads its whole ~370-token prompt every turn (~1.3s): Ollama can't reuse KV cache for LFM3's hybrid architecture. Plus ~25 label tokens before 'response' at ~35 tok/s" — [notes/project_omnipi.md](notes/project_omnipi.md).
- On the hub CPU, lfm3-omni:2b runs at ~280 tok/s prefill and 33 tok/s decode — [notes/reference_pan_model_routing.md (2026-10-31)](notes/reference_pan_model_routing.md).

**OmniΠ output order.** The trained target JSON order is `to, addressed, intent, camera, response, turn, speech_act, importance` — [run_teacher_dialogues.py:35-43](F:/pan-finetune/scripts/run_teacher_dialogues.py#L35). Sample target from `data/pairs7.jsonl`: `{"to": "pan", "addressed": 0.95, "intent": "query", "camera": true, "response": "[CAMERA]", ...}`.

**Stage 9, hub, stream gating.**
- `readAddressGate` decides open/hold/mute once `intent` and `addressed` are present ([router.js:1918-1938](service/src/router.js#L1918)).
- `extractResponseField` yields deltas of the `response` string ([router.js:1940-1968](service/src/router.js#L1940)) and nothing is spoken before the gate opens.
- The stream breaks at the closing brace — [router.js:2443-2495](service/src/router.js#L2443).
- On the OmniΠ path the first characters are held until `[CAMERA]` can be ruled out — [router.js:2414-2428](service/src/router.js#L2414).

**Stage 10, phone, sentence buffering.** Chunks accumulate. When the buffer contains `.`, `!` or `?`, everything up to the last one is spoken via `panSpeak` — [PanForegroundService.kt:1484-1506](android/service/PanForegroundService.kt#L1484). `panSpeak` registers the text for echo stripping and calls `tts.speak` — [PanForegroundService.kt:943-963](android/service/PanForegroundService.kt#L943). Non-Latin-script replies go to Android TTS; everything else goes to the sherpa-onnx `PiperTtsEngine` — [TtsManager.kt:131-186](android/tts/TtsManager.kt#L131).

**Stage 11, phone, synthesis and playback.** Inside a fair `Mutex`, `tts.generate()` synthesizes the whole sentence. It is then played on an `AudioTrack` with `USAGE_VOICE_COMMUNICATION`, routed to the loudspeaker if the earpiece was selected, and the code waits on `playbackHeadPosition` plus a 120 ms grace — [PiperTtsEngine.kt:319-478](android/tts/PiperTtsEngine.kt#L319).
- The configured Supertonic voice is sid 9 at speed 1.35 and 44.1 kHz — [PiperTtsEngine.kt:102-108](android/tts/PiperTtsEngine.kt#L102). The code comment there says "1.18" while the value is 1.35.
- Supertonic warm synthesis measured 0.67 s for 2.93 s of audio on the laptop CPU; synthesis speed on the phone was "NEVER measured" — [notes/reference_pan_tts_engine.md](notes/reference_pan_tts_engine.md).

**Stage 12, phone, end of stream.** The trailing text is spoken. The reply is added to history as `"$responseText (${elapsed}ms)"` and persisted — [PanForegroundService.kt:1544-1587](android/service/PanForegroundService.kt#L1544).

**Timing log lines.**
- Hub: `[routeStream] timing setup=…ms student_prompt=…` and `timing first_chunk=…ms` ([router.js:2410, 2419](service/src/router.js#L2410)), and `[hub-asr] …ms phone=… hub=…` ([api.js:1495](service/src/routes/api.js#L1495)).
- Phone: `Stream (first=…ms total=…ms)` ([PanForegroundService.kt:1561-1562](android/service/PanForegroundService.kt#L1561)); `first` is measured from query launch to the first SSE chunk, so it excludes endpointing and TTS synthesis.
- The hub console is not persisted to a file — [notes/reference_pan_model_routing.md](notes/reference_pan_model_routing.md); [notes/reference_pan_hub_root_causes_sep6.md](notes/reference_pan_hub_root_causes_sep6.md).

**Historic end-to-end numbers (GPU era, different config).**
- September 2026, with gemma4:e2b on the GPU desktop: 1565–1983 ms from question to speech on the phone, then 339–862 ms hub-side for short turns after the tool and prompt cuts — [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md).
- Today everything local runs on the hub CPU. OmniΠ is installed on the GPU desktop but is not switched on there — [notes/project_omnipi.md](notes/project_omnipi.md); [notes/reference_game_mode_gpu_handoff.md](notes/reference_game_mode_gpu_handoff.md).

**Conflicting OmniΠ latency claims.** The OmniΠ docs claim "about 30 tokens instead of about 2,600. First word in about 0.3 s on the mini PC CPU" — [FEATURES.md:723-726](docs/FEATURES.md#L723). The later, more specific note gives ~1.3 s prefill plus ~0.7 s of labels — [notes/project_omnipi.md](notes/project_omnipi.md). These conflict.

### Inferences
- Estimated budget from end of speech to first audio, built from the parts above (no single trace exists):

| Segment | Estimate | Basis |
|---|---|---|
| silence to commit | ~0.4 s typical (0.35 s + Smart Turn); 1.1 s in flow mode; up to 1.4 s if judged unfinished | code constants |
| upload of whole-turn PCM | 32 KB per second of speech, ~43 KB/s after base64, so ~130–220 KB for a 3–5 s turn; time unmeasured | computed |
| Parakeet | ~0.37–0.5 s | notes, FEATURES |
| router setup | ~0.2 s, or up to ~1.5 s when a tool regex fires (the data is then discarded on the OmniΠ path, see section 5) | notes, code |
| OmniΠ prefill | ~1.3 s | notes |
| OmniΠ labels before `response` | ~0.7 s | notes |
| first sentence tokens | ~0.1–0.4 s (3–12 tokens at ~33 tok/s) | computed |
| whole-sentence TTS + AudioTrack start | ~0.1–0.5 s (phone unmeasured) | laptop numbers |
| **total** | **~3–4 s; the model is ~2 s of it** | |

- This is somewhat above the owner's "~2–3 s". Either prefill is cheaper than the note says (some prefix reuse), or Parakeet and setup are faster in practice. Either way, the largest single block is OmniΠ prefill plus labels.
- Five stages that could overlap are strictly serial today:
  - ASR starts only after the turn is committed.
  - Context building and tools wait for ASR.
  - The model waits for context.
  - The reply text waits behind the labels.
  - TTS waits for a full sentence, and sentence N+1 is synthesized only after sentence N finishes playing, because `generate()` runs inside the play lock ([PiperTtsEngine.kt:326-347](android/tts/PiperTtsEngine.kt#L326)).

### Gaps
- No fresh per-stage numbers on the current build (0.4.44/0.4.45). The hub console is not persisted, phone logs live in the hub's `/api/v1/logs`, and the local API was unreachable from this machine.
- Upload time of the turn audio over the tailnet proxy is unmeasured.
- Phone-side Supertonic synthesis time is unmeasured.
- Smart Turn inference time on the phone is unmeasured (see section 2).
- Live settings were not read: `voice_student_model`, `ai_fallback_chain_voice`, `ollama_url`. Phone prefs were not read: STT engine, `voice_quality`. Code defaults are `pan_stt_prefs/engine` = `"google"` ([PanForegroundService.kt:123-128](android/service/PanForegroundService.kt#L123)) and `voice_quality` = `"android"` ([TtsManager.kt:41-43](android/tts/TtsManager.kt#L41)). The notes say the phone is set to sherpa and Supertonic.

## 2. End of turn: how the phone decides the user finished, and what happens on mid-sentence pauses

### Takeaway
A silence of 0.35 s after decoded speech is only a candidate. The phone commits when Pipecat Smart Turn v3.2 (fp32, last 8 s of audio) gives P ≥ 0.5 **and** the last word is not on a small "dangling" list. Otherwise it waits up to 1.4 s. If a turn was committed in the last 2.5 s ("flow mode"), even a complete clause needs 1.1 s of silence. A pause judged complete commits immediately. The continuation then becomes a separate turn that cancels the first one's query, and it is ignored if PAN has already started speaking.

### Cited Findings
**Recognizer endpoint rules.** `rule1` = 2.4 s of silence with no speech; `rule2` = 0.35 s of trailing silence after speech (`ENDPOINT_SILENCE_S`); `rule3` = 20 s maximum utterance — [SherpaStreamingStt.kt:79-99, 412-416](android/stt/SherpaStreamingStt.kt#L79).

**Smart Turn.**
- Runs once per pause, asynchronously, on the last 8 s of the current turn — [SherpaStreamingStt.kt:588-599, 726-737](android/stt/SherpaStreamingStt.kt#L588). Threshold 0.5; model `smart-turn-v3.2-gpu.onnx` (fp32, 32,411,198 bytes) — [SmartTurn.kt:45-49](android/stt/SmartTurn.kt#L45).
- If no verdict arrives within 0.35 s + `TURN_JUDGE_TIMEOUT_MS` (800 ms), the decision falls back to the word rule alone — [SherpaStreamingStt.kt:110, 738-751](android/stt/SherpaStreamingStt.kt#L738).
- fp32 was chosen because the int8 build's score for "I want you to" moved between 0.25 and 0.63 across onnxruntime versions — [FEATURES.md:1167-1169](docs/FEATURES.md#L1167).

**Commit rule.** `complete = text.isBlank() || (isTurnComplete(text) && modelDone)`. The required silence (`needed`) is `INCOMPLETE_MAX_WAIT_MS` (1400 ms) if not complete, `FLOW_SILENCE_MS` (1100 ms) if another commit happened within `FLOW_WINDOW_MS` (2500 ms), and otherwise 0 — [SherpaStreamingStt.kt:752-780](android/stt/SherpaStreamingStt.kt#L752); constants at [:83-94](android/stt/SherpaStreamingStt.kt#L83).

**DANGLING veto.** The list covers articles, prepositions, conjunctions, auxiliaries and fillers. Pronouns and "like" are deliberately excluded ("how old are you" was held 1428 ms and he repeated himself). A two-word fragment ending in a dangling word is also held when the utterance is under 4 words — [SherpaStreamingStt.kt:173-187, 243-254](android/stt/SherpaStreamingStt.kt#L173); [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md).

**Mid-sentence pause handling.** While holding, the stream is NOT reset, so the rest of the sentence appends ("Do NOT reset - keep the stream open") — [SherpaStreamingStt.kt:770-778](android/stt/SherpaStreamingStt.kt#L770).

**Why flow mode exists.** One spoken explanation produced "11 commits, 9 spoken answers" ("Right." / "Understood." / "Got it."), and "a clause boundary is not a turn boundary" — [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md); [SherpaStreamingStt.kt:85-94](android/stt/SherpaStreamingStt.kt#L85).

**After a commit.** A new commit cancels the phone's in-flight query ([PanForegroundService.kt:1233-1240](android/service/PanForegroundService.kt#L1233)), and the hub aborts that device's previous stream ([api.js:1513-1521](service/src/routes/api.js#L1513)). The earlier fragment survives only as a `User:` line in the phone history (section 5).

**Verification status.** Smart Turn was "Not yet verified on the phone" when it shipped in v43/0.4.40 on 2026-09-28 — [notes/reference_pan_streaming_stt.md](notes/reference_pan_streaming_stt.md). FEATURES shows log examples (`smart-turn p=0.93 in 45ms`, `commit after 410ms p=0.93`); it is unclear whether these are measured or illustrative — [FEATURES.md:1177-1178](docs/FEATURES.md#L1177).

**Google engine.** If the STT engine pref were `google`, end of turn would be decided by Android `SpeechRecognizer` (silence hints of 300 ms since v0.4.32, previously 4000 ms; the hints are honoured inconsistently), and Smart Turn would not run — [notes/reference_pan_tts_engine.md](notes/reference_pan_tts_engine.md); [FEATURES.md:1186-1187](docs/FEATURES.md#L1186).

### Inferences
- First utterance of a conversation: if Smart Turn says "done" at a mid-thought breath (≥0.35 s) and the last word is not dangling (e.g. "...I was thinking about the pendant [pause] and whether..."), PAN commits after ~0.4 s and starts thinking about the fragment.
  - If he resumes within roughly the model latency (~2–3 s), the new fragment supersedes the old query.
  - If he resumes after PAN starts speaking, the continuation is not transcribed (section 3). This is a direct mechanism for "cuts me off" and "breaks in odd ways".
- Flow mode keys on the time since the last commit, not on whether PAN replied. After any committed turn, the next one needs 1.1 s of silence, even for a crisp question, which adds latency in back-and-forth exchanges.
- The endpoint uses the zipformer's decode of the audio (`rec.isEndpoint`). The 70M model's chunk-16 configuration likely adds decoding granularity on top of the 0.35 s silence. This is not measured.

### Gaps
- No on-device statistics: false-cutoff rate, Smart Turn p-distribution, verdict latency, or how often the 800 ms timeout or 1.4 s cap fire. These are logged to the hub (`[STT] smart-turn p=…`, `commit after …`) but were not accessible.
- No measurement of how often a turn commits in flow mode versus fresh.

## 3. Barge-in and echo: can the user interrupt, how TTS stops, and how PAN's own voice is kept out

### Takeaway
Interruption is possible, but only through a VAD-plus-energy detector, and only late. During TTS the recognizer is not fed at all. For the first 1.2 s of every playback the detector only measures PAN's own echo. After that, the user must produce ≥700 ms of continuous speech louder than 2.2× that echo. Then `tts.stop()` pauses and flushes the AudioTrack immediately. The barge-in does not cancel the in-flight hub query, so later chunks or the stream tail can restart PAN's speech. Echo is handled by five layers, listed in the findings below.

### Cited Findings
**Barge-in detector.** While `isTtsSpeaking` and not yet barged:
- the recognizer is skipped
- the first `CALIBRATION_MS` = 1200 ms record the residual echo peak RMS
- after that, frames below `max(residualPeak × 2.2, 500/32768)` reset the speech run
- a VAD speech run ≥ `BARGE_IN_SPEECH_MS` = 700 ms triggers `onInterrupt` and feeds the 600 ms pre-roll into the recognizer

Source: [SherpaStreamingStt.kt:642-682](android/stt/SherpaStreamingStt.kt#L642); constants at [:146-167](android/stt/SherpaStreamingStt.kt#L146).

**`onInterrupt` handler.** It calls `tts.stop()` and clears `lastTtsDoneTime`; it does not cancel `inFlightQuery` — [PanForegroundService.kt:400-424](android/service/PanForegroundService.kt#L400). Its comment says this path "only fires on a FINAL transcript that still had real words in it after echo stripping". In the sherpa engine it actually fires from the VAD+energy branch before any transcription ([SherpaStreamingStt.kt:674-680](android/stt/SherpaStreamingStt.kt#L674)), so the comment is stale.

**`tts.stop()`.** It cancels every queued utterance (`cancelChildren()`), zeroes `pending`, and pauses, flushes and releases the AudioTrack. "CUT, do not drain": `stop()` alone used to play out the rest of the sentence over the user — [PiperTtsEngine.kt:457-498](android/tts/PiperTtsEngine.kt#L457). A 2026-09-14 analysis said barge-in waited for the sentence to drain ([pan-memory:586822](pan-memory:586822)); the current code cuts.

**Finals while PAN is speaking.** Any final that arrives while `tts.isSpeaking` is dropped as "probably echo", unless it contains stop/enough/shut up/quiet — [PanForegroundService.kt:1008-1017](android/service/PanForegroundService.kt#L1008). The notes flag as unverified "whether `tts.isSpeaking` has gone false by the time onSpeech runs", since `isSpeaking` includes `playLock.isLocked` — [notes/reference_pan_streaming_stt.md](notes/reference_pan_streaming_stt.md); [PiperTtsEngine.kt:155](android/tts/PiperTtsEngine.kt#L155).

**Echo layers.**
1. On TTS start the audio mode is set to `MODE_IN_COMMUNICATION` with speakerphone on, so the hardware AEC gets the speaker reference — [PanForegroundService.kt:426-453](android/service/PanForegroundService.kt#L426). Playback uses `USAGE_VOICE_COMMUNICATION` / `CONTENT_TYPE_SPEECH` — [PiperTtsEngine.kt:417-423](android/tts/PiperTtsEngine.kt#L417). Capture uses `VOICE_COMMUNICATION` with the AEC attached — [SherpaStreamingStt.kt:479-514](android/stt/SherpaStreamingStt.kt#L479).
2. No transcription during TTS (layer 1 of the barge-in detector above).
3. `stripEcho`: remove PAN's recent words when more than 80% of a TTS line's words (length > 2) appear in the transcript, within a 3000 ms window — [SherpaStreamingStt.kt:118, 278-315](android/stt/SherpaStreamingStt.kt#L278).
4. 300 ms post-TTS cooldown — [PanForegroundService.kt:159-172, 1002-1006](android/service/PanForegroundService.kt#L1002).
5. 3 s dedup of identical text — [PanForegroundService.kt:150-153, 988-995](android/service/PanForegroundService.kt#L988).

Turns with stripped echo keep the phone's words and are not sent to Parakeet — [SherpaStreamingStt.kt:792-798](android/stt/SherpaStreamingStt.kt#L792); [FEATURES.md:1205](docs/FEATURES.md#L1205).

**`stripEcho` short-utterance side effect.** Independent of any echo match, it returns "" when fewer than 2 words of length > 1 remain (`if (remaining.size < 2) "" else result`) — [SherpaStreamingStt.kt:313-314](android/stt/SherpaStreamingStt.kt#L313). The caller logs this as `echo discarded` — [:789-790](android/stt/SherpaStreamingStt.kt#L789).

**Source-choice history.** Switching the capture source to `VOICE_RECOGNITION` for accuracy removed the AEC's speaker reference. PAN "cut itself off on every reply after the first", so it was reverted ("Do not change this again without a way to test echo on a real device") — [SherpaStreamingStt.kt:479-493](android/stt/SherpaStreamingStt.kt#L479). The notes still describe the switch as "NOT yet verified" — [notes/reference_pan_streaming_stt.md](notes/reference_pan_streaming_stt.md), stale.

**Echo and cut-off bug history.**
- Mar 2026, Google STT era: echo self-response loop; STT stopped during TTS; TTS cut off when STT restarting stole audio focus — [notes/project_pan_bugs.md](notes/project_pan_bugs.md); [notes/project_pan_voice_progress.md](notes/project_pan_voice_progress.md).
- 2026-07-15: Google-engine echo window 1000→8000 ms (finals landed 2–30 s late); recognizer reuse fixed first-word cutoff and ERROR 11 storms — [notes/project_pan_voice_progress.md](notes/project_pan_voice_progress.md).
- 2026-09-11/12 (v0.4.31–0.4.32): last word clipped (computed-duration sleep, fixed by polling the playback head); two voices at once (fixed with a Mutex); `stop()` cancelling only the latest sentence — [notes/reference_pan_tts_engine.md](notes/reference_pan_tts_engine.md).
- 2026-09-15 sherpa engine: room noise decoded into sentences (fixed with VAD gating); VAD-only barge-in at 400 ms self-interrupted (raised to 700 ms and calibration added); mute did not silence (gate moved into `panSpeak`); cancellations spoken as server errors — [pan-memory:589022](pan-memory:589022); [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md).
- 2026-09-16: native use-after-free crash in VAD (silent "no reply"); per-sentence volume lurch — [notes/reference_pan_streaming_stt.md](notes/reference_pan_streaming_stt.md).
- 2026-11-02: app 0.4.43 never sent audio because `stripEcho` lowercases while the zipformer emits CAPS; fixed in 0.4.44 — [notes/project_omnipi.md](notes/project_omnipi.md); [SherpaStreamingStt.kt:795-798](android/stt/SherpaStreamingStt.kt#L795).

### Inferences
- The user cannot interrupt in the first ~1.2 s of any playback. The earliest possible cut is ~1.9 s after PAN starts talking, and it takes 0.7 s of sustained, loud speech. A short "no, wait" will usually not register.
- The pre-roll (600 ms) is shorter than the required speech run (700 ms), so the first ~100 ms or more of the interruption is lost before the recognizer sees it.
- After a barge-in, `inFlightQuery` keeps running. Any SSE chunk that arrives later is still posted to `panSpeak`, and the stream tail is spoken at the end ([PanForegroundService.kt:1484-1559](android/service/PanForegroundService.kt#L1484)), so PAN can resume talking. Once TTS is back on, the user's interrupting sentence can be dropped by the "PAN is speaking" guard. This matters most on the slow full-prompt fallback; short OmniΠ replies usually finish streaming before a barge-in is even possible.
- History records the full intended reply even after a cut (`addToHistory("PAN", responseText…)`), not the part the user actually heard.
- `stripEcho` drops all one-word turns ("yes", "no", "why", "thanks", "stop" when PAN is silent) and turns like "I agree", where "I" has length 1. That kills backchannel-style replies outright.
- `registerTtsOutput` timestamps a line when it is queued (now + 80 ms per word), not when it plays. Sentences waiting behind the play lock can therefore have part of their 3 s echo window used up before they sound. This is minor, because the recognizer is not fed during TTS.

### Gaps
- No measured barge-in reaction time, false-barge-in rate, or echo-induced false turns on the current build.
- AEC quality on Bluetooth headsets and earbuds, and on the future pendant, is unknown. The pendant BLE path is images only today (`PendantBle.kt` carries JPEG frames; there is no audio) — [PendantBle.kt:38-44](android/ble/PendantBle.kt#L38).

## 4. What is streamed and what is batch

### Takeaway
Streamed today: microphone capture and on-phone recognition (continuous), LLM tokens (Ollama NDJSON to router to SSE deltas), and TTS at sentence granularity. Batch today: everything between the user's last word and the model's first token. Nothing leaves the phone until commit; partials are discarded; Parakeet decodes the whole clip offline; context and tools are awaited. Also batch: OmniΠ's label prefix, synthesis of each full sentence, and synthesis of the next sentence only after the previous one has played. TTS starts on the first complete sentence, not the full reply. Exceptions are held replies, recall answers and done-only fallbacks, which arrive whole.

### Cited Findings
- Partials exist but are dropped by the service (`isFinal` only) — [SherpaStreamingStt.kt:804-808](android/stt/SherpaStreamingStt.kt#L804); [PanForegroundService.kt:448-449](android/service/PanForegroundService.kt#L448).
- The turn audio is sent once, base64 in the JSON body, after commit — [PanServerClient.kt:317-321](android/network/PanServerClient.kt#L317). Parakeet uses `OfflineRecognizer` with `decodeAsync` on the whole buffer — [hub-asr.js:37-51, 64-82](service/src/hub-asr.js#L37).
- LLM streaming: `callOllamaStream` uses `/api/chat` with `stream:true` — [llm.js:286-313](service/src/llm.js#L286). The router yields `chunk` deltas only after the gate opens — [router.js:2456-2475](service/src/router.js#L2456).
- Before September 2026, `askAIStream` only streamed for Cerebras, so every other model returned one chunk at the end (`Stream (first=43463ms total=43470ms)`). This was fixed 2026-09-15 with `callGeminiStream` / `callOllamaStream` — [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md).
- The phone speaks up to the last sentence punctuation as soon as it arrives — [PanForegroundService.kt:1493-1505](android/service/PanForegroundService.kt#L1493).
- Each `speak()` call synthesizes its whole text before playing, inside `playLock.withLock`, so sentence synthesis and playback are serialized — [PiperTtsEngine.kt:319-347](android/tts/PiperTtsEngine.kt#L319).
- The notes say "`speak()` currently generates the ENTIRE response before playing a single sample" (2026-09-11). That predates the sentence-level phone split; today it applies per sentence — [notes/reference_pan_tts_engine.md](notes/reference_pan_tts_engine.md).
- Held replies: the hub sends no chunks and puts `hold_ms` = 1200 on the `done` event, and the phone speaks the full text after 1.2 s if nothing else is said — [router.js:1874-1876, 2626-2643](service/src/router.js#L2626); [PanForegroundService.kt:1526-1542](android/service/PanForegroundService.kt#L1526).
- Recall synthesis is a non-streaming `claude(...)` call (15 s timeout) emitted as one chunk — [router.js:2601-2614](service/src/router.js#L2601). The deterministic recall refusal is emitted as one chunk — [router.js:2132-2140](service/src/router.js#L2132).
- The spoken "thinking" filler was removed 2026-09-15. It fired at 1500 ms, could not be cancelled once handed to AudioTrack, and delayed real answers, so a 1.9 s answer was heard at ~3.8 s — [PanForegroundService.kt:1453-1462](android/service/PanForegroundService.kt#L1453); [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md).

### Inferences
- The sentence splitter uses the last `.`/`!`/`?` in the buffer, so decimals ("3.5 degrees") or abbreviations ("e.g.") can split mid-phrase and produce an audible pause or odd prosody ([PanForegroundService.kt:1496](android/service/PanForegroundService.kt#L1496)).
- Because the next sentence is synthesized only after the previous one finishes, multi-sentence replies have a dead gap between sentences equal to synthesis time (Supertonic: ~0.2 s per second of audio on the laptop; phone unknown).
- No stage uses the time while the user is still speaking. There is no speculative ASR, prompt prefill, or reply drafting on partials.

### Gaps
- No measurement of the gap between sentences or of first-sentence synthesis time on the phone.

## 5. Conversation context: what goes into OmniΠ's prompt, where state lives, and why PAN forgets

### Takeaway
OmniΠ's entire prompt is five pieces (source in the findings):
1. the phone's history string: at most 10 lines, each cut to 200 chars, with PAN lines suffixed with latency and the current utterance already included
2. memory hits, only when a recall regex matches
3. one self line, only when asked about models or privacy
4. a `Now:` line
5. `Mic heard: "<Parakeet text>"`

It gets no persona text, no tool data (weather, Wikipedia, news, rates), no sensors, no intuition, and no long-term memory. Conversation state lives in phone RAM. "Forgetting" has several concrete code causes:
- a tiny window, with train/serve format skew
- the phone's garbled zipformer words in history instead of Parakeet's
- "what did I/we say" questions routed to long-term search instead of the live history
- a deterministic "I don't have anything saved" refusal that never shows the model the history
- overheard lines polluting the history
- a 2B model at its reasoning ceiling

### Cited Findings
**Student prompt.** `studentPrompt = [historyBlock, memoryContext, selfAsked ? buildSelfLine() : '', nowLine(), 'Mic heard: "<text>"']` — [router.js:2402-2403](service/src/router.js#L2402). `historyBlock` is `\nRecent conversation:\n${context.conversation_history}\n` — [router.js:2166-2167](service/src/router.js#L2166). `nowLine()` uses the hub's local time and zone — [router.js:93-99](service/src/router.js#L93).

**Tool data never reaches OmniΠ.** `weatherBlock` (all tool blocks) is computed by an awaited `buildToolBlocks` ([router.js:2197-2198](service/src/router.js#L2197)) but referenced only in the full prompt template ([router.js:2328](service/src/router.js#L2328)), not in `studentPrompt`. The sensor and situation blocks are likewise full-prompt only — [router.js:2155-2186](service/src/router.js#L2155).

**Phone history.**
- `conversationHistory` holds `MAX_HISTORY = 10` entries. `getHistoryContext()` joins them as `"$role: ${text.take(200)}"` with roles "User" and "PAN" — [PanForegroundService.kt:175-189](android/service/PanForegroundService.kt#L175).
- The user line is added before the query is launched and before `getHistoryContext()` is read, so the current utterance is in the history and again in `Mic heard` — [PanForegroundService.kt:1231, 1244](android/service/PanForegroundService.kt#L1231).
- PAN lines are stored as `"$responseText (${elapsed}ms)"` — [PanForegroundService.kt:1579-1582](android/service/PanForegroundService.kt#L1579).

**Hub-corrected words are not used for history.** The `heard` event from the hub (Parakeet's text) is only logged (`panLog("Hub heard: …")`, `lastAction.value = heard`); history keeps the phone's text — [PanForegroundService.kt:1480-1483](android/service/PanForegroundService.kt#L1480). The hub comment claims "'heard' tells the phone the corrected words for its own history" — [api.js:1488-1490](service/src/routes/api.js#L1488). The phone does not act on it that way. The zipformer heard "what model is it using" as "what motto", "mot", "modo" — [hub-asr.js:1-8](service/src/hub-asr.js#L1).

**Training format.**
- The student prompt in training uses `User:` / `PAN:` lines ([pan_prompt.py:42-50, 61-72](F:/pan-finetune/scripts/pan_prompt.py#L42)) and `HISTORY = 6` lines of scene ([run_teacher_dialogues.py:23](F:/pan-finetune/scripts/run_teacher_dialogues.py#L23)).
- In training the current line is appended to history only after its prompt is built, so training history never contains the current utterance — [run_teacher_dialogues.py:78-80](F:/pan-finetune/scripts/run_teacher_dialogues.py#L78).
- Eval uses `hist[-6:]` — [eval.py:21-32](F:/pan-finetune/scripts/eval.py#L21).

**Persistence and reload.** Each turn is shipped best-effort to `POST /api/v1/history`, which inserts an `events` row of type `conversation_turn` — [PanForegroundService.kt:242-251](android/service/PanForegroundService.kt#L242); [api.js:1640-1656](service/src/routes/api.js#L1640). On service start, 10 turns are reloaded with `GET /history` — [PanForegroundService.kt:253-266](android/service/PanForegroundService.kt#L253).

**Hub fallback history.** Used only when the phone sends fewer than 10 chars of history: the last 16 `chat_messages` from `thread-pan-system` within 30 min, labelled `You:` / `PAN:`, 400 chars each — [api.js:1543-1562](service/src/routes/api.js#L1543). That table is not the one the phone writes to.

**Design decision vs code.** The decision recorded in July 2026 was "conversation state lives on the SERVER, not per-device", with a 3-layer plan — [notes/project_pan_conversation_memory.md](notes/project_pan_conversation_memory.md). In the code, the phone's in-RAM list is the primary thread, and the server only rebuilds history when the phone sends none.

**Full-prompt dialog block.** `buildDialogHistoryBlock` on the voice path selects only `DashboardChat`, `MobileSend`, `VoiceCommand` and `RouterCommand` events (8 turns, 100 chars), not `conversation_turn` — [router.js:194-227](service/src/router.js#L194). `routeStream` does not insert `RouterCommand` events except on the thread-relay path ([router.js:2023](service/src/router.js#L2023)); the evals note "routeStream does NOT call insertRouterEvent" — [notes/project_pan_behavioural_evals.md](notes/project_pan_behavioural_evals.md).

**Recall routing.**
- On the phone, a fixed phrase list ("what did i say", "what were we talking", "do you remember", "our conversation"…) forces `recall`. That calls `POST /api/v1/recall/stream` with only `{text}`, and the hub runs `searchMemory` (FTS + vector, limit 20) over the whole DB without the live conversation — [PanForegroundService.kt:1263-1283, 1387-1415](android/service/PanForegroundService.kt#L1263); [PanServerClient.kt:252-262](android/network/PanServerClient.kt#L252); [api.js:869-908](service/src/routes/api.js#L869).
- On the hub, `RECALL_RE` (remember/recall/forgot/what did/was/were/… /tell me about/look up) runs an FTS-only search capped at 2.5 s. If nothing readable is found and the text contains a date or a pronoun from `OWN_HISTORY_RE` (we/i/my/our/us), the hub answers in code ("I don't have anything saved about that.") and never calls the model — [router.js:30, 42, 2048-2140](service/src/router.js#L2048).
- `_recallIsRelevant` returns true when no distinctive word exists (for example "what did I just say", where every word is short or a stop word), so random FTS hits are passed in as "Relevant memories" — [router.js:80-86, 2097-2113](service/src/router.js#L80).

**Long-term recall quality.** A known-item benchmark found three retrieval bugs: FTS prefix floods, assistant replies invisible to FTS, and differential-privacy noise applied to his own searches. Fixing them broke the confabulation guard, so none is shipped — [notes/reference_pan_recall_benchmark.md](notes/reference_pan_recall_benchmark.md).

**Model ceiling.** The round-8 conclusion was "2B is at its reasoning ceiling; hard turns need a bigger model" — [notes/project_omnipi.md](notes/project_omnipi.md).

**Contradicted claim.** A 2026-11-02 assistant summary said "OmniΠ gets about 30 tokens of history, so it forgets what you said two turns ago" ([pan-memory:1031225](pan-memory:1031225)), echoing "about 30 tokens" in [FEATURES.md:724-725](docs/FEATURES.md#L724). The code passes the whole phone history block (up to 10 lines × 200 chars), and the latency note sizes the student prompt at ~370 tokens ([notes/project_omnipi.md](notes/project_omnipi.md)). The "30 tokens" figure only fits a turn with no history.

**Standing instructions.** Kept in an in-process `Map` keyed by device, with a 2 h TTL, and cleared by phrases. Turns under a standing instruction bypass OmniΠ for a short gemma prompt, because "OmniΠ does not follow standing instructions even when handed one" — [router.js:406-423, 2391-2399](service/src/router.js#L406).

### Inferences
- The effective conversational memory is at most ~4.5 prior exchanges: 10 lines, one of them the current utterance, each cut to 200 chars. Nothing summarizes older turns, and nothing persists across an app restart beyond the 10 reloaded turns.
- Train/serve skew on the history block: production has a duplicated current line, `(NNNNms)` suffixes, up to 10 lines rather than the trained 6, and `You:` labels on the fallback path. It may make a small model weigh the history differently than in training. This was not measured.
- Garbled user turns: the phone's LibriSpeech zipformer text fills the history, so later turns re-read the mishearings that Parakeet corrected only for the turn in which they occurred.
- Overheard speech pollutes the history: `addToHistory("User", text)` runs before the hub decides the line was ambient, and the ambient return does not remove it ([PanForegroundService.kt:1231, 1512-1516](android/service/PanForegroundService.kt#L1512)). Held replies that are later spoken are never added to history ([PanForegroundService.kt:1529-1542](android/service/PanForegroundService.kt#L1529)).
- "What were we just talking about?" is answered from long-term search, not from the history block. On the hub path it can produce a confident "I don't have anything saved about that" while the answer sits in the history the model never sees.
- Standing instructions live only in hub process memory, so they would be lost on a hub restart or Craft swap.
- OmniΠ cannot use live data. Weather, news and Wikipedia turns are answered without the fetched block, so it will either refuse or invent. The tool fetch still costs up to 1.5 s.

### Gaps
- How often each forgetting mechanism fires in real use is unmeasured.
- No multi-turn memory eval runs through the real phone path. The `converse.js` corpus has only 6 cases with a `thread` (section 8).
- Whether the hub's deployed copy differs on these lines was not checked.

## 6. Routing: when a turn goes to OmniΠ, gemma4:e2b, the full prompt or the cloud, and how the "addressed" gate handles background speech

### Takeaway
Routing happens in three layers. First, keyword branches on the phone: mute/unmute, stop words, calendar/email/"check my" to the phone calendar or a Claude terminal, location to a non-streaming query, instant hardware, and recall phrases to `/recall/stream`. Second, deterministic paths on the hub: quick system, Claude-thread relay, ambient regex, recall refusal. Third, the model, chosen as follows:
- a standing instruction goes to a short prompt on the default voice chain (gemma4:e2b)
- if `voice_student_model` is set, OmniΠ handles everything else
- the full ~2,600–3,000-token prompt runs on the default chain only when OmniΠ errors or asks for the camera when a photo is not allowed (no camera, or the line fails `looksVisual`)
- Gemini cloud is reached only as a chain fallback

The `addressed` gate (≥0.50 speak, ≥0.15 hold 1.2 s, else mute) is coarse. Measured on gemma, PAN still answers about half of overheard speech, and one ambient pre-filter rule silently mutes many first-person statements.

### Cited Findings
**Phone-local branches, in order.**
1. mute ("mute"/"shut up"/"be quiet" as substrings) and unmute ("unmute"/"wake up"/"start listening" as substrings)
2. "didn't work" goes to the resistance system
3. `isGoogleQuery` (substrings "calendar", "schedule", "meeting", "appointment", "email", "gmail", "outlook", "inbox", "check my", "read my", "what's on my"): the phone CalendarProvider, or the Claude terminal via MCP with "Let me check." and up to 45 s of polling
4. location phrases go to the non-streaming `askPanWithContext`
5. `handleInstantHardware`
6. recall keywords go to `/recall/stream`
7. everything else goes to `/query/stream`

Source: [PanForegroundService.kt:1019-1229, 1263-1415](android/service/PanForegroundService.kt#L1019).

**Hub deterministic paths.**
- `serverClassify`/`tryQuickSystem` handle file/folder creation and "status" — [router.js:356-369, 2006-2014](service/src/router.js#L356).
- The thread relay handles talking to a Claude desktop thread — [router.js:2016-2030](service/src/router.js#L2016); [notes/project_pan_thread_relay.md](notes/project_pan_thread_relay.md).
- `quickAmbientCheck` mutes without any model when it matches — [router.js:427-453, 2032-2039](service/src/router.js#L427).
- The recall refusal is covered in section 5.

**Model selection.**
- A standing instruction goes to `standingPrompt` through `askAIStreamWithFallback` with no explicit chain. The comment reads: "gemma4:e2b does, but only in a SHORT prompt: inside the ~3,000-token voice prompt it answered in English, after 37s on the hub CPU. 1.2s and correct like this" — [router.js:2391-2399, 2406](service/src/router.js#L2391).
- The OmniΠ setting is re-read from the DB on every turn (`voice_student_model`) — [router.js:2388-2390](service/src/router.js#L2388).
- OmniΠ runs with `chain: [studentModel]` only. The full prompt is used on error before any output, or on `[CAMERA]` without `canCamera && looksVisual(text)` — [router.js:2405-2441](service/src/router.js#L2405); [FEATURES.md:721-739](docs/FEATURES.md#L721). OmniΠ's camera false flags are ~3% — [notes/project_omnipi.md](notes/project_omnipi.md).

**Voice chain semantics.** `ai_fallback_chain_voice[0]` wins whenever `ai_fallback_enabled`; `ai_model` does not control voice. Connect-time failures cascade through the chain, and mid-stream failures surface as truncation — [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md); [router.js:2453-2455](service/src/router.js#L2453).

**Full prompt on the hub CPU.**
- Comment: "16-22s re-read when the prompt falls out of the KV cache" — [router.js:2380-2382](service/src/router.js#L2380).
- With `OLLAMA_NUM_PARALLEL=4`, plain voice turns took ~5.5 s and weather/memory turns ~24 s cold (2026-10-31) — [notes/reference_pan_model_routing.md](notes/reference_pan_model_routing.md).
- Game mode (models moved to the hub CPU) gave 18–60 s voice turns — [notes/reference_game_mode_gpu_handoff.md](notes/reference_game_mode_gpu_handoff.md).

**Cloud.** Cerebras returns 402 on every model since August 2026 — [notes/reference_pan_model_providers.md](notes/reference_pan_model_providers.md). Gemini flash-lite took 0.70–3 s on a 1,900-token prompt, with 46–56 s pathological spikes observed on 2026-09-15; the free tier has 500 requests/day — [notes/reference_pan_model_providers.md](notes/reference_pan_model_providers.md); [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md); [notes/reference_pan_local_inference.md](notes/reference_pan_local_inference.md).

**Gate thresholds and mechanics.** `ADDRESSED_SPEAK = 0.50`, `ADDRESSED_HOLD = 0.15`, `ADDRESSED_HOLD_MS = 1200` — [router.js:1874-1876](service/src/router.js#L1874).
- The gate is read from the stream before any reply word is emitted. If `response` starts before `addressed`, the boolean rule from `intent` is used — [router.js:1918-1938](service/src/router.js#L1918).
- `looksDirectedAtPan` (a question mark or an opening question/imperative word) vetoes a wrong "ambient" after parsing, and the phone then speaks the done-event reply — [router.js:383-393, 2537-2546](service/src/router.js#L383); [PanForegroundService.kt:1548-1558](android/service/PanForegroundService.kt#L1548).

**Gate accuracy (gemma4:e2b).** Separation was "~0.15 on held-out cases: gemma4:e2b mutes only 1-3 of 10 lines that were plainly aimed at somebody else". The model emits three buckets (no / don't know / yes). 0.50 keeps 44/45 genuinely-addressed turns. "PAN still answers roughly half of overheard speech" — [router.js:1843-1868](service/src/router.js#L1843); [notes/reference_pan_addressed_gate.md](notes/reference_pan_addressed_gate.md). A dedicated veto classifier was tested on gemma4:e2b, gemma4:e4b and qwen3:4b and not shipped: the binary forms are constants, and the probability form catches 3/20 — [notes/reference_pan_addressed_gate.md](notes/reference_pan_addressed_gate.md).

**OmniΠ round-7 scores.** for_pan 89.2% on real lines and 91.4% on unseen scenes, versus 90.5% / 70.7% for the full-prompt baseline — [notes/project_omnipi.md](notes/project_omnipi.md). Three facts change how to read these numbers:
- `eval.py` computes for_pan from the `to` field when present — [eval.py:41](F:/pan-finetune/scripts/eval.py#L41).
- The router never reads `to`; it gates on `addressed` — [router.js:1918-1938](service/src/router.js#L1918).
- In training, `to` comes from the scene's gold label while `addressed` comes from the teacher's output — [run_teacher_dialogues.py:39, 101-113](F:/pan-finetune/scripts/run_teacher_dialogues.py#L39).

**Background speech generally.** There is no wake word and no speaker verification on this path. The always-on mic transcribes the room, including video audio, and mute is the only control — [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md).

**`quickAmbientCheck` rule 4.** `/^[A-Z][a-z]+\s+I'(?:ll|m)\s+/i` was meant for "Sarah I'll meet you…", but the `i` flag makes `[A-Z]` match any word — [router.js:448-449](service/src/router.js#L448). Tested locally with node; each was flagged ambient: "So I'm thinking we should redo the pendant", "Honestly I'm exhausted", "Today I'll finish the case", "Well I'm not sure that works", and "SO I'M THINKING ABOUT IT". "Honestly, I'm exhausted" (with a comma) was not flagged.

### Inferences
- The production gate uses the field that imitates the weaker teacher (`addressed`), not the field trained on gold labels (`to`). The 89–91% for_pan figures may therefore overstate how well OmniΠ's live gating separates overheard speech. Teacher-labelled hold-band values (0.15–0.5) on lines not meant for PAN would still be spoken after a 1.2 s silence.
- Rule 4 silently swallows a common way of opening a statement about oneself, and the turn never reaches a model. Whether it fires depends on whether Parakeet inserts a comma after the first word. This matches "breaks in odd ways" and "ignores me".
- Routing is not difficulty-aware. Every non-standing turn goes to the 2B student, and the only escalation is on error or camera, which lands on a CPU path that takes seconds to tens of seconds.
- Phone substring routing hijacks ordinary conversation. "I have a meeting tomorrow and I'm nervous" goes to the calendar branch; "check my reasoning" goes to the Claude terminal with "Let me check." and up to 45 s of polling; "my commute was long" mutes PAN and releases the mic (`"commute".contains("mute")`, confirmed with node); "I had to wake up early" is treated as an unmute command and not answered.

### Gaps
- No direct measurement of OmniΠ's `addressed` distribution, and none of the hold or mute rates in production.
- Current values of `ai_fallback_chain_voice` and `voice_student_model` were not read.
- No production log counts for how often `quickAmbientCheck` or the phone substring branches fire.

## 7. What has been tried before and dropped, and why

### Takeaway
The full-duplex route was tried once: NVIDIA PersonaPlex, Moshi-based, in March 2026. It crashed the laptop through RAM exhaustion and was abandoned, and the model cache was deleted in August. Later evaluations of full-duplex options were desk research only: Dessa in October, Moshi and Sesame on 2026-11-02. Most other dropped pieces were replaced for measured reasons: speed (Kokoro, Nemotron, LiveKit's turn model, a local phone LLM), reliability (Google SpeechRecognizer, Gemini Nano, Cerebras), or because they broke echo (`VOICE_RECOGNITION`).

### Cited Findings
**Full-duplex and speech-to-speech models**
- **PersonaPlex (NVIDIA, 7B, Moshi-based).** In March 2026 the owner wanted it for "real-time chat" on the phone and pendant, alongside Piper and Claude — [pan-memory:123](pan-memory:123). Loading "20GB 7B moshi model with --cpu-offload" crashed the system by exhausting RAM (with Docker and browsers running) — [pan-memory:780](pan-memory:780). It remains in `.gitignore` ("PersonaPlex (cloned, large model + HF token)") — [.gitignore:69-70](.gitignore#L69). On 2026-08-20 the 32 GB clone and model cache were removed from the laptop; the only local edit was `moshi.server --cpu-offload` in a Dockerfile, and the owner said a copy is "on the minipc" — [pan-memory:615524](pan-memory:615524); [pan-memory:615533](pan-memory:615533).
- **Block's Dessa** (2026-10-24, desk research): research preview with a waitlist, needs an M4 Max Mac, no published benchmarks, trained speech-only so no text conditioning for memory or tools. Kyutai's Moshi was named as the best-known open full-duplex model — [pan-memory:943219](pan-memory:943219).
- **Sesame (CSM):** only discussed on 2026-11-02. CSM-1B is open; Maya's voice is not public — [pan-memory:1031225](pan-memory:1031225).
- **LFM3-Omni's own speech output** (`/v1/audio/speech`, 39 voices): ~0.65× real time on the hub CPU. English-to-Japanese speech translation took 2.2–5.4 s and was "only ~half reliable" — [notes/reference_pan_model_routing.md (2026-10-31)](notes/reference_pan_model_routing.md).

**Text to speech**
- **Kokoro** (v0.4.20, 2026-09-11): RTF ~1.1 on the laptop CPU, ~14× slower than Piper, "adds roughly 2 seconds of silence before every reply". Supertonic was chosen (v0.4.21, voice sid 9); Kokoro stays selectable. Pocket TTS was disqualified (non-commercial license, 472 MB, needs reference audio). Piper Amy was judged "robotic" — [notes/reference_pan_tts_engine.md](notes/reference_pan_tts_engine.md).

**Speech recognition and end of turn**
- **Nemotron 0.6B streaming ASR on the phone:** "about 7 times heavier than the current phone model, and the phone couldn't keep up in real time". Recognition moved to Parakeet on the hub instead — [pan-memory:1030014](pan-memory:1030014); [FEATURES.md:1201](docs/FEATURES.md#L1201).
- **20M zipformer:** replaced by the 70M model because of mishearings ("but do you think i should do to day") — [SherpaStreamingStt.kt:120-124](android/stt/SherpaStreamingStt.kt#L120).
- **Google SpeechRecognizer** (`GoogleStreamingStt`): turn-based restarts (first word lost), ERROR 11 storms, 3–4 s silence endpointing, finals 4–5 s late, which forced an 8 s echo window. Replaced by the continuous sherpa engine on 2026-09-15. It is still the code default pref — [notes/reference_pan_streaming_stt.md](notes/reference_pan_streaming_stt.md); [notes/project_pan_voice_progress.md](notes/project_pan_voice_progress.md); [PanForegroundService.kt:110-128](android/service/PanForegroundService.kt#L110).
- **Vosk:** a complete engine that was never wired in; its model asset is missing — [notes/reference_pan_streaming_stt.md](notes/reference_pan_streaming_stt.md).
- **LiveKit turn detector** (165 MB Qwen2.5-0.5B): deferred as too heavy. Smart Turn v3.2 fp32 shipped instead (2026-09-28) — [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md); [notes/reference_pan_streaming_stt.md](notes/reference_pan_streaming_stt.md).

**Language models and serving**
- **Phone-local LLMs:** Gemini Nano via ML Kit hung on `getClient()` (March 2026). The phone's llama.cpp classifier was skipped because it was "adding 9s overhead" — [notes/project_pan_bugs.md](notes/project_pan_bugs.md); [PanForegroundService.kt:1246-1248](android/service/PanForegroundService.kt#L1246).
- **Cerebras:** 402 since August 2026, and its once-only streaming path made all replies one chunk until 2026-09-15 — [notes/reference_pan_model_providers.md](notes/reference_pan_model_providers.md); [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md).
- **Larger models on the 8 GB GPU** (qwen3:8b, qwen3-vl:4b, qwen3.5:4b): no better than gemma4:e2b on the 41-case corpus, slower, and caused VRAM thrash. On the GPU, gemma4:e2b had a corpus median of ~575 ms — [notes/reference_pan_model_routing.md](notes/reference_pan_model_routing.md).
- **OmniΠ round 8** (gemma4:31b teacher): not deployed. Camera recall was worse (17% vs 67%), it dropped memory commands and invented facts; must-pass was 2/8 — [notes/project_omnipi.md](notes/project_omnipi.md).
- **Vulkan iGPU on the hub:** slower than CPU (gemma prefill 37 s vs 10 s) — [notes/reference_pan_model_routing.md](notes/reference_pan_model_routing.md).

**Capture and playback experiments**
- **`VOICE_RECOGNITION` capture source and NoiseSuppressor:** the source broke the AEC and was reverted; NoiseSuppressor was dropped for accuracy — [SherpaStreamingStt.kt:479-519](android/stt/SherpaStreamingStt.kt#L479).
- **Spoken thinking filler:** removed 2026-09-15 (see section 4) — [PanForegroundService.kt:1453-1462](android/service/PanForegroundService.kt#L1453).

**Continuous-listening history.** In March 2026 the Google STT stopped during TTS. In September the energy-threshold `BargeInMonitor` (Google engine only) gave way to the sherpa engine with VAD gating, pre-roll, flow mode and Smart Turn. VoiceCollector raw capture was disabled because Android allows only one AudioRecord — [notes/project_pan_voice_progress.md](notes/project_pan_voice_progress.md); [notes/project_pan_bugs.md](notes/project_pan_bugs.md); [PanForegroundService.kt:496-499](android/service/PanForegroundService.kt#L496).

### Inferences
- The only full-duplex trial failed on hardware (RAM and CPU offload), not on conversational quality. There is no record of PersonaPlex or Moshi ever being evaluated as a conversation partner in PAN.
- Every streaming and latency fix so far has been incremental inside the cascaded architecture (STT → LLM → TTS). The notes record the stated spec that it "has to feel like a phone call, local, no per-minute cost" — [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md).

### Gaps
- Whether a PersonaPlex copy still exists on the hub, and whether it was ever run there, is unknown (owner: "personaplex is on the minipc, idk what that does").
- No record of a Moshi trial separate from PersonaPlex was found in PAN memory (searches: "Moshi full duplex", "Sesame voice").

## 8. Test harnesses and metrics that already exist, and what they measure

### Takeaway
Several harnesses exist, but each one bypasses part of the real loop:
- the phone harness skips the mic, endpointing and Parakeet
- `converse.js` is text over HTTP
- the fine-tune eval is offline JSON scoring
- the logs are scattered, and the hub's are not persisted

Nothing measures mouth-to-ear latency, false cut-offs, barge-in reaction time, echo false triggers or multi-turn memory with real audio.

### Cited Findings
**Phone debug intents** (debug builds only; the service is exported only through the debug manifest):
- `TEST_SPEAK`: TTS only, works offline.
- `TEST_SAY`: the full loop as if the STT heard the text. It clears the dedup and cooldown state first.
- `STOP_TTS`: the same stop path barge-in uses.
- `STT_ENGINE`: switches between sherpa and google.

Sources: [PanForegroundService.kt:2276, 2295, 2301, 2320](android/service/PanForegroundService.kt#L2276); [notes/reference_pan_phone_test_harness.md](notes/reference_pan_phone_test_harness.md). Logcat tags are `PanService`, `SherpaSTT` and `PiperTTS` (not "PiperTts"); playback logs `Playback CUT/done … played N/M frames` — [notes/reference_pan_phone_test_harness.md](notes/reference_pan_phone_test_harness.md).

**Phone logs.** `LogShipper` batches logs every 5 s to the hub (`POST /api/v1/logs`, read with `?device_type=phone`) — [CLAUDE.md "Phone Voice Pipeline"](CLAUDE.md). They include `[STT] smart-turn p=… in …ms`, `commit after …ms`, `holding…`, `Stream (first=…ms total=…ms)`, `Hub heard:` and `Held …ms` — [FEATURES.md:1177-1178](docs/FEATURES.md#L1177); [PanForegroundService.kt:1481, 1533, 1562](android/service/PanForegroundService.kt#L1481).

**Hub logs.**
- Console lines: `[routeStream] prompt N chars`, `timing setup=` and `first_chunk=`, `raw head:`, `BRACE-IN-REPLY`, `[hub-asr] …`, `[/query/stream] superseded…` — [router.js:2376, 2410, 2419, 2500, 2505-2507](service/src/router.js#L2376); [api.js:1495, 1518](service/src/routes/api.js#L1495).
- LLM failures go to `voice-errors.log` before alert de-duplication — [notes/reference_pan_voice_pipeline_latency.md](notes/reference_pan_voice_pipeline_latency.md).
- The `ai_usage` table has `latency_ms` and `input_tokens` per `askAI` call, but local Ollama calls bypass it — [notes/reference_pan_model_routing.md](notes/reference_pan_model_routing.md); [notes/reference_pan_local_inference.md](notes/reference_pan_local_inference.md).

**`service/src/evals/converse.js` + `conversation.json`.**
- 65 cases (counted): 12 held out, 6 with a `thread`.
- Each case is posted to the live `/api/v1/query/stream` with `source: 'voice'`.
- Deterministic checks: bare acknowledgement, silence, markdown, self-identification as a model, context narration, `use_thread`. Options: `--loop N`, `--judge`.
- `routeStream` does not write events, so evals cannot pollute memory.

Source: [notes/project_pan_behavioural_evals.md](notes/project_pan_behavioural_evals.md); directory `service/src/evals/` (README, `converse.js`, `conversation.json`, `run-evals.js`, `rules.js`, `results/`). The evals note records the owner disowning this suite (2026-10-15: "not the user's work").

**`F:/pan-finetune/scripts/eval.py`.**
- Metrics: `json_ok`, `for_pan` (computed from `to` when present), `to`, `turn`, `camera_recall` / `camera_precision`, `intent_vs_production`, `expect` (regex content checks), `avg_ms` — [eval.py:35-63](F:/pan-finetune/scripts/eval.py#L35).
- Data sets: `dialogues_test`, `dialogues_heldout`, `mustpass`, `mustpass_r8` (eval files present in `F:/pan-finetune/runs/`).
- The Ollama-student mode uses a raw LFM3 template with `num_ctx` 4096 — [eval.py:82-89](F:/pan-finetune/scripts/eval.py#L82).
- Scores: round 7 had must-pass 88% — [notes/project_omnipi.md](notes/project_omnipi.md). Round 8 scored "2/8 same as r7", apparently on a different must-pass file — [notes/project_omnipi.md](notes/project_omnipi.md).

**Training data.** 22,985 exported rows contained only 376 distinct real voice sentences; the rest were benchmark runs — [F:/pan-finetune/README.md:12-13](F:/pan-finetune/README.md#L12).

**Other tests.**
- Recall benchmark on the hub (22 answerable questions, 4 negatives; answer in the top 5 went from 1 to 15 of 18 with the unshipped fixes) — [notes/reference_pan_recall_benchmark.md](notes/reference_pan_recall_benchmark.md).
- Smart Turn unit tests (`WhisperLogMelTest`, `SmartTurnModelTest`) — [FEATURES.md:1180-1184](docs/FEATURES.md#L1180).

### Inferences
- `TEST_SAY` text is injected straight into `onSpeech`, so `takeTurnAudio(text)` finds no audio. The harness therefore never exercises VAD, endpointing, Smart Turn, Parakeet, AEC or barge-in.
- `converse.js` exercises only `routeStream` text quality and gating. Neither harness gives the latency from end of speech to first audio, or interruption behaviour.
- On 2026-11-02 the assistant proposed a phone-harness conversation test scoring the end-of-speech-to-first-word gap, false cut-offs, interruption stop time and memory of earlier turns. It had not been built at the time of that message — [pan-memory:1031225](pan-memory:1031225).

### Gaps
- Not checked here: whether `converse.js` results or phone logs from the 0.4.43–0.4.45 builds exist on the hub.

## 9. Defect list: each owner complaint mapped to concrete root causes in the code

### Takeaway
Every complaint traces to identifiable code. Much of the "slow" and "dumb" feel comes from one design choice: a CPU-bound 2B student that is given labels first and no live data. The "odd breaks" are largely brittle keyword and regex shortcuts on the phone and the hub. "Forgetting" is mostly about which text gets stored in history and where recall questions are routed, not about context length.

### Cited Findings
**A. Turn-based ("walkie-talkie") feel**
1. Half-duplex by construction: no transcription while PAN speaks, and finals during TTS are dropped unless they contain stop words — [SherpaStreamingStt.kt:652-682](android/stt/SherpaStreamingStt.kt#L652); [PanForegroundService.kt:1008-1017](android/service/PanForegroundService.kt#L1008).
2. Every stage after the user's last word is serial: partials are ignored, ASR, tools and context are batch, and labels come before the reply (sections 1 and 4).
3. Pauses are added on purpose: flow mode needs 1.1 s, the hold band 1.2 s, the incomplete cap 1.4 s — [SherpaStreamingStt.kt:83-94](android/stt/SherpaStreamingStt.kt#L83); [router.js:1876](service/src/router.js#L1876).
4. Dead air between sentences, because synthesis of sentence N+1 starts only after N finishes playing — [PiperTtsEngine.kt:326-347](android/tts/PiperTtsEngine.kt#L326).
5. No backchannels or overlap, and nothing happens while he talks (no speculative work on partials). No code path for either exists (search of the phone service and router).

**B. Cuts him off, or breaks in odd ways**
1. A 0.35 s pause judged complete commits on the first utterance — [SherpaStreamingStt.kt:759-779](android/stt/SherpaStreamingStt.kt#L759).
2. A continuation that starts after PAN begins speaking is ignored (B1 plus A1).
3. Ambient rule 4 silently mutes "<Word> I'm/I'll …" statements — [router.js:448-449](service/src/router.js#L448), verified with node.
4. Substring triggers: "mute" inside "commute"/"permute" mutes PAN and releases the mic; "wake up" acts as unmute and the turn is unanswered — [PanForegroundService.kt:1019-1052](android/service/PanForegroundService.kt#L1019).
5. Keyword hijacks: "schedule", "meeting", "email", "check my", "read my" go to the calendar or the Claude terminal ("Let me check.", up to 45 s) — [PanForegroundService.kt:1101-1179](android/service/PanForegroundService.kt#L1101).
6. `stripEcho` drops every one-word turn and two-word turns with a 1-letter word — [SherpaStreamingStt.kt:313-314](android/stt/SherpaStreamingStt.kt#L313).
7. Repeating oneself within 3 s is dropped by dedup — [PanForegroundService.kt:988-995](android/service/PanForegroundService.kt#L988).
8. OmniΠ camera false flags or errors fall back to the full prompt on CPU, which takes ~5.5–37 s — [router.js:2391-2393, 2433-2440](service/src/router.js#L2391); [notes/reference_pan_model_routing.md](notes/reference_pan_model_routing.md).
9. Canned fallbacks: "I didn't catch that — could you try again?" and "Sorry, I ran into a problem thinking that through." — [router.js:2515-2521, 2647-2652](service/src/router.js#L2515).
10. Decimal and abbreviation sentence splits (section 4).

**C. Echo and self-interruption**
1. The barge-in threshold is calibrated only in the first 1.2 s of each playback. Louder echo later (a plosive, a volume change) can exceed 2.2× the residual for 0.7 s and cut PAN off; this happened with the `VOICE_RECOGNITION` source — [SherpaStreamingStt.kt:479-493, 663-680](android/stt/SherpaStreamingStt.kt#L663).
2. AEC depends on `MODE_IN_COMMUNICATION`, which is toggled on each TTS start and stop — [PanForegroundService.kt:426-453](android/service/PanForegroundService.kt#L426).
3. Echo text subtraction uses a 3 s window and 80% overlap, with queue-time timestamps — [SherpaStreamingStt.kt:278-315](android/stt/SherpaStreamingStt.kt#L278).
4. A post-TTS cooldown of only 300 ms (the code comment says "2 seconds") — [PanForegroundService.kt:1002-1006](android/service/PanForegroundService.kt#L1002).

**D. Forgets what was said earlier in the same conversation**
1. History is 10 lines (one of them the current turn) of at most 200 chars, kept in phone RAM — [PanForegroundService.kt:175-189](android/service/PanForegroundService.kt#L175).
2. User history holds the phone's zipformer text, not the hub's Parakeet text — [PanForegroundService.kt:1231, 1480-1483](android/service/PanForegroundService.kt#L1231).
3. Interrupted replies are stored in full; held replies are not stored; overheard lines are stored — [PanForegroundService.kt:1512-1582](android/service/PanForegroundService.kt#L1512).
4. "What did I say / what were we talking about" goes to long-term search (`/recall/stream` with text only, or the hub `RECALL_RE` pre-gate), never the live history. On the hub this can produce a code-generated "I don't have anything saved about that." — [PanForegroundService.kt:1263-1283, 1387-1415](android/service/PanForegroundService.kt#L1263); [router.js:2048-2140](service/src/router.js#L2048).
5. Train/serve skew in the history format (section 5) — [run_teacher_dialogues.py:23, 78-80](F:/pan-finetune/scripts/run_teacher_dialogues.py#L78).
6. Standing instructions live only in hub process memory — [router.js:409](service/src/router.js#L409).
7. The 2B model ceiling — [notes/project_omnipi.md](notes/project_omnipi.md).

**E. Too slow (~2–3 s to first audio)**
1. OmniΠ prefill of ~1.3 s per turn with no KV reuse — [notes/project_omnipi.md](notes/project_omnipi.md).
2. ~25 label tokens (~0.7 s) before `response`. The router needs only `intent` and `addressed` before the reply, but the student writes `to` and `camera` first as well — [run_teacher_dialogues.py:35-43](F:/pan-finetune/scripts/run_teacher_dialogues.py#L35); [router.js:1918-1938](service/src/router.js#L1918).
3. Serial batch Parakeet on the whole clip, ~0.37–0.77 s — [api.js:1491-1499](service/src/routes/api.js#L1491).
4. Context and tool setup is always awaited (~0.2 s, up to ~1.5 s when a tool regex fires), even though OmniΠ discards the result — [router.js:2155-2221](service/src/router.js#L2155).
5. Endpointing at ≥0.35 s, or 1.1–1.4 s in flow or incomplete cases (section 2).
6. Whole-sentence synthesis before playback (section 4).
7. Hub CPU only: the GPU desktop path (sub-second hub-side in September) is off by owner decision — [notes/project_omnipi.md](notes/project_omnipi.md).
8. Fallback turns at 5.5–37 s (B8).

**F. Small local model lacks intelligence**
1. A 2B LFM3-Omni student (Q4_K_M on CPU), distilled from a gemma4:e4b teacher. The student cannot exceed the teacher, and round 8 with a 31B teacher did not help — [F:/pan-finetune/README.md:5-9](F:/pan-finetune/README.md#L5); [notes/project_omnipi.md](notes/project_omnipi.md).
2. No tool or live data in its prompt: weather, Wikipedia, news, rates, crypto and air quality are computed and then thrown away — [router.js:2197-2198, 2328, 2402-2403](service/src/router.js#L2402).
3. No persona or standing rules in its prompt; it relies on what the fine-tune absorbed, and it ignores standing instructions — [router.js:2391-2393](service/src/router.js#L2391).
4. Thin training data: 376 distinct real voice sentences; the rest of the scenes were written by a local model — [F:/pan-finetune/README.md:12-17](F:/pan-finetune/README.md#L12).
5. No escalation to a stronger model for hard turns. The only escalations are standing instructions, the camera case and errors — [router.js:2405-2441](service/src/router.js#L2405).
6. Weak long-term recall (three unshipped retrieval fixes) — [notes/reference_pan_recall_benchmark.md](notes/reference_pan_recall_benchmark.md).

### Inferences
- The highest-leverage single fixes these root causes point to: put `response` first or drop the extra labels, give the student the tool and live data, store hub-corrected and actually-heard text in history, remove or tighten the phone substring and regex shortcuts, and move the model off the hub CPU.
- Most of these are independent of choosing a new speech architecture.

### Gaps
- None of these causes has a measured production frequency. A harness running real audio through the phone (section 8) would be needed to rank them by impact.
- The hub's deployed code was not inspected and may differ from the repo.

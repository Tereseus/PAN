# Real-time streaming voice stack on CPU-only and small-GPU hardware (state as of 2 Nov 2026)

Scope: latency budgets, streaming ASR, LLM time-to-first-token (TTFT), streaming TTS, audio transport, component placement, and recommended stacks for PAN (Android phone, later an ESP32-S3 pendant, plus a CPU-only Ryzen 7 5800H hub, an optional RTX 3050 or 8 GB GPU, and an optional cloud fallback). Numbers are labelled as **measured** (independent or third-party runs), **vendor** (claims by the model's maker), or **PAN-internal** (taken from the assignment brief or PAN's own earlier measurements, with no URL). Facts from before 2025 are labelled as older.

---

## Q1. Latency budget: what production systems hit and recommend, how it splits by stage, and what is achievable CPU-only

### Takeaway
Production cascaded pipelines (STT → LLM → TTS) aim for about 800 ms voice-to-voice and in practice deliver a median of about 1.0 to 1.3 s. The two largest slices are always endpointing/turn detection and LLM TTFT. Real-world production medians are worse: 1.4 to 1.7 s at P50 and 3.3 to 3.8 s at P90. PAN's 2 to 3 s is mostly self-inflicted: a re-read prompt plus about 25 JSON label tokens before the reply. A tuned CPU-only stack can realistically reach roughly 0.8 to 1.1 s from end of speech to first audio.

### Cited Findings
- **Pipecat/Daily reference budget (updated June 2026):** mic input 40 ms (macOS), Opus encode 21, network 10, packet handling 2, jitter buffer 40, Opus decode 1, transcription and endpointing 300, LLM TTFB 650, sentence aggregation 20, TTS TTFB 120. The return path adds Opus encode 21, packet handling 2, network 10, jitter buffer 40, Opus decode 1 and speaker output 15. The rows sum to 1,293 ms; the text says "about 1,200 ms". — [Voice AI & Voice Agents primer](https://voiceaiandvoiceagents.com/)
- The same primer gives 500 ms as a typical human response time. It reports Pipecat agents reaching "voice-to-voice latency as low as 500 ms" when all models run in one GPU cluster, and warns against letting latency "creep up above 1,500 ms" as features such as tool calls are added. — [primer](https://voiceaiandvoiceagents.com/)
- Its rule of thumb is that "LLM time-to-first-token of 600 ms or less is fast enough for most voice AI use cases." It gives measured cloud TTFT (median / P95, ms): GPT-4.1 536/1771, Gemini 2.5 Flash 597/1137, Claude 4.5 Haiku 637/1615, GPT-5.1 739/1492, Nemotron 3 Ultra self-hosted 541/712. — [primer](https://voiceaiandvoiceagents.com/)
- Turn detection per the primer: legacy VAD-only defaults are stop 0.8 s and start 0.2 s, which it says you "shouldn't be using" anymore. It recommends a short 200 ms VAD trigger plus the Smart Turn audio model (about 30 ms on a cloud vCPU, giving turn decisions about 250 ms after a pause) plus LLM single-token tagging. — [primer](https://voiceaiandvoiceagents.com/)
- Smart Turn v3 inference takes 12 ms on modern CPUs and 60 ms on a low-cost AWS instance (94.8 ms on a t3.medium in the post's table), covers 23 languages, and ships as ONNX. — [Daily: Smart Turn v3](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/)
- A Daily co-founder's guest post (older, 2024) calls 800 ms voice-to-voice "a good target", hard to hit consistently. It notes that most observability tools measure only inference TTFB, which excludes endpointing time. — [Latent Space: OpenAI Realtime API, the missing manual](https://latent.space/p/realtime-api)
- Vendor budget splits:
  - Smallest.ai (800 ms total): VAD/capture 50, STT 150, LLM TTFT 400, TTS first chunk 150, network 50. One 300 ms tool call pushes it to 1,100 ms or more. — [Smallest.ai](https://smallest.ai/blog/designing-voice-assistants-stt-llm-tts-tools-and-latency-budget)
  - Retell: network 50, VAD/turn-taking 200, LLM TTFT 250, TTS 100. Retell argues latency "hides" in turn-taking and LLM TTFT rather than in STT or TTS. — [Retell](https://www.retellai.com/blog/how-real-time-voice-ai-works-stt-llm-tts)
- Research and analyst targets: a clinical voice-AI paper treats a median LLM TTFT of about 500 ms as practical, with endpointing plus ASR at 150 to 300 ms and TTS first audio at 100 to 200 ms. — [arXiv 2603.29893](https://arxiv.org/pdf/2603.29893). Coval leaves the LLM 200 to 700 ms after streaming STT (150 to 300) and TTS TTFB (100 to 400). — [Coval](https://www.coval.ai/blog/voice-ai-models-2026/)
- Self-hosted reference build (Modal, Nov 2025): Parakeet-TDT-0.6B-v3, Qwen3-4B-Instruct on vLLM, Kokoro TTS, WebRTC, Silero VAD plus Smart Turn, all on GPUs, gave a **measured median voice-to-voice of about 1 s** with the client near the region. No per-stage breakdown was published. — [Modal](https://modal.com/blog/low-latency-voice-bot)
- Kyutai Unmute (GPU), from Kyutai's own pages:
  - The STT runs with a 500 ms delay. A "flush trick" processes the buffered audio at about 4x real time once the semantic VAD fires, so the wait is about 125 ms instead of 500 ms. — [Kyutai STT](https://kyutai.org/stt)
  - The TTS needs 220 ms from the first text token to the first audio chunk. — [Kyutai TTS](https://kyutai.org/next/tts)
  - A third-party docs mirror lists TTS start latency of about 750 ms when all services share one GPU and about 450 ms on separate GPUs. — [Unmute docs mirror (third-party)](https://www.mintlify.com/kyutai-labs/unmute/guides/performance-tuning)
- LiveKit defaults: endpointing `min_delay` 0.5 s and `max_delay` 3.0 s. `preemptive_generation.enabled` defaults to True (it starts the LLM on the final transcript before the turn is confirmed); `preemptive_tts` defaults to False. — [LiveKit turn tuning](https://docs.livekit.io/agents/logic/turns/tuning.md). LiveKit says preemptive generation "does not guarantee lower latency". — [LiveKit field guide](https://livekit.com/field-guides/guide/homepage-agent-latency)
- Production reality, from a secondary article dated May 2026:
  - Hamming AI's dataset of 4M+ calls shows **P50 1.4 to 1.7 s and P90 3.3 to 3.8 s**. Retell claims about 600 ms (vendor-stated).
  - The article recommends streaming LLM output into TTS, which it estimates saves 300 to 600 ms, and cutting VAD silence from 800 to 1,000 ms down to 400 to 600 ms, at the cost of more false interruptions.
  - Source: [SoftwareSeni](https://www.softwareseni.com/voice-agent-latency-solved-enough-for-production-benchmarks-and-architecture-tradeoffs)
- Another third-party breakdown: STT 280 ms, waiting on the LLM 600 ms, first audio 320 ms, transport 200 ms (unverified). — [channel.tel](https://www.channel.tel/blog/voice-ai-pipeline-stt-tts-latency-budget)

### Inferences
- **PAN today (PAN-internal numbers):**
  - Phone endpoint candidate: about 0.35 s, plus the Smart Turn decision.
  - Turn-audio upload, then Parakeet on the hub: about 0.37 s.
  - Router setup: about 0.2 s.
  - LFM3 re-reading about 370 prompt tokens: about 1.3 s.
  - About 25 label tokens at roughly 30 to 35 tok/s: about 0.7 to 0.8 s.
  - The first sentence's tokens, then Supertonic on the phone for the whole first sentence.
  - This adds up to the observed 2 to 3 s, and **about 2 s of it is LLM prompt re-read plus pre-reply labels**. No change to ASR or TTS fixes that.
- **Realistic CPU-only target:** about 0.8 to 1.1 s from end of speech to first audio. Breakdown:
  - Turn decision: about 250 to 350 ms after the pause.
  - Streaming-ASR finalization: about 60 to 120 ms (see Q2).
  - LLM state restore plus tail prefill plus first clause: about 350 to 500 ms (see Q3).
  - First TTS chunk on the phone: about 150 to 350 ms.
  - Transport and audio I/O: about 50 ms.
  - If LLM prefill starts preemptively on the endpoint candidate, part of the turn-decision wait overlaps with LLM work.
- Sub-500 ms is only plausible with a GPU or a native audio-in model (see the LFM3-Audio notes in Q2 and Q3). Even then, endpointing alone uses about 200 to 300 ms.
- Instrument the same way production stacks do: log timestamps at end of speech (VAD), endpoint commit, ASR final, LLM first token, first clause handed to TTS, first PCM written to AudioTrack, and playback head moved.

### Gaps
- No published per-stage budget for a fully CPU-only consumer box was found. All production breakdowns assume cloud GPUs.
- Twilio's widely cited per-stage targets turned up only second-hand, so they are not included.

---

## Q2. Streaming ASR on CPU/Android: speed, finalization latency, accuracy, English/Greek, licenses

### Takeaway
The standout 2026 option for CPU is **NVIDIA Nemotron Speech Streaming 0.6B (English)** via sherpa-onnx int8. It is a cache-aware streaming model and is commercially usable. On a 6-core desktop CPU it was measured at 45 to 75 ms finalization and RTF 0.067. Running it continuously during the user's turn on PAN's hub would replace the about 370 ms post-turn Parakeet pass and would also produce partial transcripts for preemptive LLM work. For Greek, the only permissive CPU-proven model found is **Parakeet-TDT-0.6B-v3** (CC-BY-4.0), which is non-streaming and weak on Greek (FLEURS WER 20.7%). **Moonshine v2 streaming** (MIT) is the best on-device English candidate for the phone or pendant path.

### Cited Findings
**Nemotron Speech Streaming en 0.6B** (cache-aware FastConformer, 24-layer encoder, RNNT decoder)
- NVIDIA Open Model License, "ready for commercial/non-commercial use". Released about 12 to 13 Mar 2026. Punctuation and capitalization are built in. — [HF model card](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)
- Average WER (no punctuation) by chunk size: 6.93 (1120 ms), 7.07 (560 ms), 7.67 (160 ms), 8.43 (80 ms). LibriSpeech test-clean: 2.32 / 2.46 / 2.56 / 2.80. AMI meetings: 11.73 / 11.88 / 14.71 / 18.29. — [HF model card](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)
- **Measured on CPU** (Ryzen 7500F, 6 cores, sherpa-onnx 1.13.8, int8, 1120 ms chunk, Sep 2026):
  - Finalization p50/p90 was 58/63 ms with 1 caller and 66/212 ms with 12 callers.
  - Unpaced RTF was 0.067 (14.9x real time).
  - Finalization by thread count (1 caller): 1 thread 196 ms, 2 threads 114, 4 threads 71, 6 threads 61.5.
  - Processing cost per second of audio (multilingual 3.5 model): 61 ms at 1120 ms chunks, 97 ms at 560, 145 at 320, 275 at 160, 646 at 80. The finalization floor is about 45 ms for small chunks.
  - First partial arrived about 1.3 s after audio start (1 caller, 1120 ms chunk). At 12 callers the p50 was 1.62 s with the 1120 ms chunk against 1.46 s with 560 ms.
  - Memory is about 1 GB resident plus about 100 MB per extra stream.
  - The author recommends feeding one chunk of silence at end of turn so the last words aren't lost.
  - Source: [Softcery](https://softcery.com/lab/hosting-nemotron-asr-streaming-on-a-cpu)
- sherpa-onnx ships int8 exports at 80, 160, 560 and 1120 ms (the 560 ms English encoder is 623 MB), plus a multilingual `nemotron-3.5-asr-streaming-0.6b` covering 40 locales. **Greek (el-GR) is in the "adaptation-ready" tier, which needs fine-tuning before it can transcribe.** — [sherpa-onnx Nemotron docs](https://k2-fsa.github.io/sherpa/onnx/nemo/nemotron-streaming.html)
- A desktop dictation app (Jul 2026) ships Nemotron streaming on CPU via sherpa-onnx ≥1.13.4. Partials land "well under a second behind your voice", and CPU per dictation roughly halved compared with buffered re-chunking. It says the multilingual model has 15 "transcription-ready" languages, which conflicts with the 19 locales listed in the sherpa docs. — [OpenWhispr](https://openwhispr.com/blog/local-streaming-speech-to-text)

**Parakeet-TDT-0.6B-v3** (the multilingual successor to PAN's v2)
- CC-BY-4.0, commercial use allowed. Covers 25 European languages **including Greek**, with punctuation and capitalization.
- WER: **Greek 20.70% on FLEURS**; English 4.85% on FLEURS; 6.34% average on the Open ASR leaderboard.
- Streaming exists only as NeMo chunked inference (example: 2 s chunks with 10 s left and 2 s right context).
- Source: [HF model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- Measured CPU speed: RTF 0.033 with int8 on an i7-12700K. — [parakeet-v3 FastAPI project](https://github.com/groxaxo/parakeet-tdt-0.6b-v3-fastapi-openai). Another source: 7.5x real time on an AMD 4750U CPU, and "weakest relative to the field in Greek (3.9x the leader's error)". — [Handy model page](https://models.handy.computer/models/parakeet-tdt-0.6b-v3)

**Moonshine v2 streaming** (Moonshine AI, Feb 2026)
- Tiny 34M, Small 123M, Medium 245M parameters, English only.
- End of speech to transcript on an Apple M3 CPU (ONNX Runtime): Tiny 50 ms, Small 148 ms, Medium 258 ms. Whisper on the same test: Tiny 289 ms, Small 1,940 ms, Large-v3 11,286 ms.
- Average WER across the Open ASR sets: 12.01 (Tiny), 7.84 (Small), 6.65 (Medium).
- Source: [arXiv 2602.12241](https://arxiv.org/html/2602.12241v1)
- Licensing and platforms: "The models are MIT by default too, in every language and at every size." The exceptions are legacy non-streaming non-English models, which use a non-commercial community license. One library covers Python, JS/WASM, iOS, Android, Windows and Raspberry Pi, and "does work while the user is still talking". — [Moonshine repo](https://github.com/moonshine-ai/moonshine)
- Raspberry Pi 5 per-utterance latency from the README, via search: Tiny 237 ms, Small 527 ms, Medium 802 ms. — [Moonshine repo](https://github.com/moonshine-ai/moonshine). The model card warns it can hallucinate or repeat on short or noisy audio. — [HF moonshine-streaming-tiny](https://huggingface.co/moonshine-ai/moonshine-streaming-tiny)

**Kyutai STT** (delayed-streams modeling)
- `stt-1b-en_fr` runs with a 500 ms delay and a built-in semantic VAD that predicts end of turn and "adapts based on content and intonation". The VAD is in the Rust server only. `stt-2.6b-en` runs with a 2.5 s delay.
- With the flush trick, finalization is about 125 ms.
- Throughput is GPU-only: 400 streams on an H100, 64 on an L40S. No CPU numbers are published, and the page states no license.
- Source: [Kyutai STT](https://kyutai.org/stt)

**Qwen3-ASR-0.6B**
- Apache-2.0; 30 languages **including Greek** plus 22 Chinese dialects; the weights actually hold about 0.9B parameters.
- "Streaming inference is only available with the vLLM backend." Average streaming WER is 4.40 against 3.48 offline.
- llama.cpp, ONNX and CPU are not mentioned.
- Source: [HF card](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)

**Voxtral Realtime (Mistral)**
- 4B parameters, natively streaming, Apache-2.0, 13 languages.
- Latency is "configurable down to sub-200 ms" (vendor). It reaches Whisper-level accuracy at a 480 ms delay. No CPU data. — [Mistral](https://mistral.ai/fr/news/voxtral-transcribe-2); [arXiv 2602.11298](https://arxiv.org/html/2602.11298v2)

**Whisper family**
- Not natively streaming. The Moonshine paper's M3 latency table (above) shows Whisper Small at 1.94 s and Large-v3 at 11.3 s per utterance on CPU.
- WhisperLiveKit (LocalAgreement or SimulStreaming policies) claims 200 to 800 ms first-word latency, a vendor-adjacent figure with no hardware stated. — [x-cmd WhisperLiveKit page](https://x-cmd.com/install/whisperlivekit)
- One fork notes SimulStreaming carries "dual-license requirements". — [WhisperLiveKit fork](https://github.com/a313/WhisperLiveKit_fork)

**LFM3-Audio-2B (Liquid, 27 Oct 2026; vendor claims)**
- English ASR WER 6.2 and a 9-language average of 6.0.
- "The audio encoder is fully causal and can prefill while the user speaks", with TTFT "as low as 50 ms after speech ends".
- Source: [LFM3 deep dive](https://local-ai-zone.github.io/blog/lfm3-deep-dive.html)

### Inferences
- **Highest-value ASR change for PAN:** stream turn audio to the hub continuously and run Nemotron en 0.6B (int8, 1120 or 560 ms chunk, 2 to 4 threads) during the turn.
  - At end of turn only the last chunk plus one silence chunk remain. Expect about 70 to 150 ms on the Zen 3 5800H, an estimate scaled from 61.5 to 71 ms at 4 to 6 threads on a Zen 4 DDR5 7500F. That saves about 250 to 300 ms against the 370 ms Parakeet pass.
  - Its stable partials can drive preemptive LLM prefill.
  - Its CPU cost was measured at about 0.18 to 0.4 core-seconds per second of audio (M2 at 2 threads; 7500F at 6 threads, unpaced). That is roughly 3 to 7% of the 5800H's 8 cores while the user speaks, but it competes with LLM prefill, so pin thread counts: about 2 to 4 for ASR and the rest for the LLM.
- Chunk choice: 1120 ms has the best WER and lowest cost, and finalization is only about 15 ms worse than at 560 ms. The 160 and 80 ms chunks buy faster partials but cost 4 to 10x more CPU and add about 1 to 1.5 WER points.
- **Greek:** route by language.
  - English goes to streaming Nemotron.
  - Greek goes to batch Parakeet v3 (CC-BY-4.0, Greek WER 20.7% on FLEURS, about 0.3 to 0.4 s per turn).
  - Revisit with Qwen3-ASR-0.6B (Apache-2.0, includes Greek) when a GPU or vLLM path exists, or by fine-tuning multilingual Nemotron 3.5 for el-GR.
- **On the phone or pendant path:** the 20M LibriSpeech zipformer is adequate as an endpoint detector. If on-device ASR is ever needed (offline mode, or to avoid uploading audio), Moonshine v2 Small streaming (MIT, 148 ms on an M3, 7.84% WER) is the candidate to test before Nemotron, which PAN found about 7x too heavy for the phone.
- Kyutai STT's semantic VAD is the right idea, but the model is GPU-oriented and English/French only, and its license must be checked on Hugging Face. PAN's two-stage approach (sherpa endpoint candidate plus Smart Turn v3.2) is the CPU-friendly equivalent.

### Gaps
- No Android or ARM RTF was found for Nemotron streaming. PAN's own phone test said it was too slow; no external number confirms or refutes that.
- No independent Greek WER was found for Qwen3-ASR or for fine-tuned Nemotron. Kyutai STT's license was not confirmed from an official page.
- Vosk and Android's on-device `SpeechRecognizer` were not benchmarked in any 2025-26 source found.
- Smart Turn v3's 23-language list was not checked for Greek.

---

## Q3. LLM time-to-first-token on CPU: prefix/state caching for hybrid models, warm KV across turns, speculative decoding, preemptive generation, answer-first output, and small-model choice

### Takeaway
Prefix reuse for hybrid conv/attention models **is possible in llama.cpp but not automatic, and not exposed by Ollama**. llama-server supports per-slot "context checkpoints", which snapshot the recurrent plus SWA state, as well as explicit slot save and restore to file. Two settings matter. The checkpoint minimum spacing defaults to 8,192 tokens. And a checkpoint is only useful if it sits exactly at the end of the constant prefix, or at the end of the previous turn in an append-only conversation. For PAN, restoring a saved "constant prefix" state each turn and putting the reply before the labels should remove about 1.5 to 1.9 s of CPU TTFT. Speculative decoding barely helps chat on CPU. A 3050-class GPU makes prefill nearly free (3,860 tok/s for Gemma 4 E2B).

### Cited Findings
**llama.cpp server mechanisms** (current master README)
- `-ctxcp, --ctx-checkpoints, --swa-checkpoints N`: "max number of context checkpoints to create per slot (default: 32)".
- `-cms, --checkpoint-min-step N`: "minimum spacing between context checkpoints in tokens (default: 8192, 0 = no minimum)".
- `--slot-save-path` with `POST /slots/{id}?action=save|restore|erase` saves or restores a slot's prompt cache to a file and reports `timings.save_ms` and `timings.restore_ms`.
- `--cache-ram` (default 8192 MiB) is a host-RAM prompt cache, and `cache_prompt` defaults to true.
- `--cache-reuse` (KV shifting) defaults to 0, meaning off.
- Speculative decoding: `--spec-type` (n-gram variants or a draft model) and `--spec-draft-model`.
- Source: [llama.cpp server README](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md)
- **Hybrid failure mode, documented for LFM2:**
  - llama.cpp logs "forcing full prompt re-processing due to lack of cache data (likely due to SWA or hybrid/recurrent memory)".
  - The reporter explains that the model's cache "doesn't support restoring the cache to arbitrary positions". Checkpoints were made only at the end of the prompt, so any request that changed the end of the prompt reprocessed from the start.
  - Workaround: split the prompt and run a pre-completion with `n_predict = 1` so checkpoints exist at the segment boundaries.
  - Source: [llama.cpp #16491 (LFM2-2.6B / LFM2-8B-A1, Oct 2025)](https://github.com/ggml-org/llama.cpp/issues/16491). The same symptom appears for Nemotron-H. — [#16416](https://github.com/ggml-org/llama.cpp/issues/16416)
- Checkpoints are snapshots of recurrent plus SWA state. When no checkpoint passes the position threshold the server sets n_past to 0, which means a full reprocess. The older `--checkpoint-every-n-tokens` flag was removed on 2026-05-25. — [particula.tech (secondary)](https://particula.tech/blog/prompt-reprocessing-swa-hybrid-models-kv-cache)
- PR #22929 (May 2026; open at the time of the article) checkpoints at the latest user-message boundary for GPT, Gemma 4 and ChatML templates. In testing, later turns reprocessed a few hundred tokens instead of thousands. — [StartupFortune](https://startupfortune.com/llamacpp-checkpoint-fix-speeds-local-coding-agents/)
- **Ollama:** no official documentation of hybrid prefix reuse was found.
  - In a fork, Qwen3.5 resumes from checkpoints saved about every 2,000 tokens, so each turn re-reads up to that many. — [ollama37 PR #591](https://github.com/dogkeeper886/ollama37/pull/591)
  - Another project found that models loaded through Ollama are treated as attention-only. — [Sonder-Inference PR #33](https://github.com/Krilliac/Sonder-Inference/pull/33)
  - PAN-internal: Ollama does not reuse LFM3's cache, and the about 370-token prompt is re-read every turn (about 1.3 s).

**LFM3 facts relevant to caching and licensing** (released 27 Oct 2026)
- Architecture of LFM3-1.7B:
  - 24 layers: 13 gated short-convolution layers (kernel 7), 5 sliding-window-attention layers (256-token window) and 6 global-attention layers.
  - KV cache costs about 12 KB per token, from the 6 global layers only.
  - The SWA cache is a fixed about 2.6 MB.
  - Conv state is 6 positions × 2,048 channels, about 24 KB per layer.
- LFM3-Omni-2B has 2.2B parameters.
- GGUF "needs an LFM3-compatible llama.cpp build (b11744 is not sufficient)". Upstream llama.cpp and Ollama inclusion timing is unknown.
- Vendor speed claim: at least 2.5x faster prefill and at least 1.8x faster decode than the compared models, measured with GPU or iGPU offload. No CPU-only numbers were published.
- Source: [LFM3 deep dive](https://local-ai-zone.github.io/blog/lfm3-deep-dive.html)
- License: LFM Open License v1.0 is free for organizations under $10M annual revenue; larger companies need a paid agreement. — [FourWeekMBA](https://fourweekmba.com/ai-liquid-ai-opens-lfm3-free-to-firms-under-10m-in-revenue/). Liquid claims LFM3-1.7B beats Qwen3.5-9B on average across 29 benchmarks (vendor). — [AlphaSignal](https://alphasignal.ai/news/liquid-ai-s-lfm3-beats-9b-rivals-using-a-tiny-1-7b-on-device-model)

**Preemptive and early generation**
- LiveKit starts LLM generation "as soon as a final transcript arrives, before the turn is confirmed" (on by default). Related settings:
  - `max_speech_duration` 10 s skips the feature for long utterances.
  - `max_retries` 3 caps attempts per turn.
  - `preemptive_tts` is off by default because cancelled turns waste compute.
  - Source: [LiveKit tuning](https://docs.livekit.io/agents/logic/turns/tuning.md)
- Pipecat streams LLM output into TTS with a sentence aggregator budgeted at about 20 ms. It uses "LLM single-token tagging" (✓/○/◐) as a turn-completion signal emitted before the reply. — [primer](https://voiceaiandvoiceagents.com/)

**Speculative decoding on CPU**
- A CPU-only llama.cpp test gave 1.72x overall (12.9 to 22.1 tok/s): code 1.96x, math 2.03x, but **chat 1.01x**. The article is internally inconsistent about which model sizes were used. — [InventiveHQ](https://inventivehq.com/blog/llama-cpp-speculative-decoding-consumer-gpu)
- llama.cpp merged multi-token-prediction (MTP) drafting for Gemma 4 E2B and E4B (PR #24282, 8 Jun 2026). On a Galaxy S26+ (Hexagon backend) it reached 47.89% acceptance at 3 drafted tokens, gaining only about 1 to 2 tok/s (14 tok/s decode, 683 tok/s prefill). — [AI Weekly](https://aiweekly.co/alerts/llamacpp-adds-gemma-4-e2be4b-mtp-assistant-support)

**Measured small-model speeds** (sparse; none on a 5800H)
- Gemma 4 E2B Q4_0 QAT on an **RTX 3050 8 GB** with llama.cpp CUDA (Oct 2026):
  - Decode 116 tok/s (tg128); prefill **3,860 tok/s** (pp512).
  - TTFT 212.7 ms for a 512-token prompt with one user.
  - VRAM 2.77 GB at 8K context; E4B uses 6.43 GB at 131K context.
  - Source: [DEV: Gemma 4 on a used RTX 3050](https://dev.to/gde/gemma-4-on-a-used-8-gb-rtx-3050-116-tokenss-for-one-user-618-for-64-k6h)
- Gemma 4 E4B on an Intel Core Ultra 9 185H laptop CPU with llama.cpp: prefill 109 tok/s (1,024 tokens), decode 15 tok/s (self-reported, Oct 2026). — [HF Janas-LLM card](https://huggingface.co/prabanta-dev/gemma-4-E4B-it-JNS)
- LFM2.5-1.2B-Thinking Q4_0: 25.3 tok/s decode on a 4-thread ThinkPad (llama-bench tg64). — [cpu-only-inference-models](https://huggingface.co/ljupco/cpu-only-inference-models). On Ryzen AI NPUs it reaches 2,032 to 2,226 tok/s prefill and about 60 tok/s decode. — [FastFlowLM v0.9.27](https://github.com/ROCm/FastFlowLM/releases/tag/v0.9.27)
- Qwen3.5-4B Q4_K_M runs at about 24 tok/s decode on a Ryzen 7 7700X with DDR5-6000 (ballpark, method not stated). — [bestllmfor.com](https://bestllmfor.com/guide/llm-local-cpu-sans-gpu/)
- PAN-internal (5800H, DDR4): 2B models decode at about 22 to 35 tok/s; prefill is about 95 tok/s cold (gemma4:e2b) and about 530 tok/s on a cached prefix; LFM3 re-reads about 370 tokens in about 1.3 s, which is about 285 tok/s.

### Inferences
- **Make the constant prefix free (largest CPU win, estimated saving about 1.0 to 1.1 s):** move the OmniΠ voice path from Ollama to an LFM3-compatible `llama-server` and use one of these options:
  - **(a) Explicit state restore.** Run the constant system and persona block once and `action=save` it. Each turn, `action=restore`, then send only the variable tail.
    - LFM3's state at 370 tokens is a few MB: global KV of about 4.4 MB, SWA of about 2.6 MB and conv state of about 0.3 MB, computed from the figures above. The restore should therefore cost milliseconds.
    - The variable tail of about 40 to 60 tokens costs about 0.15 to 0.2 s at about 285 tok/s.
    - Verify that slot restore round-trips recurrent memory on the build in use.
  - **(b) Primed checkpoint.** Set `-cms 0` or a value below the prefix length. Then issue a priming request that ends exactly at the prefix boundary, the `n_predict=1` trick from #16491, so a checkpoint exists there.
  - **(c) Append-only conversation.** Make each turn's prompt a strict extension of the previous turn's prompt plus reply, so the end-of-previous-turn checkpoint is always valid. This is what PR #22929 automates.
  - Never put anything that changes per turn (time, mood, retrieved memories) before the cached boundary. PAN already learned this for attention models; for hybrid models it is all-or-nothing rather than graceful.
- **Answer-first output (estimated saving about 0.6 to 0.8 s):** OmniΠ currently decodes about 25 label tokens (about 0.7 to 0.8 s at 30 to 35 tok/s) before any speech.
  - Retrain so the output is one short routing token (camera, standing instruction or tool, in the spirit of Pipecat's single-token tags), then the reply, then the remaining JSON labels.
  - Speech can then start after about 1 + 6 to 8 tokens, about 0.25 to 0.35 s.
  - Labels needed only after the reply (memory writes, mood) cost nothing perceptible.
- **Preemptive start (hides up to about 0.25 to 0.35 s):**
  - Begin restore plus tail prefill when the phone's sherpa endpoint candidate fires, while Smart Turn or flow mode deliberates.
  - On "hold", discard and restore the prefix again; restore is cheap, so wasted work is bounded.
  - With streaming ASR, prefill can even begin from stable partials. With a recurrent model, appended text can't be retracted, so restart from the prefix checkpoint whenever the partial changes.
- **Speculative decoding** is not worth it for PAN on CPU: chat speedup was about 1.0x, and drafts on hybrid models need state rollback, which is exactly the weak point above. N-gram speculation (`--spec-type ngram-*`) might speed up echo-like JSON labels, but answer-first makes that moot.
- **Small-model choice:**
  - On CPU, decode is memory-bandwidth-bound. Dual-channel DDR4-3200 gives about 51 GB/s theoretical, which caps a 2B Q4 model (about 1.2 to 1.5 GB of weights) at roughly 35 to 40 tok/s, matching PAN's 22 to 35 tok/s.
  - A 1.2 to 2B model is the CPU sweet spot; 4B models roughly halve decode speed.
  - Keep LFM3 (fastest family per vendor claims, already distilled), but plan for its $10M revenue threshold.
  - For a permissive fallback, re-run llama-bench on the hub for Qwen3.5-2B, Gemma 4 E2B and a Granite 4 small model. Licenses were not verified this session.
- **With the RTX 3050:**
  - At 3,860 tok/s prefill, a full 370-token prompt costs about 0.1 s.
  - At 100+ tok/s decode, even labels-first adds only about 0.25 s, so caching tricks become optional.
  - Hard turns can go to E4B or a larger model within 8 GB.
  - PAN-internal notes recorded multi-second prefill at about 1,900 tokens on that 3050. The published llama-bench rate for E2B implies about 0.5 s for that prompt, several times faster, so check the GPU path (layer and KV offload, context settings, which model) before concluding the GPU is too slow.

### Gaps
- No public measurement exists of LFM3 (or LFM2.5) prefill and decode on an x86 CPU without GPU offload.
- Not confirmed:
  - whether current llama.cpp slot save and restore correctly serializes LFM3's conv and SWA state;
  - whether Ollama ever exposes checkpoints for LFM-family models;
  - whether LFM3-Audio/Omni audio input is merged into upstream llama.cpp (sources conflict).
- No reliable 2026 Zen 3 benchmarks were found for Phi-4-mini, Llama 3.2 3B, SmolLM3, Granite 4 nano/micro, Gemma 3n or Qwen3.5-2B. Licenses for Gemma 4 and Qwen3.5 were not verified here.

---

## Q4. Streaming TTS: time to first audio, RTF on CPU, Android and 8 GB GPU, streaming text input, expressiveness, context-aware prosody, cloning, Greek, license, and phone versus hub

### Takeaway
On CPU and phone, the fast, permissive field in late 2026 is: Supertonic (fastest, 31 languages including Greek, inline expression tags, **but the repo was archived 9 Sep 2026**), Kitten TTS v0.8 (Apache-2.0, English), Kyutai Pocket TTS (100M, streaming, about 200 ms first chunk on 2 CPU cores, cloning, **CC-BY-4.0 per its HF card**, which conflicts with PAN's earlier reading of the sherpa bundle as non-commercial), Kokoro (Apache-2.0 but about 1x real time on PAN's CPU), Chatterbox Nano (MIT, 110M, about 3x real time on 8 cores) and Soprano 1.1 (80M, vendor 20x real time on CPU). Truly expressive or context-aware prosody models (CSM-1B, Kyutai TTS, VibeVoice-Realtime, CosyVoice 3, Qwen3-TTS, Chatterbox Turbo and Multilingual, Orpheus) need a GPU. For Greek, the options are Supertonic 3 (archived, OpenRAIL-M), Chatterbox Multilingual V3 (MIT, GPU-class) or the low-quality Piper el_GR voice.

### Cited Findings
**Phone and CPU-class engines**
- **Supertonic 3:**
  - About 99M parameters and 31 languages, **including Greek (el)**, plus a language-agnostic mode.
  - Ten inline expression tags (`<laugh>`, `<breath>`, `<sigh>` and others) that need no reference audio. Preset voice styles; there is no open cloning pipeline.
  - MIT code and **OpenRAIL-M** weights.
  - **"This repository was archived by the owner on Sep 9, 2026"**: no further development or official support for the open-source models (notice dated 23 Jul 2026). Voice Builder shut on 31 Aug 2026.
  - The only RTF given is 0.3 on an e-reader.
  - Source: [Supertonic GitHub](https://github.com/supertone-inc/supertonic)
  - The Supertonic 2 card claims up to 167x real time and says commercial use is allowed. — [HF Supertonic 2](https://huggingface.co/Supertone/supertonic-2)
- **Kyutai Pocket TTS:**
  - 100M parameters; **"License: cc-by-4.0"**, with HF gating (accept conditions) and a prohibited-use clause against cloning without consent.
  - Six languages: en, fr, de, pt, it, es.
  - About 6x real time on an M4 MacBook Air CPU using only 2 cores, and about 200 ms to the first audio chunk. A 4-vCPU x86 cloud VM ran it at about 2.3 to 2.5x real time.
  - Audio streaming and voice cloning from a WAV are supported.
  - Source: [HF kyutai/pocket-tts](https://huggingface.co/kyutai/pocket-tts)
  - An independent measurement on an Apple M2 CPU gave 250 to 430 ms to the first audio of a sentence, at about 5x real time. — [micdrop](https://micdrop.dev/docs/ai-integration/provided-integrations/pocket-tts)
- **Kitten TTS v0.8 (Feb 2026):**
  - Mini 80M (about 79 MB), Micro 40M, Nano 15M (about 25 MB int8); English only; 8 named voices.
  - The Mini card says Apache-2.0. — [HF kitten-tts-mini-0.8](https://huggingface.co/KittenML/kitten-tts-mini-0.8)
  - A community CPU test measured Mini at 1.6x real time and Nano at 15x, and found int8 slower than fp32 in some tests. — [Reddit snapshot](https://reddit.sentinel-team.org/posts/1r8pztp/snapshots/2026-02-27T15%3A04%3A59.533315Z)
- **Kokoro-82M:** Apache-2.0; v1.0 has 8 languages and 54 voices, and Greek is not listed. — [HF card](https://huggingface.co/hexgrad/Kokoro-82M)
  - App-maintainer figure: about 20 to 40 s of compute per minute of audio on a Snapdragon 8 Gen 3 (RTF about 0.33 to 0.67), against about 5 s per minute for Piper (anecdotal). — [VoxSherpa TTS](https://github.com/CodeBySonu95/VoxSherpa-TTS)
  - On an Android emulator: RTF 0.58. — [soniqo](https://soniqo.audio/benchmarks/android)
- **Chatterbox (Resemble AI), all MIT:**
  - **Nano**: 110M, English, paralinguistic tags, "3x faster than realtime on 8 CPU cores".
  - **Turbo**: 350M, English, one-step decoder, tags such as `[laugh]` and `[cough]`.
  - **Multilingual V3**: 500M, 23+ languages **including Greek (el)**.
  - The original model has exaggeration and CFG controls.
  - The "sub 200 ms" claim refers to Resemble's commercial service, not the open models. All output carries a Perth watermark.
  - Source: [Chatterbox repo](https://github.com/resemble-ai/chatterbox)
- **Soprano** (80M): the official card claims about 20x real time and under 250 ms streaming latency on CPU, about 2000x and under 15 ms on GPU, and under 1 GB of memory (vendor). — [Soprano README](https://huggingface.co/ekwek/Soprano-Encoder/blob/main/README.md). Soprano-1.1-80M (14 Jan 2026) claims 95% fewer hallucinations. — [aiindigo listing (secondary)](https://aiindigo.com/tool/soprano-11-80m)
- **NeuTTS (Neuphonic):**
  - Air: about 360M active parameters (about 552M with embeddings), English, **Apache-2.0**.
  - Nano (English, French, German, Spanish) and **NeuTTS-2E** (emotional, text input): "NeuTTS Open License 1.0"; terms not stated on the page.
  - Speech-LM speed (Q4_0, llama-bench), Air / Nano: Ryzen 9 HX 370 CPU 119 / 221 tok/s; iMac M4 111 / 195; **Galaxy A25 phone CPU 20 / 45**.
  - The codec runs at 50 Hz. Streaming needs GGUF. Output carries a Perth watermark.
  - Source: [NeuTTS repo](https://github.com/neuphonic/neutts)
- **Piper:**
  - rhasspy/piper was archived on 6 Oct 2025. Development moved to OHF-Voice/piper1-gpl under **GPL-3.0**, and voice licenses are separate. — [rhasspy/piper](https://github.com/rhasspy/piper); [piper1-gpl releases](https://github.com/OHF-voice/piper1-gpl/releases)
  - A plausible reason for the GPL move is that espeak-ng, used for phonemization, is GPL-3.0. — [PromptQuorum](https://www.promptquorum.com/power-local-llm/piper-tts-review)
  - The Greek voice `el_GR-rapunzelina-low` lists a CC0 training dataset on its model card. — [model card](https://huggingface.co/rhasspy/piper-voices/raw/4d68f18217d5c6a4b2418c8c46222d6fcd698acb/el/el_GR/rapunzelina/low/MODEL_CARD). A reseller labels it non-commercial, which conflicts with the card. — [tts.ai](https://tts.ai/voices/piper/?lang=el)
- PAN-internal (dev laptop CPU, warm, same sentence, Sep 2026): Piper RTF 0.06, **Supertonic 0.23**, Kitten nano 0.24, Kokoro int8 1.09 to 1.15. Phone-side generation speed was never measured.

**GPU-class expressive and streaming-text models**
- **Kyutai TTS 1.6B** (actually 1.8B):
  - Weights are **CC-BY-4.0**; English and French.
  - Starts audio from the first few words of streamed text: 220 ms from first text token to first audio per Kyutai. — [Kyutai TTS](https://kyutai.org/next/tts)
  - Audio runs 1.28 s (16 steps) behind the text internally. Voice cloning is restricted to pre-computed embeddings. An L40S serves 16 streams at more than 2x real time. No CPU support is stated.
  - Source: [HF card](https://huggingface.co/kyutai/tts-1.6b-en_fr)
- **VibeVoice-Realtime-0.5B (Microsoft):**
  - MIT license, streaming text input, about 300 ms to first audible speech (hardware dependent). English only and single speaker.
  - The card says it is "intended for research purposes only" and "not recommended for commercial use without further testing". — [HF card](https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B)
  - A DGX Spark user measured RTF 0.48 and 766 ms to first audio for the whole pipeline. — [NVIDIA forum](https://forums.developer.nvidia.com/t/dgx-spark-vibevoice-tts-streaming-voice-pipeline-setup-guide/356424)
- **CosyVoice:** repo Apache-2.0. Fun-CosyVoice3-0.5B (Dec 2025) covers 9 languages (no Greek), with bi-streaming (text in, audio out) latency "as low as 150 ms", vLLM support and no CPU numbers. — [CosyVoice repo](https://github.com/FunAudioLLM/CosyVoice)
- **Qwen3-TTS (0.6B and 1.7B):** about 97 ms first-packet latency (vendor; hardware not stated, GPU implied; network latency comes on top for remote use) and 10 languages (no Greek). Apache-2.0 per secondary sources. — [Qwen3-TTS streaming docs (mirror)](https://mintlify.com/QwenLM/Qwen3-TTS/guides/streaming)
- **Orpheus 3B:**
  - Needs about 83 tok/s of SNAC tokens for real time. — [Baseten inference book](https://www.baseten.co/inference-engineering/book/06-modalities/6.4-tts-models.md)
  - A CPU ONNX run on 12 cores was about 37 to 41x slower than real time. The announced 1B, 400M and 150M tiers reportedly never shipped. — [phoonnx-orpheus](https://huggingface.co/OpenVoiceOS/phoonnx-orpheus)
- **Sesame CSM-1B** conditions on interleaved conversation text and audio, so prosody follows context. It reached RTF 0.383 on an L4 GPU, and below 1 on CPU only with RVQ iterations cut to 16. — [i-LAVA (arXiv 2509.20971)](https://arxiv.org/html/2509.20971v1). An MLX port claims about 120 ms first audio (unverified). — [CSM-1B-MLX](https://huggingface.co/aufklarer/CSM-1B-MLX-8bit)
- **Small-GPU numbers (vendor marketing pages):**
  - RTX 3050 6 GB: Kokoro about 85 ms first audio, Piper about 95 ms.
  - Kokoro RTF 0.02 to 0.03 on an RTX 3090 or 4060 Ti; Chatterbox about 0.08 (3090) and 0.12 (4060 Ti).
  - Source: [GigaGPU RTX 3050 page](https://gigagpu.com/?p=1841)
  - A browser benchmark measured Kokoro at about 1.1 RTF on a mid-range x86 laptop (WASM) and Chatterbox q4 at about 1.0 on an RTX-class GPU (WebGPU). — [voicechanger.live benchmarks](https://voicechanger.live/text-to-speech/benchmarks)
- **LFM3-Audio-2B (vendor):** speech output UTMOSv2 3.8, WER 1.4%, 18 languages (Greek not confirmed). LiquidCodec decodes at about 87x real time on one CPU thread (M4 Max). — [LFM3 deep dive](https://local-ai-zone.github.io/blog/lfm3-deep-dive.html)

### Inferences
- **What dominates TTS latency is the first chunk, not RTF.** PAN already speaks per sentence; the next step is to split at the first clause or after about 5 to 8 words.
  - At Supertonic's laptop RTF of 0.23, a 1.5 s first clause takes about 0.35 s to synthesize, against about 0.7 s for a 3 s sentence.
  - The phone may be slower than the laptop, so measure on the device before deciding. If the phone is about 2x slower, TTS becomes the largest remaining CPU-stack stage.
- **Supertonic risk:** it is fast, has Greek (v3) and expression tags, and its weights remain usable under OpenRAIL-M. But it is now unmaintained upstream, and it is unverified whether the sherpa-onnx bundle PAN uses (2026-03-06) is v2 or v3. Treat it as the current default with a planned successor.
- **Successor candidates for the phone:**
  - Pocket TTS: streaming, cloning gives a single consistent "PAN voice", 2-core real time, about 200 ms first chunk on M-series. Its license reads CC-BY-4.0 on HF, so re-check the sherpa bundle README and the gating terms; PAN's earlier note recorded "non-commercial". It has no Greek.
  - Kitten v0.8 Micro or Mini: Apache-2.0, English only.
  - Chatterbox Nano: MIT, tags; about 3x real time on 8 desktop cores may be marginal on a phone.
  - NeuTTS Nano or 2E: about 45 tok/s on a Galaxy A25 is below the 50 Hz real-time rate, and the license is unclear.
- **GPL exposure:** Piper (now GPL), Kokoro and Kitten in sherpa-onnx phonemize through espeak-ng. If espeak-ng is GPL-3.0 as reported, a commercial closed-source APK linking it needs legal review. Supertonic, which uses its own unicode indexer per PAN's notes, avoids espeak.
- **Context-aware or expressive prosody** (laughs, emphasis following the conversation) realistically requires the GPU box: CSM-1B, Chatterbox Turbo, CosyVoice 3 or Qwen3-TTS (no Greek), or Kyutai TTS (en/fr, CC-BY-4.0). VibeVoice-Realtime's MIT license comes with a "research purposes only" intent statement, which is a commercial risk.
- **Greek speech:** short term, Android system TTS (already used for non-English) or Supertonic 3 if a sherpa export exists. GPU path: Chatterbox Multilingual V3 (MIT).

### Gaps
- No measured Android RTF or first-chunk latency was found for Supertonic, Pocket, Kitten v0.8, Soprano or Chatterbox Nano. PAN should measure on its own phone with a direct benchmark entry point.
- Not verified: the license and commercial terms of the NeuTTS Open License 1.0; Soprano's license; Fish Speech / OpenAudio, Spark-TTS, MeloTTS and Sesame CSM licenses; whether Supertonic 3 is exported for sherpa-onnx.
- No measured RTX 3050 or 3060 first-audio numbers exist for Chatterbox Turbo, CosyVoice 3, Qwen3-TTS or CSM-1B; only vendor marketing for Kokoro.

---

## Q5. Audio transport and device latency: WebRTC/Opus vs WebSocket PCM vs HTTP upload, jitter buffers, Tailscale direct vs DERP, Android audio I/O, and ESP32-S3 pendant links

### Takeaway
Stream audio continuously during the turn rather than uploading it after the turn. On a clean LAN or Wi-Fi path, a WebSocket carrying 20 ms frames is acceptable. On cellular, WebRTC/Opus over UDP avoids TCP head-of-line stalls. A DERP-relayed Tailscale path can add about 50 to 450 ms, so confirm the phone and hub are "direct". Android low-latency audio adds only about 20 to 40 ms round trip when configured correctly. The ESP32-S3 has BLE only: no Classic Bluetooth (no A2DP/HFP) and no LE Audio/LC3. The pendant should therefore stream Opus over Wi-Fi, or over custom BLE GATT to the phone.

### Cited Findings
- The Pipecat primer budgets about 10 ms network transit, 21 ms Opus framing, 40 ms jitter buffer, 40 ms mic input and 15 ms speaker output each way. It says "WebSockets shouldn't be used in production for client-server, realtime media connections" and recommends WebRTC for native mobile apps, with WebSockets fine server-to-server or for prototyping. It also says echo cancellation "has to run on the device". — [primer](https://voiceaiandvoiceagents.com/)
- The case against TCP is head-of-line blocking: a lost packet stalls later audio and then delivers it in a burst. Base64 PCM over WebSocket uses roughly 10x the bitrate of Opus. — [BlogGeek.me (2026)](https://bloggeek.me/voice-ai/); [LiveKit: WebRTC vs WebSockets](https://livekit.com/blog/why-webrtc-beats-websockets-for-voice-ai-agents)
- Counterpoint: WebSocket is a reasonable default for most pipelines, with WebRTC recommended specifically for consumer devices on unreliable mobile networks. — [ElevenLabs](https://elevenlabs.io/blog/real-time-speech-to-text-under-200ms). Inworld documents both paths: WebSocket base64 PCM16 versus WebRTC Opus/RTP. — [Inworld docs](https://docs.inworld.ai/realtime/connect/webrtc.md)
- **Tailscale:**
  - All connections start over DERP and then try to upgrade to direct. If direct fails, a peer relay is tried. DERP runs over HTTPS on TCP 443 and is the slowest path. `tailscale ping` and `tailscale status` show "direct", "relay" or "peer-relay". — [Tailscale connection types](https://tailscale.com/kb/1257/connection-troubleshooting/)
  - Tailscale's own troubleshooting examples show a DERP path at about 441 to 478 ms. — [Tailscale connection types](https://tailscale.com/kb/1257/connection-troubleshooting/)
  - Peer relays gave about 12.5x improvement over DERP in one international case. — [Tailscale peer relays blog (Jan 2026)](https://tailscale.com/blog/peer-relays-international-networks)
  - One third-party test: DERP about 283 ms against a peer relay at about 39 ms. — [Functionize](https://support.functionize.com/hc/en-us/articles/39954918339863-Direct-Connection-vs-Relayed-connections)
- **Android audio:**
  - With Oboe/AAudio and all recommendations followed, round trip is about 20 ms; shared mode adds about 6 ms (26 ms); without low-latency performance mode it is about 205 ms. — [Android low-latency audio](https://developer.android.com/games/sdk/oboe/low-latency-audio)
  - The popular-phone average was 39 ms in 2021, down from 109 ms in 2017; the Pixel 3a was the first Android phone with 10 ms (older data). — [Android Developers Blog 2021](https://android-developers.googleblog.com/2021/03/an-update-on-androids-audio-latency.html)
- **ESP32-S3 radio:** "Bluetooth LE only", lacking both Classic Bluetooth (A2DP/HFP) and LE Audio. ESP-ADF points to the ESP32-S31 for Classic audio. — [ESP-ADF Bluetooth audio guide](https://docs.espressif.com/projects/esp-adf/en/latest/solution-center/bluetooth-audio.html); [ESP-IDF ESP32-S3 BLE overview](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/ble/overview.html). LE Audio (LC3 over CIS/BIS) APIs exist for the ESP32-S31 and H4 targets as a preview. — [ESP-BLE-AUDIO (ESP32-H4)](https://docs.espressif.com/projects/esp-idf/en/latest/esp32h4/api-reference/bluetooth/esp-ble-audio.html)
- Espressif's xiaozhi component (ESP32-S3) streams Opus, G.711 or PCM over WebSocket or MQTT+UDP. The Opus frame duration defaults to **60 ms**, configurable from 10 to 120 ms, at 16 kHz mono. Wake word and AEC are left to the application. — [Espressif xiaozhi docs](https://docs.espressif.com/projects/esp-iot-solution/en/latest/ai/xiaozhi.html)

### Inferences
- **Upload model (estimate).** Sending the whole turn after end-of-turn puts upload time plus full-turn ASR on the critical path. For example, 5 s of 16 kHz 16-bit PCM is 160 KB.
  - Instead, stream 20 ms frames as they are captured, as Opus at about 16 to 24 kbps or raw PCM on LAN.
  - The hub's streaming ASR then stays caught up, and end-of-turn becomes a small control message.
  - Keep the phone-side VAD and endpointing so silence is not shipped needlessly.
- **Transport choice.**
  - Over a direct Tailscale (WireGuard/UDP) path on home Wi-Fi, a WebSocket with small frames costs little; loss is rare, and TCP-in-UDP head-of-line blocking only matters on lossy links.
  - On cellular, or once the pendant is involved, move the audio leg to WebRTC (or plain RTP or UDP with Opus FEC) and keep a small jitter buffer of about 40 to 60 ms.
  - Measure `tailscale ping` from the phone on cellular. If it shows DERP, set up a peer relay or fix NAT, because hundreds of ms there would dwarf every model optimization.
- **Downlink.** With TTS on the phone, only text crosses the network, which is tiny and latency-tolerant; this is a structural advantage of phone-side TTS. Hub- or GPU-side TTS adds return transport plus a jitter buffer, about 50 to 100 ms.
- **Pendant.**
  - Use Wi-Fi with Opus at 20 ms frames, not xiaozhi's 60 ms default, which adds about 40 ms of framing. Target the phone (hotspot or LAN) or the hub directly.
  - Alternatively, a custom BLE GATT stream to the phone. 16 kHz Opus at about 16 to 24 kbps fits BLE throughput, but the connection interval and buffering add tens of ms. LE Audio/LC3 would need a different chip such as the ESP32-S31 or H4.
  - AEC on the pendant needs the playback reference. That is easier if playback stays on the phone and the pendant only captures; if the pendant also plays audio, it needs on-device AEC (ESP-SR).

### Gaps
- No measured comparison of WebRTC and WebSocket on mobile networks for voice agents was found; the arguments are reasoned rather than benchmarked.
- No figures were found for the latency added by Android's VOICE_COMMUNICATION or VOICE_RECOGNITION input presets and hardware AEC.
- No measured ESP32-S3 Wi-Fi or BLE-GATT voice-streaming latency was found.

---

## Q6. Placement: what should run on the phone, the hub, and an optional GPU box

### Takeaway
Keep latency-critical, privacy-sensitive and cheap stages close to the user. On the phone: capture, AEC, VAD and endpointing (plus Smart Turn), barge-in, and a small fast TTS. The hub holds the heavy shared state: streaming ASR, the LLM with cached state, tools and memory. The GPU box (or cloud) is an accelerator for hard turns and expressive TTS. Production frameworks are cloud-centric only because client devices historically lacked compute. They co-locate the models and keep AEC on the device, both of which apply here.

### Cited Findings
- "Production voice AI is very cloud-centric" because end-user devices "do not yet have enough AI compute horsepower" for the best models at acceptable latency. More on-device AI is expected over time. "Echo cancellation has to run on the device." — [primer](https://voiceaiandvoiceagents.com/)
- Co-locate the bot and model services and pin nearby regions. Modal runs the orchestrator on CPU and the models as separate GPU services. — [Modal](https://modal.com/blog/low-latency-voice-bot)
- Unmute measured lower TTS latency when STT, TTS and the LLM have separate GPUs (about 450 ms against about 750 ms shared), i.e. contention matters. — [Unmute docs mirror (third-party)](https://www.mintlify.com/kyutai-labs/unmute/guides/performance-tuning)
- LiveKit's turn detector (audio plus text) runs on top of VAD and is the default. It recommends VAD-only mode for "minimal latency, or support for a spoken language the turn detector model doesn't cover", and STT endpointing when the STT has its own turn detection (e.g. Deepgram Flux, AssemblyAI). — [LiveKit turn detection](https://docs.livekit.io/agents/build/turn-detection)
- Smart Turn v3 is designed for CPU: 12 ms on modern CPUs. — [Daily](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/)
- VibeVoice notes that network latency adds to the about 300 ms first-chunk time when TTS is remote. — [HF VibeVoice-Realtime card](https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B)

### Inferences
- **Phone:**
  - AAudio/Oboe capture; hardware AEC with TTS on `USAGE_VOICE_COMMUNICATION`, as PAN already does.
  - VAD plus sherpa endpoint candidate, and Smart Turn v3.2.
  - Barge-in.
  - A clause-chunked fast TTS.
  - An Opus encoder that streams frames to the hub.
  - Optionally, Moonshine streaming for offline fallback.
- **Hub (5800H):**
  - Streaming Nemotron ASR with 2 to 4 threads, plus batch Parakeet v3 for Greek.
  - llama-server with LFM3 or OmniΠ and prefix-state restore, using 8 to 12 threads.
  - Router, tools and memory.
  - Make sure ASR, LLM and background jobs (embeddings, vision, daemons) don't contend for cores during a turn. Pause or nice them while a turn is live; PAN has a history of head-of-line blocking from embeddings.
- **GPU box (RTX 3050, shared and not always available):**
  - LLM for full-prompt or hard turns: a bigger model, or E2B/E4B at 100+ tok/s.
  - Optional expressive TTS streamed back.
  - It is reached over the LAN, adding about 1 to 5 ms (estimate). Since the GPU is shared (game mode), route dynamically and fall back to the CPU path when it is busy.
- **Cloud:** use it only as an LLM fallback for quality (long reasoning or knowledge), keeping ASR and TTS local. Speech-to-speech APIs would move audio off-device and cost $0.20/min or more (see Q7).

### Gaps
- No 2026 LiveKit or Pipecat guidance specific to a home-server-plus-phone topology was found. The recommendations above extrapolate from their cloud guidance.

---

## Q7. Recommended stacks with per-stage latency budgets (CPU-only, with an RTX 3050 or 8 GB GPU, and cloud fallback)

### Takeaway
1. **CPU-only (phone plus 5800H):** streaming Nemotron ASR, llama-server LFM3 with restored prefix state and answer-first output, and clause-chunked phone TTS. Estimated **0.8 to 1.1 s**, down from 2 to 3 s.
2. **With an RTX 3050 / 8 GB GPU:** the LLM moves to the GPU (3,860 tok/s prefill, 116 tok/s decode for Gemma 4 E2B). Estimated **0.6 to 0.9 s**, with room for a larger model or expressive TTS.
3. **Cloud fallback:** local ASR and TTS with a cloud LLM. Estimated **1.1 to 1.6 s** median with a fat P95. Use it for answer quality, not speed.

### Cited Findings
Anchor measurements used in the budgets:
- Smart Turn makes turn decisions about 250 ms after a pause, with about 12 to 30 ms of inference. — [primer](https://voiceaiandvoiceagents.com/); [Daily](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/)
- Nemotron streaming finalization: 58 ms p50 with 6 threads, 71 ms with 4 threads, 114 ms with 2 threads (Ryzen 7500F). — [Softcery](https://softcery.com/lab/hosting-nemotron-asr-streaming-on-a-cpu)
- Gemma 4 E2B on an RTX 3050 8 GB: prefill 3,860 tok/s, decode 116 tok/s, TTFT 212.7 ms for a 512-token prompt. — [DEV](https://dev.to/gde/gemma-4-on-a-used-8-gb-rtx-3050-116-tokenss-for-one-user-618-for-64-k6h)
- Kokoro first audio is about 85 ms on an RTX 3050 6 GB (vendor page). — [GigaGPU](https://gigagpu.com/?p=1841)
- Pocket TTS first chunk is about 200 ms on 2 M4 cores (vendor) and 250 to 430 ms measured on an M2. — [HF Pocket TTS](https://huggingface.co/kyutai/pocket-tts); [micdrop](https://micdrop.dev/docs/ai-integration/provided-integrations/pocket-tts)
- Cloud LLM TTFT medians are 536 to 739 ms, with P95 at 1.1 to 1.8 s. — [primer](https://voiceaiandvoiceagents.com/)
- GPT-Realtime-2 time to first audio is about 1.12 s at minimal reasoning, per a secondary article's own analysis. Production P50 is 1.4 to 1.7 s. — [SoftwareSeni](https://www.softwareseni.com/voice-agent-latency-solved-enough-for-production-benchmarks-and-architecture-tradeoffs)
- A developer reports 5 to 6 s Gemini Live latency in a production-like setup (anecdotal). — [Google AI forum](https://discuss.ai.google.dev/t/live-api-5-6-second-response-latency/123254)
- A speech-to-speech API costs $0.20 per minute or more. — [primer](https://voiceaiandvoiceagents.com/)
- Android low-latency output adds about 10 to 20 ms one way (estimated from a 20 ms round trip). — [Android low-latency audio](https://developer.android.com/games/sdk/oboe/low-latency-audio)
- Transit over Tailscale direct is about 10 ms in the Pipecat budget; DERP adds hundreds of ms. — [primer](https://voiceaiandvoiceagents.com/); [Tailscale](https://tailscale.com/kb/1257/connection-troubleshooting/)

### Inferences
**Stack 1: CPU-only (phone plus Ryzen 7 5800H hub). Default.**

| Stage | Component | Budget (from end of speech) |
|---|---|---|
| Turn decision | Phone: VAD plus sherpa endpoint candidate at about 200 to 350 ms silence, then Smart Turn v3.2 (fp32) and flow mode | 250 to 350 ms (LLM prefill starts in parallel at the candidate) |
| Uplink | Opus or PCM 20 ms frames streamed during speech over Tailscale direct (WebSocket on LAN; WebRTC/UDP on cellular) | 10 to 40 ms (only the last frames and an end-of-turn control message) |
| ASR final | Hub: Nemotron en 0.6B int8, 1120 or 560 ms chunk, 3 to 4 threads, fed during the turn, plus one silence chunk at end of turn. Greek goes to Parakeet v3 batch instead (about 300 to 400 ms). | 70 to 150 ms (Zen 3 estimate) |
| LLM | llama-server (LFM3-compatible build), OmniΠ retrained answer-first: slot restore of the constant prefix (a few ms), prefill of a 40 to 60 token tail (about 150 to 200 ms), 1 routing token, then about 6 to 8 tokens for the first clause at 22 to 35 tok/s (about 200 to 300 ms) | 350 to 500 ms to first clause (part overlaps the turn decision if started preemptively) |
| Downlink | Text tokens over the same socket | about 10 to 20 ms |
| TTS first chunk | Phone: Supertonic (current) or successor, first clause about 1 to 1.5 s of audio | 150 to 350 ms on the laptop CPU (RTF 0.23); phone unmeasured |
| Playback | AAudio/AudioTrack low-latency path | 10 to 40 ms |
| **Total** | | **about 0.85 to 1.45 s raw; about 0.65 to 1.1 s if the ASR flush and LLM restore plus prefill run during the turn decision (preemptive start at the endpoint candidate)** |

- Biggest levers in order: prefix-state restore (saves about 1.1 s); answer-first labels (saves about 0.6 to 0.8 s); streaming ASR (saves about 0.25 to 0.3 s); clause-level TTS chunking (saves about 0.1 to 0.4 s); trimming router setup (about 0.1 s).
- The first two need no new hardware or models. They need a runtime switch (Ollama to llama-server) and a retrain to change the output order.

**Stack 2: with an RTX 3050 (shared) or a future 8 GB laptop GPU.**

| Stage | Component | Budget |
|---|---|---|
| Turn decision | Same as Stack 1 (phone) | 250 to 350 ms |
| Uplink and ASR | Same as Stack 1 (hub CPU Nemotron); optionally Qwen3-ASR via vLLM on GPU for Greek | 80 to 190 ms |
| LLM | llama.cpp CUDA on the 3050: OmniΠ or LFM3, or Gemma 4 E2B/E4B. A 370-token prompt prefills in about 0.1 s even uncached; decode runs at about 100+ tok/s | 120 to 250 ms to first clause (about 0.2 to 0.35 s even with labels first) |
| TTS | (a) Keep phone TTS: 150 to 350 ms. (b) GPU expressive TTS (Kokoro about 85 ms; Chatterbox Turbo, CosyVoice 3 or Qwen3-TTS unmeasured) plus Opus return and jitter buffer, about 50 to 80 ms | 150 to 350 ms |
| Playback | Phone | 10 to 40 ms |
| **Total** | | **about 0.6 to 0.9 s typical (preemptive start; worst case about 1.2 s); under 0.6 s only with aggressive endpointing** |

- The extra capacity is better spent on a stronger model for hard turns (E4B or another model within 8 GB, about 6.4 GB VRAM for E4B at 131K context) than on chasing the last 100 ms.
- Because the GPU is shared, route dynamically: if it is unavailable, fall back to Stack 1 with no user-visible change except latency.

**Stack 3: cloud fallback.**

| Stage | Component | Budget |
|---|---|---|
| Turn decision, uplink and ASR | Same as Stack 1 (local) | 330 to 540 ms |
| LLM | Cloud LLM with streaming; medians 536 to 739 ms TTFT, P95 1.1 to 1.8 s | 550 to 750 ms median |
| TTS and playback | Phone TTS (local) | 160 to 390 ms |
| **Total** | | **about 1.1 to 1.6 s median, P95 of 2 s or more** |

- An alternative is a speech-to-speech API (GPT-Realtime-2, Gemini Live). It ships raw audio off-device, costs $0.20/min or more, and was reported at about 1.1 s to multiple seconds with high variance, so it is not recommended as PAN's fallback.
- A pattern worth testing (inference): race local and cloud. Let local Stack 1 or 2 speak a short first clause or acknowledgment while the cloud model generates the substantive answer.

**Watch list (could change the picture within months):**
- LFM3-Audio or Omni with native audio input, whose causal encoder prefills during speech (vendor: TTFT about 50 ms after speech ends). This could collapse ASR and LLM into one step if llama.cpp audio support lands and CPU speed holds up, but the license threshold applies.
- llama.cpp turn-boundary checkpointing (PR #22929).
- A maintained successor to Supertonic with Greek.

### Gaps
- All Stack budgets are estimates assembled from measurements on other hardware, plus PAN-internal numbers. None was measured end to end on PAN's phone and hub. The two unknowns most likely to move the totals are on-phone TTS first-chunk time and Nemotron finalization on Zen 3 with DDR4.
- No controlled, methodology-documented 2026 benchmark of cloud speech-to-speech latency (GPT-Realtime-2, Gemini Live) was found.

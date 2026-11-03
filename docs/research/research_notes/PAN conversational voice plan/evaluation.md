# Evaluating natural (non-turn-based) voice conversation: benchmarks, metrics, human timing references, test harnesses, and a PAN conversation benchmark design

Compiled 2026-11-02. Conventions used throughout: **FTO** (floor-transfer offset) = onset of the next speaker's audio minus offset of the previous speaker's audio (negative = overlap). "Vendor claim" marks numbers that come from a company's own marketing or docs and that I could not verify independently. "Inference" sections are my reasoning, not sourced fact. PAN-internal facts come from the project's memory notes, which are point-in-time (Sept to Oct 2026) and may be stale.

---

## 1. Benchmarks: what each measures, exact metric definitions, data, code, cascaded testability, published scores

### Takeaway
There is now a dense 2025-2026 benchmark family for "conversational dynamics" (Full-Duplex-Bench v1 to v3, Talking Turns, TurnBench, HumDial-FDBench, FLEXI, FD-Bench, DuplexAct, EchoChain, tau-Voice), and most of them are architecture-agnostic: they stream pre-recorded or simulated user audio into the system and score the time-aligned audio that comes back, so a cascaded pipeline can be tested if you build an adapter. The most directly reusable for PAN are FDB v1/v1.5 (pause, backchannel, turn-taking, interruption, overlap), HumDial-FDBench (real recorded interruption and rejection cases, cascades competed), and TurnBench (scores an end-of-turn detector on its own, ranked by recall at a false-positive budget). Even frontier commercial systems score far from human: e.g. Gemini Live takes the floor during 25 to 31% of user pauses (FDB v1), GPT-4o Realtime responds to 91 to 93% of side talk and background speech (FDB v1.5), and no real-time model passes 50% on EchoChain's state-update-under-interruption test.

### Cited Findings

#### A. Turn-taking and overlap behaviour (the core of "feels like a person")

**Full-Duplex-Bench v1** (Lin et al., arXiv 2503.04721, ASRU 2025)
- Four dimensions and data: Pause handling (CANDOR real speech, 216 samples; synthetic ChatTTS with `[uv_break]` pauses, 137), Smooth turn-taking (CANDOR, 119), Backchannel (ICC corpus with human backchannel timings, 55), User interruption (synthetic GPT-4o dialogues voiced by ChatTTS, 200; interruption played about 7 s after the preceding utterance, followed by 15 s of silence) — [FDB v1 paper](https://arxiv.org/html/2503.04721v3)
- Metric definitions: **Takeover Rate (TOR)** = mean over N turns of a binary TO, where TO = 0 if the model is silent or only backchannels and 1 for any other speech; a **backchannel** is a segment shorter than 1 s with fewer than two words; **smooth turn-taking latency** = end of user speech to start of model response, computed only when TO = 1; **backchannel frequency** = backchannel events per second (non-takeover cases); **JSD** = Jensen-Shannon divergence between the model's backchannel timing distribution and the human ICC distribution in 200 ms windows (0 = identical, 1 = disjoint; a silent model is assigned a uniform distribution); **interruption** is scored with a GPT-4o 0-5 relevance/coherence rating plus latency after the interruption — [FDB v1 paper](https://arxiv.org/html/2503.04721v3)
- How a system is run: the user channel `input.wav` is streamed to the model, the model's `output.wav` is recorded time-aligned to the input, and NVIDIA parakeet-tdt-0.6b-v2 produces word-level timestamps used for timing. Gemini Live was fed 16 kHz PCM16 in 30 ms chunks with server-side VAD — [FDB v1 paper](https://arxiv.org/html/2503.04721v3)
- Human anchors cited by the paper: a pause of about 1 s as a natural upper bound (Jefferson 1989), smooth transitions within roughly 200-250 ms (Heldner & Edlund 2010); 0.4 s used as a conservative gap threshold when filtering CANDOR — [FDB v1 paper](https://arxiv.org/html/2503.04721v3)
- Results (arrows show the better direction):

| Model | Pause TOR synth ↓ | Pause TOR CANDOR ↓ | BC TOR ↓ | BC freq ↑ | BC JSD ↓ | Turn TOR ↑ | Turn latency s ↓ | Interrupt TOR ↑ | GPT-4o score ↑ | Interrupt latency s ↓ |
|---|---|---|---|---|---|---|---|---|---|---|
| dGSLM | 0.934 | 0.935 | 0.691 | 0.015 | 0.934 | 0.975 | 0.352 | 0.917 | 0.201 | 2.531 |
| Moshi | 0.985 | 0.980 | 1.000 | 0.001 | 0.957 | 0.941 | 0.265 | 1.000 | 0.765 | 0.257 |
| Freeze-Omni | 0.642 | 0.481 | 0.636 | 0.001 | 0.997 | 0.336 | 0.953 | 0.867 | 3.615 | 1.409 |
| Gemini Live | 0.255 | 0.310 | 0.091 | 0.012 | 0.896 | 0.655 | 1.301 | 0.891 | 3.376 | 1.183 |

Source: [FDB v1 Table III](https://arxiv.org/html/2503.04721v3). No cascaded baseline in v1.

**Full-Duplex-Bench v1.5** (arXiv 2507.23159) — overlap handling
- Four overlap scenarios: User interruption (200), User backchannel (99 Switchboard-style "yeah/right/mm-hmm"), Talking to others (100; far-field simulation: −8 dB, high-shelf cut above 4 kHz −5 dB, reflections at 45 ms −6 dB and 120 ms −12 dB), Background speech (100 different-speaker utterances: −15 dB, 3 kHz low-pass, 100 ms echo −10 dB, dynamic range compression) — [FDB v1.5](https://arxiv.org/html/2507.23159)
- Metrics: GPT-4o classifies the post-overlap behaviour from Parakeet transcripts as **Respond** (addresses the overlap), **Resume** (continues the prior utterance), **Uncertain** (asks for repeat), **Unknown** (irrelevant or silent); **stop latency** = t_model_stop − t_user_start; **response latency** = t_model_start − t_user_end; speech activity from Silero-VAD; prosody shifts (WPM, pitch, intensity, UTMOSv2) pre vs post overlap. Ideal: interruption → Respond with low latencies; backchannel, talking-to-others, background → Resume — [FDB v1.5](https://arxiv.org/html/2507.23159)
- Selected results (Respond / Resume / Stop s / Response s):
  - User interruption: GPT-4o Realtime 0.78 / 0.10 / 0.23 / 1.50; Freeze-Omni 0.72 / 0.12 / 1.42 / 1.35; Moshi 0.50 / 0.26 / 1.16 / 1.47; Gemini (2.0 flash live) 0.33 / 0.55 / 2.20 / 2.62; Nova Sonic 0.24 / 0.71 / 2.25 / 2.75 — [FDB v1.5](https://arxiv.org/html/2507.23159)
  - User backchannel (Resume is correct): Nova Sonic 0.98, Gemini 0.93, Freeze-Omni 0.80, GPT-4o Realtime 0.70, Moshi 0.06 (Unknown 0.92) — [FDB v1.5](https://arxiv.org/html/2507.23159)
  - Talking to others (Resume correct): Gemini 0.99, Nova Sonic 0.90, Freeze-Omni 0.25, GPT-4o Realtime 0.02 (it Responds 0.91) — [FDB v1.5](https://arxiv.org/html/2507.23159)
  - Background speech (Resume correct): Nova Sonic 0.98, Gemini 0.30, Freeze-Omni 0.25, GPT-4o Realtime 0.04 (Responds 0.93) — [FDB v1.5](https://arxiv.org/html/2507.23159)
- Findings: two strategies emerge, "responsive" (GPT-4o: fast to yield, stop 0.18-0.23 s, but responds to non-addressed speech) and "floor-holding" (Gemini, Nova Sonic: filter non-addressed speech, but slow to yield, stop 2.2 s); the authors note effective repair typically needs response latency of about 1.5 s or less — [FDB v1.5](https://arxiv.org/html/2507.23159)
- The benchmark streams pre-recorded user audio in real time and "makes no assumptions about internal architecture"; Freeze-Omni (described as cascaded with a frozen LLM) was tested via its demo server — [FDB v1.5](https://arxiv.org/html/2507.23159)
- Repo: v1/v1.5/v2/v3 share one repo; v1.5 eval code 2025-08-14, data 2025-08-15, **server-client inference mode 2025-08-22**; v2 framework 2026-02-23; v3 code and data 2026-05-20; Gemini 3.1 Flash Live Preview later added to v1/v1.5 runs — [Full-Duplex-Bench GitHub](https://github.com/DanielLin94144/Full-Duplex-Bench)

**Talking Turns** (Arora et al., CMU + Apple, ICLR 2025, arXiv 2503.01174)
- A supervised judge predicts a turn-taking label (NA, backchannel, interruption, turn change, continuation) every 40 ms from a 30 s window using Whisper encoder features, trained on Switchboard (2000/300/138 conversations); ROC-AUC 92.0 (Switchboard), 91.5 (Columbia Games), 91.0 (Fisher) — [Talking Turns](https://arxiv.org/html/2503.01174v1)
- Five timing metrics scored by the judge: (a) system speaks up when the user yields, (b) system backchannels at the right moments, (c) system interrupts at plausible moments, (d) system signals when the user may speak, (e) system yields when the user interrupts. Judge agreement with humans is mostly above 60% but below 80% for many metrics; (e) is lowest — [Talking Turns](https://arxiv.org/html/2503.01174v1)
- User study: 11 participants (mostly authors and colleagues), about 4 h per system (4 h 05 min Moshi, 3 h 35 min VAD-based cascade) — [Talking Turns](https://arxiv.org/html/2503.01174v1)
- Global statistics: Moshi gap = 11.8% of cumulative duration; cascade gap = 32.4% with minimal overlap. After a user pause the cascade takes the turn 37.1% of the time vs humans 15.9% (in-domain) / 32.9% (out-of-domain). Backchannels: humans 0.30% / 0.09% vs both systems 0.01%. After a user interruption, Moshi yields only 17.4% of the time vs humans 63.6% / 60.8% and the cascade 59.4%. Moshi has 2.09% false-positive interruptions — [Talking Turns](https://arxiv.org/html/2503.01174v1)
- Code: promised but no public scorer found by the community benchmark list — [Awesome-Full-Duplex-Benchmark](https://github.com/cageyoko/Awesome-Full-Duplex-Benchmark)

**TurnBench** (Sesame with CMU and others, Aug 2026, arXiv 2608.25218)
- Data: about 30 h of dual-channel studio English, 154 dialogues, 106 voice actors in 53 pairs, six conversation types; triple-annotated (Fleiss κ = 0.78) with a 17-category taxonomy; a separate 104 h hand-labelled training set; public dev set plus held-out test set; data licence non-commercial and prohibits voice cloning — [Sesame TurnBench blog](https://www.sesame.com/blog/turnbench)
- Metrics: **EOT track** TP = a real end-of-turn transition, FP = firing in a mid-turn pause; **INT track** TP = a legitimate barge-in, FP = backchannel, noise or **channel bleed (echo)**; match window 0.25 s before to 3 s after the labelled event; report recall, FPR and signed latency (p10/p50/p90; negative = fired early); systems ranked by recall under an FPR budget of 0.15; scored on committed decisions at one operating point frozen on dev — [Sesame TurnBench blog](https://www.sesame.com/blog/turnbench)
- Test-set results (recall / FPR / median Δt ms): RMS energy VAD EOT 0.718/0.632/−117, INT 0.996/0.445/123; OpenAI Realtime server VAD EOT 0.955/0.525/282, INT 0.990/0.458/184; OpenAI semantic VAD EOT 0.303/0.018/793, INT 0.484/0.271/196; Kyutai semantic VAD EOT 0.773/0.059/1007, INT 0.898/0.081/559; **Smart Turn v3 EOT 0.752/0.047/1017**, INT 0.107/0.093/159; **Voice Activity Projection EOT 0.845/0.055/368, INT 0.945/0.107/994**; Mimi endpointer EOT 0.782/0.078/645; ESPnet turn-taking EOT 0.826/0.078/862; Gemini 3.1 Live EOT 0.657/0.022/1234; Moshi EOT 0.233/0.044/702 — [Sesame TurnBench blog](https://www.sesame.com/blog/turnbench)
- Findings: speed vs precision trade-off; acoustic systems that fire on the first frame of listener speech are fast but cannot tell backchannels from interruptions; false interruptions peak in backchannel-heavy casual talk; "no system was fast, selective, and high-recall at once" — [Sesame TurnBench blog](https://www.sesame.com/blog/turnbench)
- Self-serve dev scoring and leaderboard at turnbench.sesame.com — [TurnBench site](https://turnbench.sesame.com/)

**ICASSP 2026 HumDial Challenge, Track II (Full-Duplex Interaction) / HumDial-FDBench**
- Two tracks: Track I Emotional Intelligence, Track II Full-Duplex Interaction ("listening-while-speaking" decisions) — [HumDial overview](https://arxiv.org/abs/2601.05564); over 100 registered teams, 15 valid submissions (search-snippet level) — [HumDial overview PDF](https://arxiv.org/pdf/2601.05564)
- Data: more than 100 h of Chinese and English dual-channel conversations performed by professional actors from LLM-generated scripts; interruption sub-scenarios (follow-up question, negation/dissatisfaction, repetition request, topic switch, silence/stop) and rejection sub-scenarios (user backchannel, pause handling, third-party speech, speech directed at others) — [HumDial full-duplex study](https://arxiv.org/html/2604.21406v1)
- Metrics: interruption counted correct only if classified Respond; rejection correct only if Resume (for pauses/third-party: responding before the user's content is complete fails, judged from word timestamps); first response latency = end of user question to model's first response; Delay = mean of three latencies mapped to 0-100 with a log formula; **Final = 0.4 × Interruption + 0.4 × Rejection + 0.2 × Delay score**; Silero-VAD boundaries, Paraformer (zh) / Parakeet-TDT (en) transcripts, DeepSeek-V3 behaviour classifier — [HumDial study](https://arxiv.org/html/2604.21406v1)
- Results (Int / Rej / Delay s / Final): **Cookie asr (cascaded) 79.3 / 72.2 / 1.260 / 76.6, rank 1**; Badcat (semi-cascaded, Qwen3-Omni decides turns) 89.7 / 57.8 / 1.632 / 73.5; SenseDialog 76.4 / 60.9 / 1.237 / 71.0; Gemini-2.5 79.8 / 36.5 / 1.301 / 62.3; Freeze-Omni 29.6 / 50.2 / 2.578 / 43.8; Moshi 35.4 / 22.8 / 2.876 / 34.5; a plain "Cascade" entry 28.1 / 30.9 / 1.739 / 37.7 — [HumDial study](https://arxiv.org/html/2604.21406v1)
- Data on Hugging Face (ASLP-lab/HumDial-FDBench), extends FDB v1.5, public leaderboard in repo — [HumDial-FDBench GitHub](https://github.com/ASLP-lab/HumDial-FDBench)

**FLEXI** (arXiv 2509.22243, Sep 2025)
- Six scenarios: standard turn-taking, pause handling, user interrupt, model interrupt (emergency), user backchannel, model backchannel; data = Qwen-plus text, CosyVoice2 speech, manually validated; code and data released (github.com/ChristineCHEN274/FLEXI) — [FLEXI](https://arxiv.org/html/2509.22243v1)
- Metrics: TOR, latency, **JIR (jump-in rate: model takes the turn before the user finishes)**, TTR (turn-termination rate on user interrupt; on backchannels lower is better), interrupt latency, TSS (topic-shift score 0-5), EDS (emergency detection 0-5), coherence (resumes within 1 s after a backchannel), BCR, JSD — [FLEXI](https://arxiv.org/html/2509.22243v1)
- Results: turn-taking latency Moshi 0.696, Freeze-Omni 1.147, VITA-1.5 4.878, Gemini (2.5 flash live) 1.736; JIR Moshi 0.785, Freeze-Omni 0.120, VITA 0, Gemini 0; user-interrupt TTR Gemini 0.935 (latency 1.766), Freeze-Omni 0.539, Moshi 0.462, VITA 0.226 — [FLEXI](https://arxiv.org/html/2509.22243v1)
- Interaction "levels": Level 1 face-to-face immediacy, typically latency below 150 ms; Level 2 telephone-like, below 400 ms; Level 3 high-latency or mechanical — [FLEXI](https://arxiv.org/html/2509.22243v1)

**FD-Bench** (Peng et al., Interspeech 2025, arXiv 2507.19040)
- LLM + TTS + ASR generated pipeline: over 40 h of generated speech, 293 simulated conversations, 1,200 interruptions, including noisy conditions; evaluated Moshi, Freeze-Omni, VITA-1.5, all of which struggle with frequent interruptions and noise — [FD-Bench abstract](https://arxiv.org/abs/2507.19040)
- Its user script is fixed and pre-synthesized, so later user turns do not adapt to the assistant's actual replies — [DuplexAct/related summary via search](https://arxiv.org/html/2610.17738); code listed at github.com/pengyizhou/FD-Bench — [Awesome list](https://github.com/cageyoko/Awesome-Full-Duplex-Benchmark)
- The 2026 survey stresses that "FD-Bench" (Peng) and "Full-Duplex-Bench" (Lin) are independent series whose numbers are not comparable — [Full-duplex survey 2606.19453](https://arxiv.org/abs/2606.19453)

**DuplexAct** (arXiv 2610.17738, 13 Oct 2026, newest)
- Eight interaction actions (Wait, Ignore, Take Turn, Backchannel, Stop, Hold Floor, Recover, Interrupt) across 24 conditions; 4,691 instances (2,531 real recordings, 2,160 synthesized), 12.44 h, four scenarios (casual, meetings, customer service, interviews); two-stage success: immediate execution (rule-based, e.g. taking the turn inside the expected window) and follow-through (GPT-5.4 checklist) — [DuplexAct](https://arxiv.org/html/2610.17738)
- Simulator: an LLM (GPT-5.4), queried every 1 s, decides **when** to inject a pre-recorded user cue based on the model's streaming transcript; cue content is fixed, only timing adapts — [DuplexAct](https://arxiv.org/html/2610.17738)
- Results (immediate % / follow-through %): GPT-Realtime-2.1 Wait 99.8/95.7, Take Turn 27.5/83.0, Stop 100/100, Recover 77.7/90.3, Backchannel 0.2; Gemini 3.1 Flash Live Take Turn 38.3/82.2, Recover 97.0/78.6; Moshi Take Turn 36.2/19.4, Backchannel 6.2; best open-source backchannel Raon-SpeechChat 31.0%; no cascaded systems tested; code github.com/JiahengDong/DuplexAct — [DuplexAct](https://arxiv.org/html/2610.17738)

**French full-duplex benchmark** (Soltani & Boulianne, arXiv 2609.10765, 9 Sep 2026)
- CALLFC-FDB (Canadian French) and MEDIA-FDB (European French) built from real speech, testing pause handling, turn-taking, backchannels, interruptions; human-human conversations are run through the same metrics; timing metrics behave similarly across languages while content-based scoring degrades under language mismatch; reports a **trade-off between optimizing benchmark metrics and preserving conversational naturalness** (no numbers on the abstract page) — [French FDB](https://arxiv.org/abs/2609.10765)

**Other turn-taking resources (not reviewed in depth)**
- Easy-Turn test set (arXiv 2509.23938): complete / incomplete / backchannel / wait classification, 800 clips, github.com/ASLP-lab/Easy-Turn; SID-Bench (arXiv 2603.24144): semantic interrupts EN/ZH and silence/noise false triggers; Game-Time (arXiv 2509.26388): tempo, deadlines, intentional overlap; TURNS-2K (text end-of-utterance) — [Awesome-Full-Duplex-Benchmark](https://github.com/cageyoko/Awesome-Full-Duplex-Benchmark)
- CoDeTT (context-aware turn-taking, Interspeech 2026 submission) surfaced only in search snippets — [search result listing via Talking Turns query](https://www.alphaxiv.org/abs/2608.25218)
- Newer titles in the same space (titles only seen): MP-Bench, voice agents as multiparty participants (arXiv 2609.13076) — [MP-Bench](https://arxiv.org/pdf/2609.13076); MSI-Bench, multi-speaker voice interaction (arXiv 2609.24812) — [MSI-Bench](https://arxiv.org/pdf/2609.24812); "When Patients Cut In", clinical interruptions (arXiv 2608.29241) — [paper](https://arxiv.org/pdf/2608.29241); SoulX-Duplug, a plug-and-play streaming state-prediction module for full-duplex (arXiv 2603.14877) — [paper](https://arxiv.org/pdf/2603.14877)

#### B. Multi-turn state, memory and instruction persistence

**Full-Duplex-Bench v2** (arXiv 2510.07838, ACL 2026 short)
- An automated **Examiner** (GPT-Realtime) talks live to the **Examinee** over two persistent WebRTC peer connections; each model sits behind an adapter that converts to canonical 48 kHz, 16-bit mono PCM in 10 ms frames; **Fast** pacing (server VAD with `interrupt_response: true`, so the examiner barges in and backchannels) vs **Slow** pacing (replies only after end of turn) — [FDB v2](https://arxiv.org/html/2510.07838)
- Task families: Daily, Correction, Entity Tracking, Safety (11 classes); metrics scored by a Gemini 2.5 Flash judge on transcripts: Turn-Taking Fluency (TT, 1-5 per event), multi-turn Instruction Following (IF, 1-5 per event), and one task score per dialogue; judge-human Pearson r = 0.59-0.69, lowest for turn-taking — [FDB v2](https://arxiv.org/html/2510.07838)
- Results (Fast pacing, Correction / Entity / Safety): GPT-Realtime 4.02 / 4.51 / 4.44; Moshi 2.88 / 2.76 / 3.67; Freeze-Omni 2.74 / 2.62 / 3.94. All systems degrade over multi-turn sessions; entity tracking and correction are hardest; slow pacing helps open models (Moshi entity +1.1) — [FDB v2](https://arxiv.org/html/2510.07838)
- Model-agnostic: "can accommodate any future model, whether open-source or commercial, as a drop-in replacement" via an adapter; cascades not explicitly tested — [FDB v2](https://arxiv.org/html/2510.07838)

**EchoChain** (arXiv 2604.16456, Apr 2026; Labelbox)
- 200 interrupted conversations (support calls, coaching, planning, household topics); first exchange uninterrupted; afterwards the scheduler detects assistant speech onset and injects a **pre-synthesized barge-in after a fixed configured delay**, so injection is standardized relative to assistant onset — [EchoChain](https://arxiv.org/html/2604.16456)
- Metrics: Mean Pass Rate (all rubric criteria met), Mean Criterion Passed; failure taxonomy: **contextual inertia** (acknowledges the interruption but content does not change), **interruption amnesia** (drops an earlier constraint after the interruption), **objective displacement** (answers only the interruption, abandons the original request) — [EchoChain](https://arxiv.org/html/2604.16456)
- Results (MPR % / MCP %): Grok Voice Agent 48.5 / 85.5; GPT-realtime-2025-08-28 45.0 / 81.1; Amazon Nova Sonic 2 26.5 / 78.1; Gemini Live 2.5 flash native audio 16.5 / 64.8. Half-duplex control on 48 conversations: 55 failures vs 92 under interruption (−40.2%) — [EchoChain](https://arxiv.org/html/2604.16456); leaderboard last updated 2026-03-10 — [Labelbox leaderboard](https://labelbox.com/leaderboards/echochain/)
- Pluggable responder, but only four closed full-duplex models tested; no cascades; code release not stated — [EchoChain](https://arxiv.org/html/2604.16456)

**MTR-DuplexBench** (arXiv 2511.10262, Findings of ACL 2026)
- Segments continuous full-duplex dialogue into discrete rounds for turn-by-turn scoring across conversational features, dialogue quality, instruction following and safety, with natural and synthetic dialogues; finds current FD-SLMs cannot stay consistent across rounds; abstract page lists code at github.com/ZhangHe0918/MTR-DuplexBench (CC BY 4.0) — [MTR-DuplexBench](https://arxiv.org/abs/2511.10262); the community list marks it "No public data" — [Awesome list](https://github.com/cageyoko/Awesome-Full-Duplex-Benchmark) (conflict, unresolved)

**Audio MultiChallenge** (Scale AI, arXiv 2512.14865, ACL 2026)
- 452 multi-turn human-system conversations across Instruction Retention (120), Inference Memory (132), Self-Coherence (83), Voice Editing (117); top score gemini-3-pro-preview (Thinking) 54.65 ± 4.57, gemini-2.5-pro 46.90; models are consistently stronger when outputting text than audio; conversations with more than 8 min of user audio drop to roughly 13% — [Scale leaderboard](https://scale.com/leaderboard/audiomc); [paper](https://arxiv.org/pdf/2512.14865)

**Self-Listening / AnchorSpeech** (arXiv 2609.05592, Sep 2026)
- Names "anchor interruption": because text generation, synthesis and playback are asynchronous, the model's record of what it said diverges from what the user actually heard when interrupted; proposes feeding the realized played audio back as an input stream; AnchorSpeech-test checks consistency with the last item actually spoken before the interruption — [Self-Listening](https://arxiv.org/abs/2609.05592)

#### C. Agentic tasks under full-duplex and disfluency

**Full-Duplex-Bench v3** (arXiv 2604.04847, Apr 2026; code and data 2026-05-20)
- 100 recordings from 12 real speakers (no TTS), mostly built-in laptop/phone mics, five disfluency types (fillers, pauses, hesitations, false starts, self-corrections), four tool-use domains — [FDB v3](https://arxiv.org/html/2604.04847v1)
- Metrics: Tool Selection F1, Argument Accuracy, Pass@1, Response Quality (GPT-4o judge), **Turn-take rate**, **Interrupt rate = share of turns where agent start − user end < 0**, latency to first word / first tool call / task completion, filler rate — [FDB v3](https://arxiv.org/html/2604.04847v1)
- Results (Pass@1 / Turn-take / Task latency s / Interrupt): GPT-Realtime 0.600 / 96.0% / 6.89 / 13.5%; Gemini Live 2.5 0.490 / 92.0% / 7.26 / 14.1%; Gemini Live 3.1 0.540 / 78.0% / 4.25 / 19.2%; Grok 0.430 / 94.0% / 6.65 / 25.5%; Ultravox v0.7 0.410 / 96.0% / 8.40 / 47.9%; **Cascade (Whisper → GPT-4o → OpenAI TTS) 0.450 / 100% / 10.12 / 33.0%** — [FDB v3](https://arxiv.org/html/2604.04847v1)
- Pauses are the weakest disfluency category for most systems; self-corrections are hardest (GPT-Realtime 0.588, cascade 0.176) because models commit provisional values before the correction arrives — [FDB v3](https://arxiv.org/html/2604.04847v1)

**tau-Voice** (Sierra/Princeton, arXiv 2603.13686, ICML 2026)
- Extends tau²-bench to full-duplex voice: 278 customer-service tasks (retail, airline, telecom) verified against a database; best voice agents complete 31-51% (clean) and 26-38% (realistic audio) vs 85% for text GPT-5 — [tau-Voice](https://arxiv.org/html/2603.13686v1)
- Turn-taking metrics: Response Rate R_R (user turns that get a response), Yield Rate R_Y (agent yields within 2 s of a user interruption), Response Latency L_R, Yield Latency L_Y, Agent Interruption Rate I_A (agent speaks before the user finishes), Selectivity (correctly ignoring backchannels S_BC, vocal tics S_VT, non-directed speech S_ND; error windows 1.0 s for wrong yields, 2.0 s for wrong responses) — [tau-Voice](https://arxiv.org/html/2603.13686v1)
- Realistic-condition aggregates (Latency / Responsiveness / Interrupt / Selectivity): Gemini Live 1.14 s / 69% / 21% / 54%; gpt-realtime-1.5 0.90 s / 100% / 14% / 6%; grok-voice-agent 1.15 s / 83% / 84% / 57%; cascaded agents not evaluated (future work) — [tau-Voice](https://arxiv.org/html/2603.13686v1)

#### D. Leaderboards

**Artificial Analysis Speech-to-Speech leaderboard** (2026)
- Index = equal weight of Big Bench Audio reasoning (1,000 audio questions, four categories of 250), tau-Voice, Speech Agent Arena human pairwise Elo, and Task Success Rate; **Conversational Dynamics** is reported separately as a weighted average of Full-Duplex-Bench v1 and v1.5; latency = Time to First Audio (TTFA) measured on Big Bench Audio — [Artificial Analysis S2S](https://artificialanalysis.ai/speech-to-speech)
- Current leaders (Index / Conv. dynamics / TTFA s): Phonic 1 (High) 87.1 / n/a / 0.61; Grok Voice 3.0 86.9 / 97.0% / 0.81; GPT-Live-1 Astra 83.2 / 94.9% / 1.34; Gemini 3.8 Live Extended Thinking 82.6 / 91.9% / 1.35; GPT-Realtime-2.1 High 75.2 / 95.7% / 1.21; Gemini 3.8 Live 74.5 / 96.1% / 1.18. Best conversational dynamics: StepAudio 3 Realtime 98.9% (but TTFA 8.83 s), Qwen Audio 3.0 Realtime Plus 98.4%. Cascaded default stacks (Deepgram, ElevenLabs Agents, Cartesia Line, Inworld Realtime) are listed "as of July 2026" but their scores were not captured — [Artificial Analysis S2S](https://artificialanalysis.ai/speech-to-speech)

#### E. Half-duplex content / paralinguistic benchmarks (low relevance to timing)
- VoiceBench (Oct 2024): multi-faceted evaluation of LLM voice assistants under speaker, environment and content variation, real and synthetic spoken instructions; github.com/MatthewCYM/VoiceBench — [VoiceBench](https://arxiv.org/abs/2410.17196)
- SD-Eval (NeurIPS 2024): 7,303 utterances / 8.76 h on emotion, accent, age, background sound; speech-to-text, single-turn only — [SD-Eval](https://arxiv.org/abs/2406.13340)
- C3 (EMNLP 2025): 1,079 EN/ZH instances on phonological/semantic ambiguity, omission, coreference, multi-turn context, LLM-based scoring aligned with humans — [C3](https://arxiv.org/abs/2507.22968)
- MTalk-Bench: multi-turn speech-to-speech on semantic, paralinguistic and ambient-sound dimensions, arena-style pairwise plus rubric scoring; LLM judges align with humans when gaps are clear but show position and length biases — [MTalk-Bench](https://arxiv.org/abs/2508.18240)
- URO-Bench (turn-based oral tasks, EN/ZH, arXiv 2502.17810), VocalBench (half-duplex quality, arXiv 2505.15727), Big Bench Audio (reasoning), WildSpeech-Bench, VoiceAgentBench, TELEVAL, VoiceAssistant-Eval — classified as "adjacent" (not full-duplex) — [Awesome list](https://github.com/cageyoko/Awesome-Full-Duplex-Benchmark)

#### F. Survey-level observations (June 2026)
- Conventional metrics fail by construction (WER tests ASR, MOS tests TTS, end-of-turn latency presupposes a turn boundary); almost all benchmark audio is static and pre-recorded; public test audio is dominated by English telephone/Zoom acoustics with mobile-mic conditions not standardized; no benchmark tests truly concurrent speech as a primary metric; FDB v1.5 stop latency recommended as the empirical anchor; recommends reporting per-cell behaviour rather than a single aggregate score — [Full-duplex survey](https://arxiv.org/abs/2606.19453)

### Inferences
- For a cascaded system like PAN, the benchmarks split into three usable groups: (1) **component tests** you can run offline on audio files without the full loop: TurnBench EOT track (score PAN's end-of-turn logic on the user channel), Easy-Turn (4-class turn state); (2) **loop tests that need a streaming adapter** (audio in, time-aligned audio out): FDB v1 and v1.5 (server-client mode exists), HumDial-FDBench; (3) **loop tests that need cloud examiners**: FDB v2 (GPT-Realtime examiner), tau-Voice (GPT-4.1 + ElevenLabs), DuplexAct (GPT-5.4 simulator). Group 3 conflicts with PAN's local/no-per-minute-cost goal, so use them at most occasionally as external calibration.
- Commercial numbers give realistic yardsticks: turn latency about 0.9-1.35 s (tau-Voice, AA TTFA, FDB v1, HumDial), interruption stop latency 0.2 s (GPT-4o) to 2.2 s (Gemini), false cut-off ("agent interruption") rates 13-21% on disfluent or realistic audio, and a 33% cut-off rate for a plain Whisper→GPT-4o→TTS cascade (FDB v3). A cascade that handled turn-taking well (HumDial's cookie_asr) beat Gemini-2.5 and all end-to-end open models, so cascaded is not disqualifying; the turn-decision module is what matters.
- None of the benchmarks exercise a real device's acoustic path (speaker-to-mic echo, AEC, AGC, phone placement). TurnBench is the only one that even names echo ("channel bleed") as a false-positive class. PAN's echo complaint therefore needs its own on-device test.
- The "floor-holding vs responsive" split (FDB v1.5) and the French benchmark's metric-vs-naturalness trade-off both imply that PAN should not optimize one number: a gated scorecard across opposing metrics (cut-off rate vs latency; false yield vs stop latency) is needed.

### Gaps
- Talking Turns' judge/evaluation platform does not appear to be public; FD-Bench's named metrics and per-model numbers were not retrievable from the abstract page.
- MTR-DuplexBench metric definitions and model scores were not retrieved; its data-release status conflicts between sources.
- EchoChain's exact injection delay and code-release status were not found.
- HumDial overview (2601.05564) team counts came from a search snippet; Track I details were not reviewed.
- The Gemini number 1.301 s appears both as Gemini Live smooth-turn latency in FDB v1 and as Gemini-2.5 Delay in the HumDial study; it may be a coincidence or a copy, not verified.
- Artificial Analysis cascaded-stack scores and the leaderboard's exact update date were not captured; its TTFA start event is not specified on the page.
- MP-Bench, MSI-Bench, CoDeTT, SID-Bench, Game-Time, URO-Bench, VocalBench and Big Bench Audio were not read beyond titles/one-liners.

---

## 2. Human reference numbers: turn-transition gaps, overlap, backchannels, interruptions, and perceived latency

### Takeaway
Human floor transfers cluster tightly around zero: the cross-language median response offset is about +100 ms (mean +208 ms; Stivers 2009), CANDOR's median is +80 ms, and in three corpora 70-82% of speaker changes happen within 500 ms and 82-95% within 1 s (Heldner & Edlund 2010). Overlaps are common (about 40-48% of transitions, depending on definitions), backchannels arrive about 4 per minute, and within-turn pauses are typically longer than between-turn gaps, which is exactly why silence timers cut people off. For perceived latency, the solid evidence is conversation-analytic (gaps of 700 ms or more carry "dispreferred/trouble" meaning; longer gaps associate with lower enjoyment), while specific "users tolerate X ms" numbers for voice assistants are mostly vendor claims.

### Cited Findings

**Gap/overlap distributions**
- Stivers et al. 2009 (PNAS; 10 languages, polar questions, 350 questions coded per language): overall mode 0 ms; per-language modes 0 to +200 ms; medians 0 ms (English, Japanese, Tzeltal, Yélî-Dnye) to +300 ms (Danish, ǂĀkhoe Hai||om, Lao); cross-language median +100 ms; overall mean +208 ms, Japanese fastest (+7 ms), Danish slowest (+469 ms); language means within about 250 ms of the cross-language mean — [Stivers 2009, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC2705608/)
- Stivers 2009: answers are faster than non-answers (+131.78 ms for non-answers), confirmations faster than disconfirmations (adjusted −206.87 ms; 100-500 ms faster on average), visible responses faster, information requests slower (+129.38 ms) — [Stivers 2009, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC2705608/)
- Heldner & Edlund 2010 (Spoken Dutch Corpus, HCRC Map Task, Swedish Map Task): gaps 57.6-59.6% of between-speaker intervals, overlaps 40.0-41.7%, exact no-gap-no-overlap only 0.4-0.7%; distribution mode is a gap of about 200 ms; median between-speaker interval 110-130 ms — [Heldner & Edlund 2010 PDF](https://staff.fnwi.uva.nl/r.fernandezrovira/teaching/cosp/cosp2016/docs/HeldnerEdlund2010.pdf)
- Heldner & Edlund 2010: 55-59% of between-speaker intervals are overlaps or gaps below the ~200 ms detection threshold; 41-45% are gaps above 200 ms (long enough to be reactive); **70-82% of intervals are shorter than 500 ms and 82-95% shorter than 1000 ms** — [Heldner & Edlund 2010 PDF](https://staff.fnwi.uva.nl/r.fernandezrovira/teaching/cosp/cosp2016/docs/HeldnerEdlund2010.pdf)
- Heldner & Edlund 2010, crucial for endpointing: **within-speaker pauses are longer than between-speaker gaps** (Map Task medians: gaps 470-520 ms vs pauses 580-640 ms); a 500 ms silence threshold "captures" 47.5-51.1% of gaps but also 56.0-59.6% of pauses, and a 1000 ms threshold 25.1-29.1% of gaps and 27.7-31.0% of pauses, so silence duration alone cannot separate "thinking" from "done" — [Heldner & Edlund 2010 PDF](https://staff.fnwi.uva.nl/r.fernandezrovira/teaching/cosp/cosp2016/docs/HeldnerEdlund2010.pdf)
- Earlier literature on overlap share varies widely by definition: under 5% (Levinson 1983), about 8% (Norwine & Murphy 1938), 44% face-to-face and 52% telephone (ten Bosch et al. 2005), 54.1% four-party (Sellen 1995), as summarized by — [Heldner & Edlund 2010 PDF](https://staff.fnwi.uva.nl/r.fernandezrovira/teaching/cosp/cosp2016/docs/HeldnerEdlund2010.pdf)
- CANDOR (Reece et al. 2023, Science Advances; 1,656 video-call conversations, 850+ h, nearly half a million transitions): median between-speaker interval +80 ms; gaps 52.1% of transitions (median 380 ms), overlaps 47.9% (median −410 ms) — [CANDOR, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC10065445/)
- CANDOR: longer gaps (not overlaps) are associated with lower partner enjoyment (gap-only b = −1.00, 95% CI [−1.41, −0.59]; overlap-only b = −0.26, n.s.); associational, not causal — [CANDOR, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC10065445/)

**Backchannels and interruptions**
- CANDOR: 33.7% of speaker turns elicit at least one listener backchannel, 65.5% of turns of five or more words; about 1,000 backchannel words per hour; "yeah" is nearly 40% of backchannels — [CANDOR, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC10065445/)
- TurnBench corpus statistics (studio dyads): 19.0 turn events/min, mean turn 9.2 s, **4.32 backchannels/min, 2.04 interruptions/min** overall (casual talk 5.20 BC/min and 2.05 INT/min; argumentative 3.09 BC/min and 2.48 INT/min) — [Sesame TurnBench blog](https://www.sesame.com/blog/turnbench)
- Talking Turns human reference (Switchboard in-domain / out-of-domain): a listener takes the turn after 15.9% / 32.9% of speaker pauses; when a listener interrupts, the floor actually changes 63.6% / 60.8% of the time — [Talking Turns](https://arxiv.org/html/2503.01174v1)
- Overlap resolution: Schegloff (2000) describes an overlap-resolution device measured in "beats" of roughly one spontaneous syllable (glossed as up to about 180 ms) — secondary source — [Gervits & Scheutz 2018](https://hrilab.tufts.edu/publications/gervits2018lrec.pdf)
- Spoken DialogSum models interruptions starting N(0.45 s, 0.05 s) before the previous speaker ends and backchannels N(0.2 s, 0.02 s) after, attributing these to CANDOR (second-hand; not verified in CANDOR itself) — [search summary of arXiv 2512.14687](https://arxiv.org/pdf/2512.14687)

**When delay starts to carry meaning, and user-study evidence**
- Kendrick & Torreira 2015 (Discourse Processes; 195 responses from telephone corpora): only for transitions of 700 ms or more was the proportion of dispreferred responses clearly greater than preferred ones; small departures from a normal gap lower the likelihood of a preferred action — [Kendrick & Torreira, White Rose eprint](https://eprints.whiterose.ac.uk/id/eprint/116177/)
- Roberts & Francis 2013 (JASA 133, EL471-477) identified "a temporal threshold of tolerance for silent gaps after requests"; the threshold value was not retrieved — [Roberts CV](https://www.cla.purdue.edu/directory/cv/felicia-roberts.pdf)
- Maslych et al. (CUI '25, LLM-powered virtual agents in VR): delay significantly worsened perceived response time and wider perception metrics and was less bearable beyond 4 s; natural conversational fillers mitigated some effects, artificial wait indicators did not — [Maslych et al. arXiv 2507.22352](https://arxiv.org/html/2507.22352v1); [CUI '25 PDF](https://www.eecs.ucf.edu/isuelab/publications/pubs/maslychmCUI25.pdf)
- Automotive conversational agents (AutomotiveUI 2020): unnaturally long positive delays lead users to assume an error occurred, while negative delays (answering too early) are perceived as rude (abstract-level via search; full text blocked) — [ACM DL](https://dl.acm.org/doi/10.1145/3409120.3410651)
- Social robot study: average response latency 1.35 s (SD 0.55) reduced spontaneity and negatively affected perceived naturalness — [arXiv 2503.15496](https://arxiv.org/pdf/2503.15496); field experiment in a shopping mall: lower latency improved subjective ratings but not behaviour — [arXiv 2503.06241](https://arxiv.org/pdf/2503.06241) (both via search summaries)
- Vendor claims (unsourced): under 300 ms "feels instantaneous", 300-400 ms awkwardness begins, over 500 ms users wonder if they were heard, over 1000 ms users assume connection failure; production target under 800 ms end-to-end, design goal under 500 ms; Hamming's own production data P50 1.4-1.7 s, P90 3.3-3.8 s — [Hamming latency guide](https://hamming.ai/resources/voice-ai-latency-whats-fast-whats-slow-how-to-fix-it)
- FLEXI's interaction levels put "face-to-face" at below 150 ms and "telephone-like" at below 400 ms latency — [FLEXI](https://arxiv.org/html/2509.22243v1)

### Inferences
- A defensible human reference for PAN's FTO distribution: median 0-200 ms, about 75% under 500 ms, about 90% under 1 s. No cascaded STT→LLM→TTS system on a CPU will hit the median; a realistic "feels like a person" target is to keep the tail out of the meaning-bearing zone (≥ 700 ms reads as hesitation/trouble) as often as possible, and never reach the "assume it broke" zone (multi-second).
- Because human turn transitions are largely projected (55-59% happen faster than reaction time allows), an assistant that only reacts after silence will always sit in the human tail. The fixes that move the median are prediction (semantic turn-end models, speculative LLM start) rather than shorter silence timers, which trade directly against cut-offs given that pauses outlast gaps.
- Overlap shares of 40-48% in human talk do not mean PAN should overlap the user: most human overlaps are short, near projected turn ends, or backchannels. For an assistant, the user-perceived failure is overlap that starts mid-thought (a cut-off), so the scorecard should count cut-offs, not overlap per se.
- Human backchannel rate (about 4/min) is a reference for how many "mm-hm"s PAN must tolerate without stopping while it talks; in a 30 s answer the user may plausibly backchannel two times.

### Gaps
- Roberts & Francis 2013 threshold value and Shiwa et al. 2008 robot-delay findings (often cited as "about 1 s preferred, fillers help") could not be verified from primary text.
- No controlled user study specific to smartphone voice assistants with a clean latency-to-naturalness curve was found; the 2.3 s and 8 s "patience" figures seen in blogs had no traceable primary source.
- Human barge-in yield latency (how fast a speaker stops when interrupted) has no clean modern corpus number in what I found; only the Schegloff "beat" concept (about 180 ms, secondary).
- Backchannel timing distributions (relative to pitch cues/pauses) were only available indirectly (ICC in FDB v1; second-hand CANDOR parameters).

---

## 3. Metrics for a practical scorecard: definitions, how to compute, and what "good" looks like

### Takeaway
Every metric PAN needs already has a published operational definition: response latency (end of user speech to model onset), takeover/false-cut-off rate (agent starts before the user finishes, or takes the floor in a pause), response rate (missed turns), stop/yield latency (user onset to model stop), selectivity (ignoring backchannels, vocal tics, side talk, background speech), post-interruption behaviour (Respond/Resume/Uncertain/Unknown), and state/memory/instruction metrics (EchoChain failure taxonomy, Audio MultiChallenge axes, FDB v2 entity tracking). Best published systems give realistic targets; human references give the ceiling.

### Cited Findings
- **Response latency / FTO**: FDB v1 "smooth turn-taking latency" = end of user speech to start of model response, only on takeovers — [FDB v1](https://arxiv.org/html/2503.04721v3); FDB v1.5 response latency t_resp = t_model_start − t_user_end — [FDB v1.5](https://arxiv.org/html/2507.23159); tau-Voice L_R = end of user utterance to agent response — [tau-Voice](https://arxiv.org/html/2603.13686v1); Hamming end-to-end latency = `firstAudioByte − userSpeechEnd`, with endpointing delay = `sttStarted − userSpeechEnd` (vendor) — [Hamming](https://hamming.ai/resources/voice-ai-latency-whats-fast-whats-slow-how-to-fix-it)
- Best published end-to-end values: tau-Voice realistic latency 0.90-1.15 s — [tau-Voice](https://arxiv.org/html/2603.13686v1); AA TTFA leaders 0.61-1.35 s — [Artificial Analysis](https://artificialanalysis.ai/speech-to-speech); HumDial top delays 1.237-1.301 s — [HumDial study](https://arxiv.org/html/2604.21406v1); FDB v1 Gemini Live 1.301 s, Moshi 0.265 s — [FDB v1](https://arxiv.org/html/2503.04721v3)
- **False cut-off rate**: FDB v3 interrupt rate = share of turns with agent start − user end < 0 (GPT-Realtime 13.5% best, cascade 33.0%) — [FDB v3](https://arxiv.org/html/2604.04847v1); tau-Voice I_A (OpenAI 14%, Gemini 21%, Grok 84%) — [tau-Voice](https://arxiv.org/html/2603.13686v1); FLEXI jump-in rate — [FLEXI](https://arxiv.org/html/2509.22243v1); FDB v1 Pause TOR (Gemini Live 0.255-0.310 best, Moshi 0.98) — [FDB v1](https://arxiv.org/html/2503.04721v3); TurnBench EOT FPR (best trained endpointers 0.047-0.078; OpenAI server VAD 0.525) — [TurnBench](https://www.sesame.com/blog/turnbench)
- **Missed turn / over-wait**: tau-Voice Response Rate R_R — [tau-Voice](https://arxiv.org/html/2603.13686v1); FDB v1 smooth-turn TOR (Gemini Live only 0.655) — [FDB v1](https://arxiv.org/html/2503.04721v3); FDB v3 turn-take rate (78-100%) — [FDB v3](https://arxiv.org/html/2604.04847v1); TurnBench EOT recall and signed latency p10/p50/p90 — [TurnBench](https://www.sesame.com/blog/turnbench)
- **Barge-in reaction**: FDB v1.5 stop latency t_stop = t_model_stop − t_user_start (GPT-4o Realtime 0.23 s on true interruptions; Gemini 2.20 s) — [FDB v1.5](https://arxiv.org/html/2507.23159); tau-Voice Yield Rate = yields within 2 s, Yield Latency L_Y — [tau-Voice](https://arxiv.org/html/2603.13686v1); FLEXI TTR and interrupt latency (Gemini 0.935 / 1.766) — [FLEXI](https://arxiv.org/html/2509.22243v1); the survey calls FDB v1.5 stop latency the closest public metric to "substantive" full-duplex — [survey](https://arxiv.org/abs/2606.19453)
- **False barge-in / selectivity**: FDB v1.5 Resume rate on backchannels, side talk, background (Nova Sonic 0.98 / 0.90 / 0.98 best) — [FDB v1.5](https://arxiv.org/html/2507.23159); tau-Voice Selectivity S_BC, S_VT, S_ND — [tau-Voice](https://arxiv.org/html/2603.13686v1); HumDial rejection success (top 72.2) — [HumDial study](https://arxiv.org/html/2604.21406v1); TurnBench INT FPR counts backchannel, noise and channel bleed — [TurnBench](https://www.sesame.com/blog/turnbench)
- **Post-interruption correctness and state**: FDB v1.5 Respond rate (best 0.78) — [FDB v1.5](https://arxiv.org/html/2507.23159); EchoChain contextual inertia, interruption amnesia, objective displacement — [EchoChain](https://arxiv.org/html/2604.16456); Self-Listening "anchor interruption" (consistency with what was actually heard) — [Self-Listening](https://arxiv.org/abs/2609.05592)
- **Context recall / instruction persistence**: Audio MultiChallenge Instruction Retention and Inference Memory axes (top overall 54.65%) — [Scale](https://scale.com/leaderboard/audiomc); FDB v2 Entity Tracking and multi-turn Instruction Following 1-5 — [FDB v2](https://arxiv.org/html/2510.07838); FDB v3 self-correction handling (cascade 0.176) — [FDB v3](https://arxiv.org/html/2604.04847v1)
- **Naturalness / judges**: FDB v1.5 tracks UTMOSv2 and prosody shifts after overlap — [FDB v1.5](https://arxiv.org/html/2507.23159); AudioJudge (EACL 2026): large-audio-model judges reach up to 0.91 Spearman with human preferences at system-ranking level; pairwise evaluation is more reliable than pointwise; verbosity and position biases need mitigation — [AudioJudge](https://arxiv.org/abs/2507.12705); FDB v2 transcript judge vs humans r = 0.59-0.69, lowest on turn-taking — [FDB v2](https://arxiv.org/html/2510.07838); MTalk-Bench: LLM judges align when gaps are clear, with position and length biases — [MTalk-Bench](https://arxiv.org/abs/2508.18240)
- **Measurement tooling used by benchmarks**: Silero-VAD for speech activity (FDB v1.5, HumDial) and Parakeet-TDT 0.6B for word timestamps (FDB v1, v1.5, HumDial English) — [FDB v1.5](https://arxiv.org/html/2507.23159); [HumDial study](https://arxiv.org/html/2604.21406v1)

### Inferences
Proposed PAN scorecard. Thresholds are my proposals, anchored on the human data in section 2 and best published systems above. "Gate" = must not regress release to release; "Human-like" = the target that should make it feel like talking to a person.

| # | Metric | Definition (computed from the two recorded channels) | Gate (acceptable) | Human-like target | Anchors |
|---|---|---|---|---|---|
| M1 | Response FTO p50 / p90 | PAN audio onset at the speaker minus user speech offset (Silero VAD), on complete user turns only | p50 ≤ 1.0 s, p90 ≤ 1.8 s | p50 ≤ 0.6 s, p90 ≤ 1.0 s | humans median ~0.1-0.2 s, 82-95% < 1 s; commercial 0.9-1.35 s; ≥ 0.7 s is meaning-bearing |
| M2 | False cut-off rate | Share of designed within-turn pauses / disfluencies where PAN audio starts (or a commit happens) before the user's true turn end | ≤ 15% | ≤ 5% | best trained endpointers FPR ~5% (TurnBench); GPT-Realtime 13.5% (FDB v3); cascade 33% |
| M3 | Missed turn rate | Complete user turns with no PAN speech within 5 s | ≤ 3% | ≤ 1% | tau-Voice responsiveness 69-100% |
| M4 | Over-wait rate | Complete user turns with FTO > 2.0 s | ≤ 10% | ≤ 3% | "assume it broke" zone > 1-2 s (vendor), delay less bearable > 4 s (Maslych) |
| M5 | Barge-in stop latency p50 / p90 | PAN audio offset minus user onset, on true interruptions | p50 ≤ 0.5 s, p90 ≤ 1.0 s | p50 ≤ 0.25 s, p90 ≤ 0.5 s | GPT-4o Realtime 0.18-0.23 s; Gemini 2.2 s; human beat ~0.18 s |
| M6 | Yield success | True interruptions where PAN stops within 2 s | ≥ 90% | ≥ 98% | tau-Voice yield rate definition |
| M7 | Post-barge-in response | Respond rate (addresses new content) and latency from user offset | ≥ 70%, p50 ≤ 1.5 s | ≥ 90%, p50 ≤ 1.0 s | FDB v1.5 best Respond 0.78; ≤ 1.5 s for effective repair |
| M8 | Backchannel tolerance | Share of user "mm-hm/yeah/right" during PAN speech where PAN keeps talking with no restart | ≥ 80% | ≥ 95% | Nova Sonic 0.98, Gemini 0.93 |
| M9 | Side-talk / TV rejection | Share of non-addressed speech events with no PAN response and no stop | ≥ 80% | ≥ 95% | Gemini 0.99 side talk; GPT-4o 0.02-0.04 |
| M10 | Echo self-triggers | PAN stops, commits, or ASR words emitted while only PAN is speaking (user channel silent), per 10 min of PAN speech, acoustic mode only | ≤ 1 per 10 min | 0 | TurnBench counts channel bleed as INT false positive |
| M11 | Context recall | Correct use of a fact planted k turns earlier (k = 3, 6, 10) | ≥ 80% | ≥ 95% | Audio MultiChallenge inference memory |
| M12 | Instruction persistence | Turns that still obey a standing instruction given earlier | ≥ 80% | ≥ 95% | Audio MultiChallenge instruction retention; FDB v2 IF |
| M13 | Correction honoured | Self-corrected slot ("Tuesday, no, Thursday") used correctly | ≥ 70% | ≥ 90% | FDB v3 self-correction (GPT-Realtime 0.588, cascade 0.176) |
| M14 | Interruption state update | After "actually, make it X" mid-answer, new answer keeps old constraints and applies the change (no inertia, amnesia, displacement) | ≥ 60% | ≥ 85% | EchoChain best 48.5% |
| M15 | Human preference | Owner's blind A/B win-or-tie rate for candidate vs last release, plus 1-5 "felt like a person" | ≥ 50% win-or-tie | ≥ 4/5 and trending up | AudioJudge: pairwise > pointwise |

- Report each latency as p50 and p90 with bootstrap 95% CIs, never a mean (Heldner & Edlund show gap distributions are skewed and heavy-tailed).
- Report the scorecard per scenario family and refuse to collapse it into a single index for gating (survey recommendation; French FDB trade-off); a single "human-likeness index" can be shown for trend only.
- Statistical power: a rate near 10% measured on 30 events has a 95% CI of about ±11 points; 100 events gives about ±6. So M2, M8 and M9 need roughly 100 events per nightly run to detect a 10% to 5% change; latency percentiles need 40 or more transitions.
- Timing should be measured at the loudspeaker (or the PCM actually handed to the audio sink with its playback timestamp), not at "first token" or "TTS start", because that is what the user hears; component timestamps (endpoint commit, ASR final, LLM first token, TTS first chunk) should be logged alongside to attribute regressions.

### Gaps
- No published standard defines "echo-triggered self-interruption" for assistants; M10 is my construction.
- No public study validates specific numeric thresholds against user satisfaction for a phone assistant; the gate/target values above are proposals.
- Audio-capable LLM judges good enough to run on a CPU were not evaluated in what I found; AudioJudge's strong results used proprietary models (secondary claim).

---

## 4. Industry evaluation tools and practices for voice agents

### Takeaway
Commercial voice-agent QA platforms (Hamming, Coval, Cekura, Bluejay) all converge on the same recipe: LLM-driven simulated callers with persona knobs (accent, noise, interruption rate, hesitation, emotion), scripted deterministic barge-ins, audio-level timing metrics (time to first word, interruption rate, agent-fails-to-respond), LLM-judge success criteria, and replay of real calls. They are cloud and telephony oriented, so PAN should copy the practice, not adopt the products. Pipecat Evals is the most transferable open tool: YAML scenarios, a local Ollama judge, local Kokoro TTS for the simulated user, audio mode through the real STT, and `send_after` for barge-ins.

### Cited Findings
- **Hamming** (vendor claims): deterministic barge-in testing "with configurable timing and keywords"; noise injection (restaurants, streets, offices, construction); simulated callers with accents, interruptions, emotions and drift; conversational metrics include turn-taking latency, interruptions, time to first word, talk-to-listen ratio, tracked in tests and production; claims 95-96% agreement with human evaluators and 50K+ concurrent calls — [Hamming automated testing](https://hamming.ai/product/automated-testing); [Hamming site](https://hamming.ai/)
- Hamming defines end-to-end latency as `firstAudioByte − userSpeechEnd` and gives component budgets: STT 100-200 ms optimized, LLM TTFT 200-500 ms, TTS TTFB 40-200 ms, turn detection 200-400 ms optimized; typical VAD defaults vs optimized: silence threshold 800 → 500 ms, end-of-turn delay 1000 → 400-600 ms (vendor guidance) — [Hamming latency guide](https://hamming.ai/resources/voice-ai-latency-whats-fast-whats-slow-how-to-fix-it)
- **Coval**: metric catalog covers LLM/STT/TTS time-to-first-byte and end-to-end turn latency, turn-taking (interruption rate, agent fails to respond, repeated turns), audio quality, STT WER; starter set = Call Resolution Success (LLM judge) + Latency + Interruptions (audio metrics); personas with configurable voices, background environments, interruption rates and emotional progression; custom metrics from OpenTelemetry spans; simulations capped at 15 min — [Coval quick start](https://docs.coval.dev/getting-started/quick-start); [Coval simulations](https://docs.coval.dev/concepts/simulations/overview)
- Coval's realtime voice-to-voice guide recommends instrumenting tool calls, slot values, and turn-by-turn latency and overlap — [Coval realtime guide](https://www.coval.ai/blog/evaluating-realtime-voice-to-voice-ai-agents-a-practical-guide)
- **Cekura** (vendor claims): 50+ personas covering accents, background noise profiles, hesitation patterns and speech speeds; reproduces real pauses and mid-sentence interruptions; inputs can be scripted conversations, AI-generated cases or replays of production calls — [Cekura persona QA](https://www.cekura.ai/blogs/persona-based-voice-ai-qa); [Cekura overview](https://www.cekura.ai/discover/voice-agent-testing-platforms)
- **Bluejay** (described by competitors): "human simulation" with synthetic customers across languages, accents and background sounds, 500+ simulation variables; Cekura offers deterministic conditional actions that Bluejay reportedly lacks (competitor-written comparison) — [Coval: Cekura vs Bluejay](https://www.coval.ai/blog/cekura-vs-bluejay); [Future AGI comparison](https://futureagi.com/blogs/voice-ai-simulation-cekura-hamming-bluejay-coval-2025)
- **Pipecat Evals**: scenarios in YAML, either scripted (`turns:` with `user:` and `expect:`) or simulated (`persona:`, `goal:`, `success:`, `metrics:` with `min_score`); expectations include `eval:` criteria, `text_contains`, function calls, `within_ms` latency budgets, and `send_after` to interrupt mid-response; text mode bypasses STT/TTS, **audio mode synthesizes the user's voice, streams it through the agent's real STT and transcribes the agent's audio**, catching turn-detection and barge-in problems; default local TTS Kokoro, STT Moonshine or Whisper; default judge and persona LLM is a local Ollama model (`gemma4:12b`); CLI `pipecat eval run` — [Pipecat Evals docs](https://docs.pipecat.ai/pipecat/evals/overview)
- **LiveKit Agents**: pytest or Vitest unit tests in text mode asserting messages, tool calls and handoffs turn by turn; separate Agent Simulations with a simulated user can run over audio to exercise the full STT-LLM-TTS pipeline and are recommended for turn-taking issues — [LiveKit testing docs](https://docs.livekit.io/agents/build/testing/)
- Pipecat's docs route production monitoring and persona-scale testing to third-party platforms (Coval, Bluejay, Cekura) — [Pipecat evals search summary](https://docs.pipecat.ai/pipecat/evals/overview)

### Inferences
- The shared industry practice worth copying: (1) separate deterministic scripted cases (exact barge-in timing, exact pause lengths) from stochastic persona simulations; (2) score timing from audio, not logs; (3) use an LLM judge only for content outcomes; (4) replay real failures as regression cases.
- PAN's own `converse` text harness already mirrors Pipecat's text mode; the missing piece is Pipecat-style audio mode (synthesized user speech through the real VAD/STT/turn logic) plus barge-in timing (`send_after`) and latency budgets (`within_ms`). The YAML schema is a good template.
- These platforms dial into phone numbers or WebRTC rooms; PAN has neither as its primary path (it is an Android app), so the injection point must be built into the app.

### Gaps
- Exact definitions of Coval's "interruption rate" and Hamming's "interruptions" metric (e.g., what counts, time windows) were not retrieved.
- No independent evaluation of how realistic any vendor's simulated callers are (accents, noise, disfluency) was found.
- LiveKit's per-turn metrics (end-of-utterance delay, TTFT, TTS TTFB events) were not on the page fetched.

---

## 5. User simulation: synthetic users with natural pauses, fillers, corrections, barge-ins and backchannels; injection into a phone or server; two-channel recording and automatic timing metrics

### Takeaway
Three simulation styles exist: (a) fixed pre-rendered user audio with designed timing (FDB v1/v1.5, FD-Bench, HumDial), (b) pre-rendered cues injected at times that adapt to the system's speech (EchoChain: fixed delay after assistant onset; DuplexAct: an LLM polled every second decides when to inject), and (c) fully generative LLM+TTS users that decide to interrupt or backchannel on a clock (tau-Voice every 2 s; FDB v2's GPT-Realtime examiner). Real human audio matters for disfluency (FDB v3 uses only real recordings), and full-duplex user simulators are still research-stage. For PAN, style (b) with pre-rendered clips is the right fit: deterministic, CPU-cheap, and adaptive where timing matters.

### Cited Findings
- tau-Voice user simulator: GPT-4.1 writes the user's text, ElevenLabs v3 (24 kHz) voices it; separate LLM checks every 2.0 s decide whether to interrupt and whether to backchannel; the user waits for 1.0 s of agent silence before responding and re-prompts after 5.0 s; yields after 1.0 s when the agent interrupts and after 5.0 s when the user interrupts; a tick-based orchestrator exchanges 200 ms of audio per tick and the simulator reads the agent transcript directly (no ASR on agent speech) — [tau-Voice](https://arxiv.org/html/2603.13686v1)
- tau-Voice realistic audio recipe: indoor/outdoor background at 15 dB SNR with ±3 dB drift; about one burst per minute at −5 to +10 dB SNR (phone ringing, dog bark, car horn, siren); Gilbert-Elliott frame drops at 2% average; G.711 μ-law 8 kHz; dynamic muffling on 20% of utterances; five non-American accent personas — [tau-Voice](https://arxiv.org/html/2603.13686v1)
- FDB v1.5 recipes for non-addressed speech: talking-to-others (−8 dB, high-shelf −5 dB above 4 kHz, reflections 45 ms at −6 dB and 120 ms at −12 dB) and background speech (−15 dB, 3 kHz low-pass, 100 ms echo at −10 dB, compression) — [FDB v1.5](https://arxiv.org/html/2507.23159)
- FDB v1 synthetic pauses inserted with ChatTTS `[uv_break]` tokens — [FDB v1](https://arxiv.org/html/2503.04721v3); FLEXI synthesizes with CosyVoice2 and inserts silences after backchannels, interruptions and query ends — [FLEXI](https://arxiv.org/html/2509.22243v1)
- FDB v3 deliberately uses 100% real human audio (12 speakers, everyday built-in mics) for five disfluency types — [FDB v3](https://arxiv.org/html/2604.04847v1)
- EchoChain pre-synthesizes user audio so injection timing does not depend on runtime TTS, and injects the barge-in a fixed delay after detected assistant speech onset (model buffering causes small deviations) — [EchoChain](https://arxiv.org/html/2604.16456)
- DuplexAct keeps cue content and audio fixed but lets a GPT-5.4 simulator, polled every 1 s with the model's streaming transcript, choose injection time — [DuplexAct](https://arxiv.org/html/2610.17738)
- FDB v2 Examiner (GPT-Realtime) can speak immediately on stage completion or backchannel even while the Evaluatee is talking (Fast pacing, server VAD `interrupt_response: true`) — [FDB v2](https://arxiv.org/html/2510.07838)
- JHU CLSP (Jan 2026) notes that current user simulation relies on cascaded components and non-streaming APIs, mismatching human latency, and proposes a full-duplex user simulator that can interrupt and backchannel on demand (a project description, not results) — [JHU CLSP](https://www.clsp.jhu.edu/2026/01/27/simulating-full-duplex-conversations-for-evaluating-ai-systems/)
- Pipecat Evals audio mode: local Kokoro TTS for the simulated user, streamed through the agent's real STT; barge-in via `send_after` — [Pipecat Evals](https://docs.pipecat.ai/pipecat/evals/overview)
- Capturing phone audio on a host: scrcpy forwards device audio on Android 11+ (Android 11 requires the screen unlocked at start); `--audio-source=output` (default, whole output, mutes device playback), `playback` (app playback only; apps can opt out; Android 13+ variant with `--audio-dup` keeps sound playing on the device), `mic` (microphone); example `scrcpy --audio-source=mic --no-video --no-playback --record=file.opus` — [scrcpy audio doc](https://github.com/Genymobile/scrcpy/blob/master/doc/audio.md)
- Timing extraction in published harnesses: Silero-VAD for speech boundaries and Parakeet-TDT word timestamps; FDB v1 aligns recorded output to the input duration so both channels share one timeline — [FDB v1](https://arxiv.org/html/2503.04721v3); [FDB v1.5](https://arxiv.org/html/2507.23159); [HumDial study](https://arxiv.org/html/2604.21406v1)

### Inferences
- **Synthetic user content**: build each scenario as a script of clips plus a timeline. Best realism per CPU cost: record the owner reading a fixed script once (real disfluency, real accent, real mic distance), then augment with TTS clips for volume. Kokoro/Piper give clean speech but no natural fillers; ChatTTS-style break tokens or hand-spliced silences give controlled pauses. Store every clip with a sidecar JSON of ground-truth events (speech start/end, intended pause positions, "turn really ends here", event type such as backchannel, barge-in, side talk).
- **Adaptive timing without an LLM**: trigger barge-ins and backchannels relative to PAN's detected speech onset (EchoChain style), and follow-ups relative to PAN's speech offset; a rule table (e.g., "backchannel at +2.5 s and +6 s into PAN's answer if PAN still speaking") avoids needing a simulator LLM on CPU. Optionally add a cheap local LLM to choose the next scripted branch from PAN's transcript for multi-turn memory scenarios.
- **Injection, two modes**:
  - *Digital mode (nightly, deterministic)*: a debug-only app intent (analogous to the existing TEST_SAY/TEST_SPEAK) that streams a WAV into the same consumer that `AudioRecord` feeds (VAD → streaming ASR → turn logic), paced in real time, frame-timestamped on the phone's monotonic clock. This exercises turn detection, ASR, routing, hub and TTS, but not the acoustic path.
  - *Acoustic mode (weekly, realistic)*: play the same timeline from a small speaker beside the phone in a quiet room, so the real mic, AGC, AEC and speaker-to-mic echo are in the loop. This is the only way to measure echo self-triggers (M10) and double-talk behaviour.
- **Recording both channels on one clock**: the user channel is known exactly (the injected timeline). For PAN's channel, the most precise option is an app-side tap of the PCM written to the audio sink together with playback timestamps (frame position to monotonic time), plus the existing playback log lines (CUT vs done, frames played) for stop latency. For acoustic mode, record with scrcpy (`playback` with `--audio-dup` on Android 13+) or a reference mic, and align with a start chirp.
- **Automatic metrics**: run Silero VAD on both channels (cheap on CPU), derive inter-pausal units, compute M1-M10 from event times against ground truth, and transcribe PAN's channel with a local ASR (Parakeet or Whisper) only where content must be judged.
- **Server-endpoint alternative**: streaming audio straight into the hub tests hub-side ASR/LLM but skips the phone's VAD, turn logic, TTS and playback, which are where cut-offs, echo and barge-in live; it is useful only as a fast pre-check.

### Gaps
- No open, validated full-duplex user simulator usable offline was found; the JHU work is a proposal.
- No source quantified how much synthetic-TTS users vs real recorded users change turn-taking scores; FDB v3 only argues real audio is needed for disfluency.
- Android-specific details for injecting into the mic path (beyond app-level hooks) and precise AudioTrack timestamp accuracy were not researched from sources here.

---

## 6. A concrete PAN conversation benchmark (design)

### Takeaway
Build a nightly, on-device, two-channel benchmark around 16 scenario families that map one-to-one onto the owner's complaints (cut-offs, odd breaks, echo, forgetting, slowness, turn-based feel), score them with the M1-M15 scorecard, run in digital-injection mode nightly (about 1.5-2 h on CPU) and acoustic mode weekly, and calibrate monthly against public sets (TurnBench dev EOT, FDB v1/v1.5, HumDial-FDBench). Add a 10-minute weekly blind A/B listening check by the owner, because judges agree with humans least on turn-taking.

### Cited Findings
PAN-internal facts (point-in-time memory notes, Sept to Oct 2026; verify against current code):
- Existing debug intents: `TEST_SPEAK` (TTS and audio path only), `TEST_SAY` (full loop "exactly as if STT heard it": routing, hub round trip, reply, speech), `STOP_TTS` (the same path barge-in uses); `TEST_SAY` clears a 3 s dedup window and a 2 s post-TTS echo cooldown, both of which silently drop repeated utterances; playback logs `Playback CUT (... played x/y frames)` vs `Playback done` — [PAN memory: phone test harness](PAN project memory: reference_pan_phone_test_harness.md)
- Turn detection on the phone was (Sept 2026) two-stage: `ENDPOINT_SILENCE_S` 0.35 s, then a dangling-function-word test that holds up to `INCOMPLETE_MAX_WAIT_MS` 1400; "flow mode" requires `FLOW_SILENCE_MS` 1100 if another turn committed within `FLOW_WINDOW_MS` 2500; a first live monologue produced 11 commits and 9 spoken answers with interjections on nearly every finished clause; LiveKit's 165 MB turn-detector model was deferred — [PAN memory: voice pipeline latency](PAN project memory: reference_pan_voice_pipeline_latency.md)
- Measured question-to-speech of 1565-1983 ms on the phone after removing the spoken filler, and 339-950 ms hub-side for short conversational replies (different measurement points); the always-on mic transcribes TV/video speech because there is no speaker verification; Silero VAD needs fixed 512-sample windows — [PAN memory: voice pipeline latency](PAN project memory: reference_pan_voice_pipeline_latency.md)
- The text-level `converse` eval posts to the hub's streaming query endpoint with `source: 'voice'`, carries explicit `thread` context for follow-ups, needs `--loop N` because "single runs lie" with a 2B model, and a CPU judge (`gemma4:e4b`) costs about 50 s per call while `gemma4:e2b` gives false passes — [PAN memory: behavioural evals](PAN project memory: project_pan_behavioural_evals.md)

External anchors used by the design:
- Published injection/timing practice (fixed delay after assistant onset; LLM- or rule-timed cues) — [EchoChain](https://arxiv.org/html/2604.16456); [DuplexAct](https://arxiv.org/html/2610.17738)
- Non-addressed speech and noise recipes — [FDB v1.5](https://arxiv.org/html/2507.23159); [tau-Voice](https://arxiv.org/html/2603.13686v1)
- Public calibration sets: TurnBench dev with self-serve scoring (non-commercial, no voice cloning) — [TurnBench](https://www.sesame.com/blog/turnbench); FDB v1/v1.5 with server-client inference — [FDB GitHub](https://github.com/DanielLin94144/Full-Duplex-Bench); HumDial-FDBench on Hugging Face — [HumDial-FDBench](https://github.com/ASLP-lab/HumDial-FDBench); Easy-Turn test set — [Awesome list](https://github.com/cageyoko/Awesome-Full-Duplex-Benchmark)
- Judges: pairwise more reliable than pointwise — [AudioJudge](https://arxiv.org/abs/2507.12705); transcript judges agree least with humans on turn-taking — [FDB v2](https://arxiv.org/html/2510.07838)

### Inferences

**6.1 Architecture**
1. *Scenario store*: YAML per scenario (Pipecat-Evals-like): clips, timeline, triggers relative to PAN onset/offset, expected behaviour, metric tags. Clips pre-rendered once (owner's recorded voice for core set; TTS for variants; noise/side-talk mixed with the FDB v1.5 and tau-Voice recipes) and cached, so nightly runs synthesize nothing.
2. *Phone side*: new debug-only intent `TEST_AUDIO <session.json>` that feeds PCM frames into the live VAD/ASR/turn path in real time and emits a JSONL event log with monotonic timestamps: injected frame times, VAD on/off, ASR partial/final, turn commit/hold decisions, query sent, first chunk received, TTS chunk start, playback head positions, CUT/done with frames, barge-in detections. Also an app-side tap of the PCM actually played.
3. *Orchestrator* (hub or workstation, over adb): pushes the session, starts it, watches the event stream to fire adaptive triggers (barge-in N ms after PAN onset; follow-up N ms after PAN offset), pulls logs and audio after each scenario; uses an isolated eval conversation id so memory scenarios use their own history and nothing leaks into real memory (same principle as the existing converse harness).
4. *Scorer*: Silero VAD on both channels → events → M1-M14; local ASR on PAN channel only for content checks; deterministic checks first (regex/keywords for planted facts, instruction compliance like "one sentence"), local LLM judge only for Respond/Resume/Uncertain classification and fuzzy content; outputs JSON + an HTML trend page and a regression alert.

**6.2 Scenario families** (each run 3 times nightly; counts chosen to reach about 100 events for rate metrics)

| ID | Scenario | What is injected | Expected PAN behaviour | Metrics |
|---|---|---|---|---|
| S1 | Quick plain turns | 15 short questions/statements, 2-4 s apart after PAN finishes | Answer promptly | M1, M3, M4 |
| S2 | Mid-thought pauses | 20 utterances with 0.6/1.0/1.5/2.0 s pauses at syntactically incomplete points ("I was thinking we could... maybe the...") | Wait, then answer once | M2 by pause length, M1 after true end |
| S3 | Complete-sounding pause, not done | 10 utterances with a full clause, 1.0-1.5 s pause, then "and also..." | Wait (flow mode) | M2 |
| S4 | Fillers and self-corrections | "um, set it for, uh, Tuesday, no wait, Thursday" style, 10 cases | Wait; use corrected value | M2, M13 |
| S5 | Quick follow-ups | "why?", "and the other one?" 0.5-1.5 s after PAN ends (stress the post-TTS cooldown) | Answer from previous turn | M1, M3, M11 (k = 1) |
| S6 | Barge-in with new question | New question 1.0/2.5/5 s after PAN onset | Stop fast, answer new question, do not resume old answer | M5, M6, M7 |
| S7 | Mid-answer correction | "actually make it vegetarian" during a plan/list | Stop, keep old constraints, apply change | M5, M14 |
| S8 | Stop/hold commands | "stop", "wait", "hold on" mid-answer | Stop and stay quiet | M5, M6, no restart |
| S9 | Backchannels while PAN talks | "mm-hm", "yeah", "right" at +2.5 s and +6 s into long answers | Keep talking | M8 |
| S10 | Side talk | Far-field "can you grab the charger?" (FDB v1.5 filter) during and between PAN turns | Ignore | M9 |
| S11 | TV/background speech | Other-voice dialogue at −15 dB, low-passed, continuous for 60 s while a normal conversation runs | Ignore TV, keep serving user | M9, M1/M2 deltas |
| S12 | Noise | S1/S2 replayed with café/street/kitchen noise at 15 dB and 5 dB SNR, plus bursts | Same behaviour as clean | Deltas of M1-M3 |
| S13 | Memory across turns | Plant neutral facts ("the screws are in the blue box"), ask at k = 3, 6, 10 turns | Correct recall | M11 |
| S14 | Standing instructions | "for the rest of this chat keep answers to one sentence" / "don't mention X", then 8 turns | Comply throughout | M12 |
| S15 | User thinking after PAN's question | PAN asks something; user is silent 2-4 s, then answers | No premature re-prompt; answer accepted | M2-style premature re-prompt rate, M3 |
| S16 | Very short answers | "yes", "no", "two" after PAN questions (dedup/min-duration risk) | Respond | M3, M1 |
| S17 | Echo stress (acoustic mode only) | PAN long answers at high volume, user silent; then quiet user backchannels during PAN speech | No self-interruption; backchannels tolerated | M10, M8 |
| S18 | Long monologue | 60 s story with clause boundaries and pauses | No interjections until end, then a relevant reply | M2 count, M1 |

**6.3 Pass criteria for "feels human"**
- Release gate: all "Gate" columns in the section 3 table pass and no metric regresses beyond its CI versus the last release.
- "Feels like a person" declared when, for two consecutive weeks: M1 p50 ≤ 0.6 s and p90 ≤ 1.0 s; M2 ≤ 5%; M3 ≤ 1%; M5 p50 ≤ 0.25 s; M8 and M9 ≥ 95%; M10 = 0; M11-M12 ≥ 95%; and the owner's weekly A/B and 1-5 rating meet M15. The latency targets are deliberately looser than human medians (unreachable for a CPU cascade) but keep most responses below the 700 ms meaning-bearing zone.

**6.4 Nightly run on CPU**
- Wall-clock is dominated by real-time playback: 18 families × about 2-4 min × 3 repeats ≈ 60-90 min, plus scoring. Silero VAD on both channels is fast; local ASR on PAN's channel for content-checked scenarios only; LLM-judge calls limited to roughly 40-60 per night (at ~50 s per call on a CPU judge, about 35-50 min; deterministic checks should cover most cases). Total about 2-2.5 h, suited to an overnight window when nobody is talking to the phone.
- Monthly calibration: run a fixed 60-min slice of TurnBench dev (EOT track) through `TEST_AUDIO` and log commit times as EOT decisions, giving recall/FPR/latency directly comparable to Smart Turn v3, VAP, Kyutai and OpenAI VADs; run FDB v1/v1.5 and HumDial-FDBench English subsets through the same harness to get numbers comparable to Gemini, GPT-4o Realtime, Freeze-Omni and the HumDial cascades. Note TurnBench's non-commercial licence if PAN becomes a product.
- Keep every failure's audio, event log and transcripts; promote real-life failures (from the owner's flagged moments) into new scripted cases.

**6.5 Quick human check (about 10 minutes, weekly)**
1. *Blind A/B (6 minutes)*: 8 pairs of 20-40 s clips from the same injected user audio, last release vs candidate, order randomized, labels hidden. Question per pair: "Which felt more like talking to a person?" plus optional tags (cut me off, too slow, ignored me, talked over me, forgot, weird break, echo). Pairwise because it is more reliable than pointwise rating.
2. *Live 3-minute chat (3 minutes)*: free conversation on a rotating topic card; a hardware "that felt wrong" gesture (e.g., double-press of a volume key, logged with a timestamp) marks bad moments, which the scorer later attributes to the nearest event (cut-off, over-wait, echo, forgot).
3. *Four 1-5 ratings (1 minute)*: timing felt natural; it let me finish; it stopped when I wanted; it remembered what I said. Track the weekly series alongside M1-M14; investigate any week where human ratings and automated metrics move in opposite directions (a sign a metric is being gamed, per the French FDB trade-off).

**6.6 Order of value**
- First build the `TEST_AUDIO` injection, the event log, and S1, S2, S6, S9, S13; those five cover the reported complaints (slow, cuts off, turn-based, ignores barge-in or over-reacts, forgets). Acoustic mode and S17 come next for echo. External calibration last.

### Gaps
- Whether ASR currently runs on the phone or the hub affects where the event log must be emitted; three internal sources disagree (the task brief says ASR on the hub; the Sept 2026 memory notes describe sherpa streaming ASR and Silero VAD on the phone; the architecture diagram in `PAN/CLAUDE.md` still shows Google Streaming STT and Android TTS on the phone, which looks stale). Needs checking in current code before building `TEST_AUDIO`.
- The real-time cost of the phone's VAD/ASR when fed injected audio, and whether the post-TTS echo cooldown will need a test override in acoustic vs digital mode, are unknown until built.
- No local audio-capable judge has been validated for PAN's CPU budget; content judging is assumed to run on transcripts.
- Statistical thresholds (event counts, CI-based regression rules) are back-of-envelope binomial estimates, not validated against PAN's actual run-to-run variance.

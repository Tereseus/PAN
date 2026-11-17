# Model credits

The interpreter on the phone runs these. Attribution is a condition of most of them, so this list
has to reach the app (an About page) before PAN goes to anyone else.

| What | Does | Licence | Credit |
|---|---|---|---|
| [quickmt](https://huggingface.co/quickmt) en-ja, ja-en, en-el, el-en | Translates | CC-BY-4.0 | quickmt |
| [Parakeet TDT 0.6B v3, Greek](https://huggingface.co/myned-ai/parakeet-tdt-0.6b-v3-greek) | Hears Greek | CC-BY-4.0 | myned-ai, from NVIDIA's Parakeet TDT 0.6B v3 |
| [SenseVoice Small](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) | Hears Japanese, Chinese, Korean, Cantonese, English | FunASR Model License 1.1 | Alibaba Group, keep the model name |
| [Whisper tiny](https://huggingface.co/openai/whisper-tiny) | Tells English from Greek | Apache 2.0 | OpenAI |
| [3D-Speaker CAM++ zh_en](https://github.com/modelscope/3D-Speaker) | Tells people's voices apart | Apache 2.0 | Alibaba 3D-Speaker |
| [CTranslate2](https://github.com/OpenNMT/CTranslate2) | Runs the translators | MIT | OpenNMT |
| [SentencePiece](https://github.com/google/sentencepiece) | Splits text for them | Apache 2.0 | Google |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Runs the ears and the voice | Apache 2.0 | k2-fsa |
| [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) | The voice | OpenRAIL-M model, MIT code | Supertone. OpenRAIL-M has use restrictions that have to be passed on to users |

The Greek ear was trained on 2,003 hours of Greek podcasts that its author does not own, on top of
Common Voice. Its licence is CC-BY-4.0, but check that before selling a product with it.

Test data and tools, not shipped: [FLEURS](https://huggingface.co/datasets/google/fleurs) (CC-BY-4.0),
[fugashi](https://github.com/polm/fugashi) and unidic-lite (MIT and BSD) for scoring Japanese by sound.

## The whole system (checked 2026-11-17)

Every licence below was read that day from the model card, the LICENSE file or the vendor's page,
not from memory. The rule for ΠAN: only licences that allow selling; MIT, BSD and Apache are the easy
ones, and anything else is written out here with what it asks for. "Where" says what ΠAN does with it
today, not what a buyer's install will ship: that list is still to be decided.

### Must change before anything is sold

| What | Where | Licence | Why it is a problem |
|---|---|---|---|
| espeak-ng and `espeak-ng-data` | In the app: 18 MB in `assets/espeak-ng-data`, used only by the old Piper voices. The app's `sherpa-onnx.aar` still has espeak text in it, so it is probably a build from before 2.0.0 | GPL-3.0 or later | A closed app that links it has to be GPL-3 as a whole, with source and install information. sherpa-onnx 2.0.0 (2026-10-20) removed espeak and calls itself GPL-free |
| Piper voice en_US-lessac | In the app's voice picker (developers only since 0.5.0), downloaded on pick | Repo says MIT; the voice was trained on the Blizzard 2013 Lessac data, "non-commercial use only" | Non-commercial data |
| Piper voice en_US-amy (low, medium) | Same picker | Not stated; amy-low is tuned from a CC BY-NC-SA voice | Cannot be shown to be clean |
| Qwen2.5-VL 3B | On the hub's disk since spring (`qwen2.5vl:3b`), named in `memory/ollama-boot.js` and `llm.js`, not the vision model in use | Qwen Research Licence | Non-commercial only. The 7B size is Apache 2.0 |

The fix for the first three is one job: take the Piper voices and the espeak data out of the app (the
voice is Supertonic, which needs neither) and move to sherpa-onnx 2.0.0 or newer.

### Allowed, with conditions

| What | Where | Licence | What it asks for |
|---|---|---|---|
| Liquid LFM2 family | The voice model (Syrinx is a fine-tune of it) | LFM Open License v1.0 | Free for selling only while the company, with everything under common control, makes under $10M a year; above that a paid licence. A fine-tune carries the same cap. Ship a copy of the licence with the model. Its sound tokenizer (Kyutai Mimi) is CC-BY-4.0: credit |
| Supertonic 3 | The voice, on the phone | OpenRAIL-M (model), MIT (code) | Its use rules must be an enforceable part of our own terms with users, and users must be told. In the list: say when speech is machine made, no impersonation without consent, no medical advice. Ship the licence copy |
| NVIDIA Parakeet TDT 0.6B v2 and v3 | The hub's ears (v2), the interpreter (v3) | CC-BY-4.0 | Credit NVIDIA with a link to the licence, and say the file is a converted (int8 ONNX) version |
| SenseVoice Small | Interpreter ears for Japanese, Chinese, Korean | FunASR Model License 1.1 | Credit and keep the model name. Selling is not named in so many words; Alibaba can change the terms; the licence is lost for "malicious smearing" of the software |
| Google ML Kit GenAI (Gemini Nano on the phone) | In the app's build, for on-device summaries and picture descriptions | Google's service terms, not a licence | No app aimed at under 18s, no medical use, tell users about Google's metrics; both features are marked Beta |
| AutoHotkey v2 | A helper on the owner's Windows PCs (`service/bin`), not part of a buyer's phone or hub | GPL-2.0 | Shipping the program means shipping its licence and source or an offer of it. Our own code beside it stays ours ("mere aggregation") |

### Plain MIT, BSD or Apache

Phi-4-mini (MIT). Gemma 4 E2B (Apache 2.0; older Gemma sizes are under Google's own terms, which is
why the hub uses 4). Smart Turn v3 (BSD-2). Silero VAD (MIT). The streaming zipformer English model
(Apache 2.0 on its card). 3D-Speaker CAM++ (Apache 2.0). MADLAD-400 (Apache 2.0). Moondream 2 (Apache
2.0). Kokoro-82M (Apache 2.0). Whisper tiny (MIT). sherpa-onnx (Apache 2.0, see espeak above). ONNX
Runtime (MIT). Ollama (MIT). Vosk (Apache 2.0). Tailscale's Go module (BSD-3) and wireguard-go (MIT).
SQLCipher (BSD style: its notice has to be in what we ship) and sqlite-vec (MIT or Apache 2.0). ZXing,
CameraX and TensorFlow Lite (Apache 2.0). faster-whisper and CTranslate2 (MIT).

### Not checked yet

On the hub's disk and not looked up: `qwen3-embedding` (the memory search model, in use), `qwen3:4b`,
`qwen3.5:4b`, `granite4.2:3b`, `minicpm-v`, `llava-phi3`. In the app: `yamnet.tflite`. Also open: the
exact sherpa-onnx version inside the app's `.aar`, and the data licence behind the zipformer model
(its card names none).


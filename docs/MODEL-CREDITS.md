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
ones, and anything else is written out here with what it asks for. The first table is what runs
today. Whatever is not in it is not part of ΠAN, even if a copy still sits on the owner's hub.

### What runs today

| Job | What does it | Where | Licence |
|---|---|---|---|
| Talks (the voice model) | Syrinx, a fine-tune of Liquid LFM2 | Hub | LFM Open License v1.0 (see conditions) |
| Answers what the voice model hands up | Phi-4-mini, as PAN's own fine-tune of it (`pan-phi-r1`, round 18) | Hub | MIT |
| Splits Japanese into words with their readings | kuromoji 0.1.2 with the IPADIC dictionary | Hub | Apache 2.0 (code), NAIST / ICOT notice (dictionary, see conditions) |
| What each Japanese word means | A meanings file made from JMdict | Hub | CC BY-SA 4.0 (see conditions) |
| Long prompts, background jobs, pictures and screens | Gemma 4 E2B | Hub | Apache 2.0 |
| Memory search (embeddings) | Qwen3-Embedding 0.6B | Hub | Apache 2.0 |
| Ears on the hub | NVIDIA Parakeet TDT 0.6B v2 | Hub | CC-BY-4.0 (see conditions) |
| Ears on the phone, live words | Streaming zipformer (English) | Phone | Apache 2.0 on its card |
| Has he finished talking | Smart Turn v3 | Phone | BSD-2 |
| Is anyone talking | Silero VAD | Phone | MIT |
| Whose voice | 3D-Speaker CAM++ | Hub | Apache 2.0 |
| Is music playing | YAMNet | Phone | Apache 2.0 |
| The voice | Supertonic 3 | Phone | OpenRAIL-M model, MIT code (see conditions) |
| Interpreter: translation | MADLAD-400 | Hub | Apache 2.0 |
| Interpreter: ears | Parakeet TDT 0.6B v3, SenseVoice Small for Japanese, Chinese, Korean | Hub | CC-BY-4.0; FunASR Model License 1.1 (see conditions) |
| Speech library | sherpa-onnx 2.x | Phone, hub | Apache 2.0 (2.0.0 and later carry no GPL part) |
| Model runners | ONNX Runtime, Ollama | Phone, hub | MIT |
| The link | Tailscale's Go module, wireguard-go | Phone, PCs | BSD-3, MIT |
| Storage | SQLCipher, sqlite-vec | Hub | BSD style (its notice must ship), MIT or Apache 2.0 |
| Camera, pairing code | CameraX, ZXing | Phone | Apache 2.0 |

### Allowed, with conditions

| What | Licence | What it asks for |
|---|---|---|
| Liquid LFM2 family (Syrinx) | LFM Open License v1.0 | Free for selling only while the company, with everything under common control, makes under $10M a year; above that a paid licence. A fine-tune carries the same cap. Ship a copy of the licence with the model. Its sound tokenizer (Kyutai Mimi) is CC-BY-4.0: credit |
| Supertonic 3 | OpenRAIL-M (model), MIT (code) | Its use rules must be an enforceable part of our own terms with users, and users must be told. In the list: say when speech is machine made, no impersonation without consent, no medical advice. Ship the licence copy |
| NVIDIA Parakeet TDT 0.6B v2 and v3 | CC-BY-4.0 | Credit NVIDIA with a link to the licence, and say the file is a converted (int8 ONNX) version |
| JMdict (EDRDG), the word meanings for the Japanese reading | CC BY-SA 4.0 with EDRDG's terms | Owner said yes (2026-11-17). Selling is allowed and our code stays ours. Credit with the link to the licence on the About screen (done in app 0.5.10); the meanings file stays share-alike and nobody may claim it; the file has to be rebuilt from the newest JMdict regularly (servers: at least monthly; `service/scripts/build-reading-gloss.mjs`, NOT scheduled yet) |
| IPADIC dictionary inside kuromoji (mecab-ipadic 2.7.0) | NAIST and ICOT notices (permissive, selling allowed) | Every copy must carry the notice: ship kuromoji's `NOTICE.md` with the product |
| SenseVoice Small | FunASR Model License 1.1 | Credit and keep the model name. Selling is not named in so many words; Alibaba can change the terms; the licence is lost for "malicious smearing" of the software |

The owner's word (2026-11-17): everyone who has to be credited gets credited. The list is in the app since 0.5.10: Settings, About, "Credits and licences" (`android/.../ui/settings/Credits.kt`). Change that file in the same commit as the table above.

### Taken out or never part of it

| What | Why it is not in ΠAN |
|---|---|
| Piper voices (Amy, Lessac), Kokoro, espeak-ng data | Removed from the app in 0.5.5. Nothing used them; espeak-ng is GPL-3 and Lessac's training data is non-commercial |
| Google ML Kit GenAI (Gemini Nano on the phone) | Removed in 0.5.5. Google's terms: no app aimed at under 18s, no medical use; ΠAN is for everybody |
| Vosk | Removed in 0.5.5, never wired in |
| Qwen2.5-VL 3B | Never the model in use. Non-commercial licence, so it must never go into an install. A copy sits on the owner's hub from tests |
| `qwen3:4b`, `qwen3.5:4b`, `granite4.2:3b`, `minicpm-v`, `llava-phi3`, Moondream, the older Syrinx rounds | Test copies on the owner's hub; not loaded by anything and not part of an install |
| Whisper and AutoHotkey | The owner's own dictation helper on his PCs (`service/bin`), not part of the product. AutoHotkey is GPL-2 |

### Still open

The data licence behind the phone's zipformer model (its card names none). Before a first install is
built: read this list again against the installer's own download list, and put the credits and
licence copies in the app.

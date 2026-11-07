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

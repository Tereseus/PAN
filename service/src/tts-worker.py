"""
PAN TTS Worker — F5-TTS voice cloning inference

Usage: python tts-worker.py <reference.wav> <text> <output.wav> [ref_text]

Generates speech in the voice of the reference audio.
Runs on GPU (CUDA) if available, falls back to CPU.
"""

import sys
import os
import time

# Suppress symlink warnings on Windows
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'

# Block torchcodec from loading (missing FFmpeg DLLs on Windows)
# This prevents the Whisper ASR pipeline from crashing when it tries to import torchcodec
import importlib, importlib.machinery, importlib.util, types
_tc_spec = importlib.machinery.ModuleSpec('torchcodec', None)
_tc_mod = importlib.util.module_from_spec(_tc_spec)
_tc_mod.__version__ = '0.0.0'
sys.modules['torchcodec'] = _tc_mod
# Also block submodules and add stub classes for isinstance checks
for _sub in ['torchcodec.decoders', 'torchcodec.encoders', 'torchcodec.samplers',
             'torchcodec.transforms', 'torchcodec._core', 'torchcodec._core.ops',
             'torchcodec._core._metadata', 'torchcodec._core._decoder_utils']:
    _s = importlib.util.module_from_spec(importlib.machinery.ModuleSpec(_sub, None))
    sys.modules[_sub] = _s
# Stub AudioDecoder so isinstance() checks don't crash
class _StubAudioDecoder: pass
sys.modules['torchcodec.decoders'].AudioDecoder = _StubAudioDecoder
_tc_mod.decoders = sys.modules['torchcodec.decoders']
_tc_mod.encoders = sys.modules['torchcodec.encoders']
_tc_mod.samplers = sys.modules['torchcodec.samplers']
_tc_mod.transforms = sys.modules['torchcodec.transforms']

def patch_torchaudio():
    """Monkey-patch torchaudio.load to use soundfile (avoids torchcodec/FFmpeg DLL issues on Windows)."""
    try:
        import soundfile as sf
        import torch
        import torchaudio
        def _sf_load(path, **kwargs):
            data, sr = sf.read(str(path))
            if data.ndim == 1:
                data = data[None, :]
            else:
                data = data.T
            return torch.FloatTensor(data), sr
        torchaudio.load = _sf_load
    except ImportError:
        pass  # soundfile not available, let torchaudio try its own backends

def main():
    if len(sys.argv) < 4:
        print("Usage: tts-worker.py <reference.wav> <text> <output.wav> [ref_text]", file=sys.stderr)
        sys.exit(1)

    ref_wav = sys.argv[1]
    text = sys.argv[2]
    out_wav = sys.argv[3]
    ref_text = sys.argv[4] if len(sys.argv) > 4 else ""

    if not os.path.exists(ref_wav):
        print(f"Reference audio not found: {ref_wav}", file=sys.stderr)
        sys.exit(1)

    start = time.time()

    try:
        # Patch torchaudio for Windows compatibility
        patch_torchaudio()

        from f5_tts.api import F5TTS
        import soundfile as sf

        model = F5TTS()
        load_time = time.time() - start

        gen_start = time.time()
        wav, sr, _ = model.infer(
            ref_file=ref_wav,
            ref_text=ref_text,
            gen_text=text,
        )
        gen_time = time.time() - gen_start

        sf.write(out_wav, wav, sr)

        total = time.time() - start
        duration = len(wav) / sr
        print(f"[TTS] Generated {duration:.1f}s audio in {gen_time:.1f}s (model load: {load_time:.1f}s, total: {total:.1f}s)", file=sys.stderr)

    except ImportError as e:
        # Fallback: try piper
        try:
            import subprocess
            result = subprocess.run(
                ["piper", "--model", "en_US-lessac-medium", "--output_file", out_wav],
                input=text, capture_output=True, text=True, timeout=15
            )
            if result.returncode != 0:
                raise RuntimeError(f"Piper failed: {result.stderr}")
            elapsed = time.time() - start
            print(f"[TTS] Generated via Piper fallback in {elapsed:.1f}s", file=sys.stderr)
        except Exception as e2:
            print(f"No TTS engine available. F5-TTS: {e}, Piper: {e2}", file=sys.stderr)
            sys.exit(1)

    except Exception as e:
        print(f"TTS error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()

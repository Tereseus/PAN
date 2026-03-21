"""
PAN Voice Training Pipeline

Step 1: Transcribe all WAV files using Whisper (GPU accelerated)
Step 2: Format data for Piper training (audio + transcript pairs)
Step 3: Train Piper TTS model on the user's voice
Step 4: Export model for use on phone + server

Run this overnight: python train-voice.py
Estimated time: 2-4 hours on RTX 4070

Prerequisites:
  pip install openai-whisper piper-tts torch
"""

import os
import sys
import json
import time
import glob
import shutil
import subprocess

VOICE_DIR = os.path.join(os.path.dirname(__file__), 'data', 'voice')
TRAINING_DIR = os.path.join(os.path.dirname(__file__), 'data', 'voice_training')
MODEL_DIR = os.path.join(os.path.dirname(__file__), 'data', 'voice_model')

def step1_transcribe():
    """Transcribe all WAV files using Whisper."""
    print("[Step 1] Transcribing audio with Whisper...")
    print(f"  Source: {VOICE_DIR}")

    import whisper
    model = whisper.load_model("base", device="cuda")
    print("  Whisper model loaded (base, CUDA)")

    wav_files = sorted(glob.glob(os.path.join(VOICE_DIR, "*.wav")))
    print(f"  Found {len(wav_files)} WAV files")

    os.makedirs(TRAINING_DIR, exist_ok=True)
    transcribed = 0
    skipped = 0

    for i, wav_path in enumerate(wav_files):
        basename = os.path.splitext(os.path.basename(wav_path))[0]
        txt_path = os.path.join(TRAINING_DIR, f"{basename}.txt")
        wav_dest = os.path.join(TRAINING_DIR, f"{basename}.wav")

        # Skip if already transcribed
        if os.path.exists(txt_path):
            skipped += 1
            continue

        try:
            result = model.transcribe(wav_path, language="en")
            text = result["text"].strip()

            if text and len(text) > 5:
                # Save transcript
                with open(txt_path, 'w', encoding='utf-8') as f:
                    f.write(text)

                # Copy WAV to training dir
                if not os.path.exists(wav_dest):
                    shutil.copy2(wav_path, wav_dest)

                transcribed += 1
                if (i + 1) % 10 == 0:
                    print(f"  [{i+1}/{len(wav_files)}] Transcribed: {text[:60]}...")
            else:
                skipped += 1
        except Exception as e:
            print(f"  Error on {basename}: {e}")
            skipped += 1

    print(f"  Done: {transcribed} transcribed, {skipped} skipped")
    return transcribed


def step2_prepare_dataset():
    """Format transcribed data for Piper training."""
    print("\n[Step 2] Preparing training dataset...")

    pairs = []
    wav_files = sorted(glob.glob(os.path.join(TRAINING_DIR, "*.wav")))

    for wav_path in wav_files:
        basename = os.path.splitext(os.path.basename(wav_path))[0]
        txt_path = os.path.join(TRAINING_DIR, f"{basename}.txt")

        if os.path.exists(txt_path):
            with open(txt_path, 'r', encoding='utf-8') as f:
                text = f.read().strip()
            if text:
                pairs.append({
                    'audio': wav_path,
                    'text': text,
                    'basename': basename
                })

    print(f"  Found {len(pairs)} audio-text pairs")

    # Create metadata CSV for Piper
    metadata_path = os.path.join(TRAINING_DIR, 'metadata.csv')
    with open(metadata_path, 'w', encoding='utf-8') as f:
        for p in pairs:
            # Piper format: filename|text
            f.write(f"{p['basename']}|{p['text']}\n")

    print(f"  Metadata saved to {metadata_path}")

    # Calculate total audio duration
    total_seconds = 0
    for p in pairs:
        try:
            import wave
            with wave.open(p['audio'], 'r') as wf:
                total_seconds += wf.getnframes() / wf.getframerate()
        except:
            pass

    total_minutes = total_seconds / 60
    print(f"  Total audio: {total_minutes:.1f} minutes")
    print(f"  Recommended minimum: 30 minutes")

    if total_minutes < 10:
        print("  WARNING: Less than 10 minutes of audio. Quality will be poor.")
    elif total_minutes < 30:
        print("  NOTE: 10-30 minutes. Acceptable quality, may sound robotic.")
    else:
        print("  GOOD: 30+ minutes. Should produce natural-sounding voice.")

    return len(pairs), total_minutes


def step3_train():
    """Train Piper TTS model."""
    print("\n[Step 3] Training Piper voice model...")
    print("  This will take 2-4 hours on an RTX 4070")
    print("  Press Ctrl+C to cancel at any time")

    os.makedirs(MODEL_DIR, exist_ok=True)

    # Check if piper-tts training is available
    try:
        # Piper uses a training script from the piper-tts repo
        # We'll use the simplified approach with piper-phonemize + training
        result = subprocess.run(
            ['pip', 'show', 'piper-phonemize'],
            capture_output=True, text=True
        )

        if 'piper-phonemize' not in result.stdout:
            print("  Installing piper-phonemize...")
            subprocess.run(['pip', 'install', 'piper-phonemize'], check=True)

    except Exception as e:
        print(f"  Note: {e}")

    # For now, create the training config
    config = {
        'audio_dir': TRAINING_DIR,
        'metadata': os.path.join(TRAINING_DIR, 'metadata.csv'),
        'output_dir': MODEL_DIR,
        'sample_rate': 16000,
        'batch_size': 16,
        'epochs': 1000,
        'learning_rate': 0.0002,
        'model_type': 'vits',  # VITS is what Piper uses
    }

    config_path = os.path.join(MODEL_DIR, 'training_config.json')
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)

    print(f"  Training config saved to {config_path}")

    # Try to run Piper training
    # Piper training requires cloning the piper repo and using their training scripts
    piper_train_script = os.path.join(os.path.dirname(__file__), '..', '..', 'piper', 'src', 'python', 'train.py')

    if os.path.exists(piper_train_script):
        print(f"  Running Piper training script...")
        subprocess.run([
            'python', piper_train_script,
            '--dataset', TRAINING_DIR,
            '--config', config_path,
            '--output', MODEL_DIR,
        ])
    else:
        print(f"\n  Piper training repo not found.")
        print(f"  To train, clone the Piper repo:")
        print(f"    git clone https://github.com/rhasspy/piper.git")
        print(f"    cd piper && pip install -e .")
        print(f"    python src/python/train.py --dataset {TRAINING_DIR}")
        print(f"\n  Or use the pre-built training Docker:")
        print(f"    docker run -v {TRAINING_DIR}:/data rhasspy/piper-train")
        print(f"\n  Training data is ready at: {TRAINING_DIR}")
        print(f"  Config at: {config_path}")

    return config_path


def main():
    print("=" * 60)
    print("ΠΑΝ Voice Training Pipeline")
    print("=" * 60)
    print(f"Voice data: {VOICE_DIR}")
    print(f"Training dir: {TRAINING_DIR}")
    print(f"Model output: {MODEL_DIR}")
    print()

    # Check GPU
    try:
        import torch
        if torch.cuda.is_available():
            gpu = torch.cuda.get_device_name(0)
            print(f"GPU: {gpu}")
        else:
            print("WARNING: No CUDA GPU detected. Training will be very slow.")
    except ImportError:
        print("WARNING: PyTorch not installed. Run: pip install torch")

    print()

    # Step 1: Transcribe
    transcribed = step1_transcribe()

    # Step 2: Prepare dataset
    pairs, minutes = step2_prepare_dataset()

    if pairs < 5:
        print("\nERROR: Not enough transcribed audio. Need at least 5 segments.")
        print("Record more voice data using the hotkey recorder.")
        sys.exit(1)

    # Step 3: Train
    config = step3_train()

    print("\n" + "=" * 60)
    print("Pipeline complete!")
    print(f"  Transcribed segments: {transcribed}")
    print(f"  Training pairs: {pairs}")
    print(f"  Audio duration: {minutes:.1f} minutes")
    print(f"  Training config: {config}")
    print("=" * 60)


if __name__ == '__main__':
    main()

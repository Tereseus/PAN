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


def step2b_setup_dataset():
    """Set up dataset directory structure for Piper preprocessing."""
    print("\n[Step 2b] Setting up Piper dataset structure...")

    # Piper expects: dataset_dir/metadata.csv + dataset_dir/wav/*.wav
    wav_dir = os.path.join(TRAINING_DIR, 'wav')
    os.makedirs(wav_dir, exist_ok=True)

    # Move/link WAVs into wav/ subdirectory
    wav_files = glob.glob(os.path.join(TRAINING_DIR, "*.wav"))
    moved = 0
    for wav_path in wav_files:
        basename = os.path.basename(wav_path)
        dest = os.path.join(wav_dir, basename)
        if not os.path.exists(dest):
            shutil.copy2(wav_path, dest)
            moved += 1

    print(f"  Copied {moved} WAV files to wav/ subdirectory")
    return wav_dir


def step3_train():
    """Train Piper TTS model via Docker with GPU."""
    print("\n[Step 3] Training Piper voice model via Docker...")

    os.makedirs(MODEL_DIR, exist_ok=True)

    # Check Docker is available
    try:
        result = subprocess.run(['docker', '--version'], capture_output=True, text=True)
        if result.returncode != 0:
            print("  ERROR: Docker not found. Install Docker Desktop.")
            return None
        print(f"  {result.stdout.strip()}")
    except FileNotFoundError:
        print("  ERROR: Docker not installed. Install Docker Desktop from https://docker.com")
        return None

    # Check for NVIDIA Docker runtime
    gpu_flag = []
    try:
        result = subprocess.run(['docker', 'info'], capture_output=True, text=True)
        if 'nvidia' in result.stdout.lower() or 'gpu' in result.stdout.lower():
            gpu_flag = ['--gpus', 'all']
            print("  GPU support detected")
        else:
            print("  WARNING: No NVIDIA Docker runtime. Training will be CPU-only (slow).")
            print("  Install nvidia-container-toolkit for GPU training.")
    except:
        pass

    # Convert Windows paths to Docker-compatible paths
    training_dir_docker = TRAINING_DIR.replace('\\', '/')
    model_dir_docker = MODEL_DIR.replace('\\', '/')

    # Step 3a: Preprocess with piper_train.preprocess
    print("\n  [3a] Preprocessing dataset...")
    preprocess_cmd = [
        'docker', 'run', '--rm',
        '-v', f'{training_dir_docker}:/dataset',
        '-v', f'{model_dir_docker}:/output',
    ] + gpu_flag + [
        'rhasspy/piper-train',
        'python3', '-m', 'piper_train.preprocess',
        '--language', 'en-us',
        '--input-dir', '/dataset',
        '--output-dir', '/output',
        '--dataset-format', 'ljspeech',
        '--single-speaker',
        '--sample-rate', '16000',
    ]

    print(f"  Running: {' '.join(preprocess_cmd)}")
    result = subprocess.run(preprocess_cmd, timeout=600)
    if result.returncode != 0:
        print("  ERROR: Preprocessing failed.")
        return None
    print("  Preprocessing complete.")

    # Step 3b: Download base checkpoint for fine-tuning (much better than from scratch)
    checkpoint_dir = os.path.join(MODEL_DIR, 'checkpoints')
    os.makedirs(checkpoint_dir, exist_ok=True)
    base_checkpoint = os.path.join(checkpoint_dir, 'en_US-lessac-medium.ckpt')

    if not os.path.exists(base_checkpoint):
        print("\n  [3b] Downloading base voice checkpoint for fine-tuning...")
        try:
            import urllib.request
            url = 'https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/en/en_US/lessac/medium/epoch%3D2164-step%3D1355540.ckpt'
            print(f"  Downloading from huggingface (~200MB)...")
            urllib.request.urlretrieve(url, base_checkpoint)
            print(f"  Downloaded to {base_checkpoint}")
        except Exception as e:
            print(f"  WARNING: Could not download checkpoint: {e}")
            print("  Training from scratch instead (lower quality, takes longer).")
            base_checkpoint = None
    else:
        print(f"\n  [3b] Using existing checkpoint: {base_checkpoint}")

    # Step 3c: Train
    print("\n  [3c] Training... (this takes 2-4 hours on RTX 4070)")
    print("  Press Ctrl+C to cancel at any time.")

    train_cmd = [
        'docker', 'run', '--rm',
        '-v', f'{model_dir_docker}:/output',
    ] + gpu_flag + [
        'rhasspy/piper-train',
        'python3', '-m', 'piper_train',
        '--dataset-dir', '/output',
        '--accelerator', 'gpu' if gpu_flag else 'cpu',
        '--devices', '1',
        '--batch-size', '16',
        '--validation-split', '0.0',
        '--num-test-examples', '0',
        '--max_epochs', '2000',
        '--checkpoint-epochs', '100',
        '--precision', '32',
    ]

    if base_checkpoint and os.path.exists(base_checkpoint):
        train_cmd.extend([
            '--resume_from_checkpoint', '/output/checkpoints/en_US-lessac-medium.ckpt',
        ])

    print(f"  Running: {' '.join(train_cmd)}")
    result = subprocess.run(train_cmd, timeout=14400)  # 4 hour timeout
    if result.returncode != 0:
        print("  ERROR: Training failed or was cancelled.")
        return None

    print("  Training complete!")

    # Step 3d: Export to ONNX
    print("\n  [3d] Exporting model to ONNX...")
    # Find the latest checkpoint
    ckpt_pattern = os.path.join(MODEL_DIR, 'lightning_logs', 'version_*', 'checkpoints', '*.ckpt')
    ckpts = sorted(glob.glob(ckpt_pattern))
    if not ckpts:
        print("  ERROR: No checkpoints found after training.")
        return None

    latest_ckpt = ckpts[-1]
    onnx_path = os.path.join(MODEL_DIR, 'pan-voice.onnx')
    latest_ckpt_docker = latest_ckpt.replace('\\', '/').replace(MODEL_DIR.replace('\\', '/'), '/output')

    export_cmd = [
        'docker', 'run', '--rm',
        '-v', f'{model_dir_docker}:/output',
    ] + gpu_flag + [
        'rhasspy/piper-train',
        'python3', '-m', 'piper_train.export_onnx',
        latest_ckpt_docker,
        '/output/pan-voice.onnx',
    ]

    print(f"  Exporting {latest_ckpt}")
    result = subprocess.run(export_cmd, timeout=300)
    if result.returncode != 0:
        print("  ERROR: Export failed.")
        return None

    # Copy config alongside ONNX
    config_src = os.path.join(MODEL_DIR, 'config.json')
    config_dest = os.path.join(MODEL_DIR, 'pan-voice.onnx.json')
    if os.path.exists(config_src):
        shutil.copy2(config_src, config_dest)

    print(f"\n  Voice model exported to: {onnx_path}")
    print(f"  Config: {config_dest}")
    print(f"\n  Test with: echo 'Hello, this is PAN.' | piper -m {onnx_path} --output_file test.wav")

    return onnx_path


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

    # Step 2b: Set up directory structure for Piper
    step2b_setup_dataset()

    # Step 3: Train via Docker
    model_path = step3_train()

    print("\n" + "=" * 60)
    print("Pipeline complete!")
    print(f"  Transcribed segments: {transcribed}")
    print(f"  Training pairs: {pairs}")
    print(f"  Audio duration: {minutes:.1f} minutes")
    if model_path:
        print(f"  Voice model: {model_path}")
    else:
        print("  Training did not complete. Check errors above.")
    print("=" * 60)


if __name__ == '__main__':
    main()

"""
PAN PC Audio Recorder — always-on mic capture for memory + voice training.

Records the PC microphone in 30-second WAV segments.
Stores in service/src/data/audio/ with timestamps.
Pairs with STT transcripts for Piper voice training.
Also serves as PAN's memory of everything said at the computer.

Usage:
  python audio-recorder.py              — start recording
  python audio-recorder.py --device N   — use specific audio device
  python audio-recorder.py --list       — list available devices

Storage: ~1MB/min at 16kHz mono. 8 hours = ~480MB.
Auto-cleans oldest files when exceeding MAX_STORAGE_MB.
"""

import os
import sys
import wave
import json
import time
import struct
import threading

# Try to import pyaudio
try:
    import pyaudio
except ImportError:
    print("ERROR: pyaudio not installed. Run: pip install pyaudio")
    sys.exit(1)

SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK = 1024
SEGMENT_SECONDS = 30
MAX_STORAGE_MB = 2000  # 2GB max, then auto-clean oldest

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data', 'audio')
os.makedirs(DATA_DIR, exist_ok=True)

def list_devices():
    """List available audio input devices."""
    p = pyaudio.PyAudio()
    print("Available input devices:")
    for i in range(p.get_device_count()):
        info = p.get_device_info_by_index(i)
        if info['maxInputChannels'] > 0:
            print(f"  [{i}] {info['name']} (channels: {info['maxInputChannels']}, rate: {int(info['defaultSampleRate'])})")
    p.terminate()

def get_storage_mb():
    """Get total storage used in MB."""
    total = 0
    for f in os.listdir(DATA_DIR):
        if f.endswith('.wav'):
            total += os.path.getsize(os.path.join(DATA_DIR, f))
    return total / (1024 * 1024)

def clean_old_files():
    """Delete oldest WAV files when storage exceeds limit."""
    current_mb = get_storage_mb()
    if current_mb <= MAX_STORAGE_MB:
        return

    files = sorted(
        [f for f in os.listdir(DATA_DIR) if f.endswith('.wav')],
        key=lambda f: os.path.getmtime(os.path.join(DATA_DIR, f))
    )

    freed = 0
    for f in files:
        if current_mb - freed <= MAX_STORAGE_MB * 0.8:
            break
        path = os.path.join(DATA_DIR, f)
        size_mb = os.path.getsize(path) / (1024 * 1024)
        os.remove(path)
        # Also remove matching transcript
        txt = path.replace('.wav', '.txt')
        if os.path.exists(txt):
            os.remove(txt)
        freed += size_mb
        print(f"[Cleanup] Deleted {f} ({size_mb:.1f}MB)")

def record(device_index=None):
    """Start continuous recording."""
    p = pyaudio.PyAudio()

    kwargs = {
        'format': pyaudio.paInt16,
        'channels': CHANNELS,
        'rate': SAMPLE_RATE,
        'input': True,
        'frames_per_buffer': CHUNK,
    }
    if device_index is not None:
        kwargs['input_device_index'] = device_index

    try:
        stream = p.open(**kwargs)
    except Exception as e:
        print(f"ERROR: Could not open audio stream: {e}")
        p.terminate()
        return

    print(f"[PAN Audio] Recording started (16kHz mono, {SEGMENT_SECONDS}s segments)")
    print(f"[PAN Audio] Saving to: {DATA_DIR}")
    print(f"[PAN Audio] Storage: {get_storage_mb():.1f}MB / {MAX_STORAGE_MB}MB")

    segment_count = 0

    try:
        while True:
            # Record one segment
            frames = []
            for _ in range(0, int(SAMPLE_RATE / CHUNK * SEGMENT_SECONDS)):
                try:
                    data = stream.read(CHUNK, exception_on_overflow=False)
                    frames.append(data)
                except Exception:
                    continue

            # Check if there's actually audio (not just silence)
            audio_data = b''.join(frames)
            # Calculate RMS to detect silence
            samples = struct.unpack(f'{len(audio_data)//2}h', audio_data)
            rms = (sum(s*s for s in samples) / len(samples)) ** 0.5

            timestamp = int(time.time() * 1000)
            filename = f"pc_audio_{timestamp}.wav"
            filepath = os.path.join(DATA_DIR, filename)

            # Save WAV file
            with wave.open(filepath, 'w') as wf:
                wf.setnchannels(CHANNELS)
                wf.setsampwidth(p.get_sample_size(pyaudio.paInt16))
                wf.setframerate(SAMPLE_RATE)
                wf.writeframes(audio_data)

            segment_count += 1
            storage = get_storage_mb()

            # Mark if silent (RMS < 100 is basically silence)
            is_silent = rms < 100
            status = "silent" if is_silent else f"audio (RMS={rms:.0f})"

            if segment_count % 10 == 0:  # Log every 5 minutes
                print(f"[PAN Audio] Segment {segment_count}: {status}, storage: {storage:.1f}MB")

            # Auto-clean
            if segment_count % 60 == 0:  # Check every 30 minutes
                clean_old_files()

    except KeyboardInterrupt:
        print("\n[PAN Audio] Stopped")
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()

def get_stats():
    """Return stats as JSON."""
    wav_files = [f for f in os.listdir(DATA_DIR) if f.endswith('.wav')]
    txt_files = [f for f in os.listdir(DATA_DIR) if f.endswith('.txt')]
    total_seconds = len(wav_files) * SEGMENT_SECONDS
    return {
        'segments': len(wav_files),
        'paired': len(txt_files),
        'total_minutes': total_seconds / 60,
        'storage_mb': get_storage_mb(),
        'max_storage_mb': MAX_STORAGE_MB,
        'data_dir': DATA_DIR
    }

if __name__ == '__main__':
    if '--list' in sys.argv:
        list_devices()
    elif '--stats' in sys.argv:
        print(json.dumps(get_stats(), indent=2))
    else:
        device = None
        if '--device' in sys.argv:
            idx = sys.argv.index('--device')
            device = int(sys.argv[idx + 1])
        record(device)

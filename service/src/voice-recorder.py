"""
PAN Voice Recorder — hotkey-triggered recording for voice training.

Records ONLY when the user presses their voice-to-text hotkey (mouse side buttons).
This guarantees every recorded segment is confirmed user speech.

Trigger: XButton1 or XButton2 (mouse side buttons) — same keys that trigger Win+H.
First press = start recording, second press = stop recording.
Or: recording runs while the key is held (toggle mode configurable).

Usage:
  python voice-recorder.py                    — start watching for hotkey
  python voice-recorder.py --device N         — use specific audio device
  python voice-recorder.py --list             — list available devices
  python voice-recorder.py --stats            — show collection stats
"""

import os
import sys
import wave
import json
import time
import struct
import threading

try:
    import pyaudio
except ImportError:
    print("ERROR: pip install pyaudio")
    sys.exit(1)

try:
    from pynput import mouse as pynput_mouse
except ImportError:
    print("ERROR: pip install pynput")
    sys.exit(1)

SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK = 1024
SEGMENT_SECONDS = 30
MAX_STORAGE_MB = 2000

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data', 'voice')
os.makedirs(DATA_DIR, exist_ok=True)

is_recording = False
record_thread = None
device_index = None
segment_count = 0


def get_storage_mb():
    total = 0
    if os.path.exists(DATA_DIR):
        for f in os.listdir(DATA_DIR):
            if f.endswith('.wav'):
                total += os.path.getsize(os.path.join(DATA_DIR, f))
    return total / (1024 * 1024)


def start_recording():
    global is_recording, record_thread
    if is_recording:
        return
    is_recording = True
    record_thread = threading.Thread(target=_record_loop, daemon=True)
    record_thread.start()
    print(f"[Voice] ● RECORDING ({time.strftime('%H:%M:%S')})")


def stop_recording():
    global is_recording
    if not is_recording:
        return
    is_recording = False
    print(f"[Voice] ○ Stopped ({time.strftime('%H:%M:%S')})")


def _record_loop():
    global is_recording, segment_count
    pa = pyaudio.PyAudio()

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
        stream = pa.open(**kwargs)
    except Exception as e:
        print(f"[Voice] Audio error: {e}")
        is_recording = False
        pa.terminate()
        return

    while is_recording:
        frames = []
        for _ in range(int(SAMPLE_RATE / CHUNK * SEGMENT_SECONDS)):
            if not is_recording:
                break
            try:
                data = stream.read(CHUNK, exception_on_overflow=False)
                frames.append(data)
            except Exception:
                continue

        if frames:
            audio_data = b''.join(frames)
            samples = struct.unpack(f'{len(audio_data)//2}h', audio_data)
            rms = (sum(s*s for s in samples) / len(samples)) ** 0.5

            if rms > 100:
                timestamp = int(time.time() * 1000)
                filepath = os.path.join(DATA_DIR, f"voice_{timestamp}.wav")
                with wave.open(filepath, 'w') as wf:
                    wf.setnchannels(CHANNELS)
                    wf.setsampwidth(pa.get_sample_size(pyaudio.paInt16))
                    wf.setframerate(SAMPLE_RATE)
                    wf.writeframes(audio_data)
                segment_count += 1
                secs = len(audio_data) / 2 / SAMPLE_RATE
                print(f"[Voice] Saved segment {segment_count} ({secs:.0f}s, RMS={rms:.0f})")

    stream.stop_stream()
    stream.close()
    pa.terminate()


def on_hotkey():
    """Toggle recording on mouse side button press."""
    global is_recording
    if is_recording:
        stop_recording()
    else:
        start_recording()


def get_stats():
    wav_files = [f for f in os.listdir(DATA_DIR) if f.endswith('.wav')] if os.path.exists(DATA_DIR) else []
    total_secs = 0
    for f in wav_files:
        try:
            size = os.path.getsize(os.path.join(DATA_DIR, f)) - 44
            total_secs += size / 2 / SAMPLE_RATE
        except:
            pass
    return {
        'segments': len(wav_files),
        'total_minutes': round(total_secs / 60, 1),
        'storage_mb': round(get_storage_mb(), 1),
        'data_dir': DATA_DIR
    }


if __name__ == '__main__':
    if '--list' in sys.argv:
        pa = pyaudio.PyAudio()
        print("Available input devices:")
        for i in range(pa.get_device_count()):
            info = pa.get_device_info_by_index(i)
            if info['maxInputChannels'] > 0:
                print(f"  [{i}] {info['name']}")
        pa.terminate()
        sys.exit(0)

    if '--stats' in sys.argv:
        print(json.dumps(get_stats(), indent=2))
        sys.exit(0)

    if '--device' in sys.argv:
        device_index = int(sys.argv[sys.argv.index('--device') + 1])

    print("[Voice] PAN Voice Recorder — Hotkey Triggered")
    print(f"[Voice] Device: {device_index or 'default (HyperX SoloCast)'}")
    print(f"[Voice] Data: {DATA_DIR}")
    print(f"[Voice] Storage: {get_storage_mb():.1f}MB / {MAX_STORAGE_MB}MB")
    print("[Voice] Trigger: Mouse side buttons (XButton1 / XButton2)")
    print("[Voice] Press mouse side button to start/stop recording")
    print("[Voice] Press Ctrl+C to exit")
    print()

    # Watch for mouse side buttons using pynput (no admin required)
    def on_click(x, y, button, pressed):
        if pressed and button in (pynput_mouse.Button.x1, pynput_mouse.Button.x2):
            on_hotkey()

    listener = pynput_mouse.Listener(on_click=on_click)
    listener.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        stop_recording()
        listener.stop()
        print("\n[Voice] Exited")

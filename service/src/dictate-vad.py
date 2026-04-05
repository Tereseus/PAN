#!/usr/bin/env python3
"""PAN Dictation with VAD — Records until 3 seconds of silence, then transcribes.
Press button → starts listening → speaks → 3s silence → auto-stops → transcribes → outputs text.
Returns JSON: {"text": "..."} or {"error": "..."}
"""
import sys
import os
import json
import time
import tempfile
import wave

SILENCE_THRESHOLD = 150    # RMS below this = silence (very low to avoid premature stops)
SILENCE_DURATION = float(os.environ.get('WHISPER_SILENCE', '2.5'))  # Configurable via env
MAX_DURATION = 300         # 5 minutes max recording
SAMPLE_RATE = 16000
CHANNELS = 1

def get_rms(data):
    """Calculate RMS (volume level) of audio chunk."""
    import numpy as np
    if len(data) == 0:
        return 0
    return int(np.sqrt(np.mean(data.astype(float) ** 2)))

def record_until_silence():
    """Record audio, stop after SILENCE_DURATION seconds of silence."""
    import sounddevice as sd
    import numpy as np

    chunk_size = int(SAMPLE_RATE * 0.1)  # 100ms chunks
    frames = []
    silence_start = None
    has_speech = False
    start_time = time.time()

    def callback(indata, frame_count, time_info, status):
        nonlocal silence_start, has_speech
        frames.append(indata.copy())
        rms = get_rms(indata)

        if rms > SILENCE_THRESHOLD:
            has_speech = True
            silence_start = None
        else:
            if has_speech and silence_start is None:
                silence_start = time.time()

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS,
                       dtype='int16', callback=callback,
                       blocksize=chunk_size):
        # Wait for speech to start (max 10 seconds)
        while not has_speech:
            time.sleep(0.05)
            if time.time() - start_time > 10:
                return None  # No speech detected in 10 seconds

        # Record until silence or manual stop
        stop_file = os.path.join(tempfile.gettempdir(), 'pan_dictate.wav.stop')
        while True:
            time.sleep(0.05)
            elapsed = time.time() - start_time
            if elapsed >= MAX_DURATION:
                break
            # Check for manual stop signal
            if os.path.exists(stop_file):
                try:
                    os.remove(stop_file)
                except:
                    pass
                break
            if silence_start and (time.time() - silence_start) >= SILENCE_DURATION:
                break

    if not frames:
        return None

    return np.concatenate(frames)

def transcribe(wav_path):
    """Send to PAN Whisper server (pre-loaded model, instant response)."""
    import urllib.request
    req = urllib.request.Request(
        'http://127.0.0.1:7782/',
        data=json.dumps({"wav_path": wav_path}).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        return result.get("text", "")

def main():
    try:
        import sounddevice as sd
        import numpy as np
    except ImportError:
        os.system(f'{sys.executable} -m pip install sounddevice numpy --quiet')

    # Record
    audio = record_until_silence()
    if audio is None:
        print(json.dumps({"error": "No speech detected"}))
        return

    # Save WAV (keep file for server to read — server doesn't delete it)
    wav_path = os.path.join(tempfile.gettempdir(), 'pan_dictate.wav')
    import numpy as np
    with wave.open(wav_path, 'w') as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio.tobytes())

    duration = len(audio) / SAMPLE_RATE

    # Transcribe with Whisper
    try:
        t0 = time.time()
        text = transcribe(wav_path)
        transcribe_time = round(time.time() - t0, 1)
        # Check for trigger word "over" — strip it and signal auto-send
        action = None
        if text.lower().rstrip(' .!?').endswith('over'):
            text = text[:text.lower().rstrip(' .!?').rfind('over')].rstrip(' ,.')
            action = 'send'
        result = {"text": text, "duration": round(duration, 1), "transcribe_seconds": transcribe_time}
        if action:
            result["action"] = action
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": f"Transcription failed: {str(e)}"}))
    finally:
        try:
            os.remove(wav_path)
        except:
            pass

if __name__ == '__main__':
    main()

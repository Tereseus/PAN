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

# RMS below this counts as silence. A FIXED value cannot suit a room whose
# noise floor moves: too high and quiet speech reads as silence (cutting you off
# mid-sentence), too low and background noise keeps the recording alive. So the
# first CAL_SECONDS of every run measure the actual room, and the threshold is
# set from that. WHISPER_THRESHOLD pins it to a fixed number if you prefer.
_FIXED_THRESHOLD = int(os.environ.get('WHISPER_THRESHOLD', '0')) or None
CAL_SECONDS = float(os.environ.get('WHISPER_CALIBRATE', '0.5'))
NOISE_MULT = float(os.environ.get('WHISPER_NOISE_MULT', '1.7'))
MIN_THRESHOLD = 60
SILENCE_THRESHOLD = _FIXED_THRESHOLD or 150      # provisional until calibrated

# 1.4s was shorter than a normal pause for thought and ended sentences early.
SILENCE_DURATION = float(os.environ.get('WHISPER_SILENCE', '2.5'))

# shared VAD state: calibration samples and the live threshold
_vad = {"thresh": SILENCE_THRESHOLD, "cal": [], "ready": _FIXED_THRESHOLD is not None}
MAX_DURATION = 300         # 5 minutes max recording
SAMPLE_RATE = 16000
CHANNELS = 1


def pick_mic():
    """Which input device to record from.

    The Windows default input on this laptop resolves to the built-in Intel
    microphone array, which sits behind a closed lid and hears nothing - that
    produced a silent recording and "No speech detected" every time. So prefer
    the desk mic by name instead, and leave the SYSTEM default alone so Discord
    and games are unaffected.

    PAN_MIC overrides: either a device index, or a substring of its name.
    Returns None to fall back to the system default if nothing matches.
    """
    want = os.environ.get('PAN_MIC', 'HyperX')
    try:
        import sounddevice as _sd
        if want.isdigit():
            return int(want)
        for idx, dev in enumerate(_sd.query_devices()):
            if dev.get('max_input_channels', 0) > 0 and want.lower() in dev.get('name', '').lower():
                return idx
    except Exception:
        pass
    return None

def get_rms(data):
    """Calculate RMS (volume level) of audio chunk."""
    import numpy as np
    if len(data) == 0:
        return 0
    return int(np.sqrt(np.mean(data.astype(float) ** 2)))

PARTIAL_FILE = os.path.join(tempfile.gettempdir(), 'pan_voice_partial.txt')

def push_partial(text):
    """Push partial transcription to dashboard AND temp file for AHK tooltip."""
    # Write temp file for AHK tooltip display
    try:
        with open(PARTIAL_FILE, 'w', encoding='utf-8') as f:
            f.write(text)
    except:
        pass
    # POST to PAN server to broadcast to dashboard input box
    try:
        import urllib.request
        data = json.dumps({"text": text, "partial": True}).encode('utf-8')
        req = urllib.request.Request(
            'http://127.0.0.1:7777/api/v1/voice/result',
            data=data,
            headers={'Content-Type': 'application/json'}
        )
        urllib.request.urlopen(req, timeout=2)
    except:
        pass

def transcribe_partial(frames_snapshot):
    """Transcribe current audio buffer and push to dashboard."""
    import numpy as np
    if not frames_snapshot:
        return ""
    audio = np.concatenate(frames_snapshot)
    tmp = os.path.join(tempfile.gettempdir(), 'pan_dictate_partial.wav')
    try:
        with wave.open(tmp, 'w') as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(audio.tobytes())
        text = transcribe(tmp)
        return text
    except:
        return ""
    finally:
        try:
            os.remove(tmp)
        except:
            pass

def record_until_silence():
    """Record audio, stop after SILENCE_DURATION seconds of silence.
    Streams partial transcriptions to dashboard every ~2s for real-time display."""
    import sounddevice as sd
    import numpy as np
    import threading

    chunk_size = int(SAMPLE_RATE * 0.1)  # 100ms chunks
    frames = []
    silence_start = None
    has_speech = False
    start_time = time.time()
    last_partial_time = 0
    PARTIAL_INTERVAL = 2.0  # Transcribe partials every 2 seconds
    last_partial_len = 0  # Track frames length at last partial

    def callback(indata, frame_count, time_info, status):
        nonlocal silence_start, has_speech
        frames.append(indata.copy())
        rms = get_rms(indata)

        # Spend the first CAL_SECONDS listening to the room, then set the
        # threshold from the measured noise floor rather than a fixed guess.
        if not _vad["ready"]:
            _vad["cal"].append(rms)
            if len(_vad["cal"]) * (len(indata) / SAMPLE_RATE) >= CAL_SECONDS:
                import statistics
                floor = statistics.median(_vad["cal"]) if _vad["cal"] else 0
                _vad["thresh"] = max(MIN_THRESHOLD, int(floor * NOISE_MULT))
                _vad["ready"] = True
                print("[vad] noise floor %d -> threshold %d" % (floor, _vad["thresh"]),
                      file=sys.stderr, flush=True)
            return

        if rms > _vad["thresh"]:
            has_speech = True
            silence_start = None
        else:
            if has_speech and silence_start is None:
                silence_start = time.time()

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS,
                       dtype='int16', callback=callback,
                       blocksize=chunk_size, device=pick_mic()):
        # Wait for speech to start (max 10 seconds)
        while not has_speech:
            time.sleep(0.05)
            if time.time() - start_time > 10:
                return None  # No speech detected in 10 seconds

        last_partial_time = time.time()

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

            # Stream partial transcription every PARTIAL_INTERVAL seconds
            now = time.time()
            if now - last_partial_time >= PARTIAL_INTERVAL and len(frames) > last_partial_len:
                last_partial_time = now
                last_partial_len = len(frames)
                snapshot = list(frames)  # Copy current frames
                # Run partial transcription in background thread
                threading.Thread(target=lambda s=snapshot: push_partial(transcribe_partial(s)), daemon=True).start()

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

def play_sound(name):
    """Play start/stop WAV sound synchronously — must finish before recording starts."""
    try:
        import sounddevice as sd
        import numpy as np
        sound_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bin', 'sounds')
        wav_file = os.path.join(sound_dir, f'voice-{name}.wav')
        if not os.path.exists(wav_file):
            return
        with wave.open(wav_file, 'r') as wf:
            data = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
            if wf.getnchannels() == 2:
                data = data.reshape(-1, 2)
            sd.play(data, samplerate=wf.getframerate())
            sd.wait()
    except:
        pass

def main():
    try:
        import sounddevice as sd
        import numpy as np
    except ImportError:
        os.system(f'{sys.executable} -m pip install sounddevice numpy --quiet')

    # Play sounds unless --no-sounds flag passed (AHK plays its own)
    own_sounds = '--no-sounds' not in sys.argv

    if own_sounds:
        play_sound('start')

    # Record
    audio = record_until_silence()
    if audio is None:
        print(json.dumps({"error": "No speech detected"}))
        return

    if own_sounds:
        play_sound('stop')

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
        stripped = text.lower().rstrip(' .!?,')
        if stripped.endswith(' over') or stripped == 'over':
            # Remove "over" from end
            idx = text.lower().rfind('over')
            if idx >= 0:
                text = text[:idx].rstrip(' ,.')
            action = 'send'
        result = {"text": text, "duration": round(duration, 1), "transcribe_seconds": transcribe_time}
        if action:
            result["action"] = action
        # Push final result to dashboard
        try:
            import urllib.request
            payload = json.dumps({"text": text, "partial": False, "action": action or ""}).encode('utf-8')
            req = urllib.request.Request(
                'http://127.0.0.1:7777/api/v1/voice/result',
                data=payload,
                headers={'Content-Type': 'application/json'}
            )
            urllib.request.urlopen(req, timeout=2)
        except:
            pass
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

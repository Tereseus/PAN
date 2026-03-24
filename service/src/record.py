#!/usr/bin/env python3
"""PAN Record — Record from mic until a stop file appears or max duration.
Usage: python record.py <output_wav> [max_seconds]
Creates a .recording flag file while recording. Delete it or create a .stop file to stop.
"""
import sys
import os
import time
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: record.py <output.wav> [max_seconds]"}))
        return

    output_path = sys.argv[1]
    max_duration = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    stop_file = output_path + '.stop'

    try:
        import sounddevice as sd
        import numpy as np
    except ImportError:
        os.system(f'{sys.executable} -m pip install sounddevice numpy --quiet')
        import sounddevice as sd
        import numpy as np

    sample_rate = 16000
    channels = 1
    chunk_size = int(sample_rate * 0.1)  # 100ms chunks
    frames = []

    # Signal that we're recording
    flag_file = output_path + '.recording'
    with open(flag_file, 'w') as f:
        f.write('recording')

    # Clean up any old stop file
    if os.path.exists(stop_file):
        os.remove(stop_file)

    start_time = time.time()

    def callback(indata, frame_count, time_info, status):
        frames.append(indata.copy())

    try:
        with sd.InputStream(samplerate=sample_rate, channels=channels,
                           dtype='int16', callback=callback,
                           blocksize=chunk_size):
            while True:
                time.sleep(0.05)
                elapsed = time.time() - start_time
                if elapsed >= max_duration:
                    break
                if os.path.exists(stop_file):
                    os.remove(stop_file)
                    break
                if not os.path.exists(flag_file):
                    break
    except Exception as e:
        print(json.dumps({"error": f"Recording failed: {str(e)}"}))
        return
    finally:
        # Clean up flag
        if os.path.exists(flag_file):
            os.remove(flag_file)

    if not frames:
        print(json.dumps({"error": "No audio recorded"}))
        return

    # Save as WAV
    import wave
    audio = np.concatenate(frames)
    with wave.open(output_path, 'w') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio.tobytes())

    duration = len(audio) / sample_rate
    print(json.dumps({"ok": True, "file": output_path, "duration": round(duration, 1)}))

if __name__ == '__main__':
    main()

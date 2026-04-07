#!/usr/bin/env python3
"""PAN Whisper Server — Batch-only transcription with faster-whisper.

Batch mode only — no streaming, no duplication possible.
  1. HTTP GET  / — health check
  2. HTTP POST / — batch transcription (send wav_path, get text back)
  3. WebSocket  — record audio, on stop transcribe entire clip at once

Model: base (good accuracy/speed balance, ~1.5s transcription for 30s audio on GPU)
"""
import json
import time
import os
import sys
import asyncio
import tempfile
import wave
import threading

# --- Model Loading ---
print("[PAN Whisper] Loading model...", flush=True)
t0 = time.time()
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get('WHISPER_MODEL', 'base')
model = WhisperModel(MODEL_SIZE, device="cuda", compute_type="float16")
print(f"[PAN Whisper] Model loaded in {time.time()-t0:.1f}s ({MODEL_SIZE})", flush=True)

# --- Configuration ---
PORT = int(os.environ.get('WHISPER_PORT', 7782))
TRIGGER_WORDS = {
    'over': 'send',
    'cancel': 'cancel',
    'scratch that': 'delete',
}

def transcribe_file(path, language="en"):
    """Transcribe a file and return text + timing."""
    t0 = time.time()
    segments, _ = model.transcribe(path, language=language, vad_filter=True,
                                   vad_parameters=dict(min_silence_duration_ms=300),
                                   repetition_penalty=1.5, no_repeat_ngram_size=4)
    text = " ".join(s.text.strip() for s in segments).strip()
    elapsed = round(time.time() - t0, 2)
    return text, elapsed

def transcribe_buffer(audio_bytes, sample_rate=16000):
    """Transcribe raw PCM16 audio bytes."""
    tmp = os.path.join(tempfile.gettempdir(), f"pan-whisper-{time.time_ns()}.wav")
    try:
        with wave.open(tmp, 'w') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(audio_bytes)
        text, elapsed = transcribe_file(tmp)
        return text, elapsed
    finally:
        try:
            os.remove(tmp)
        except:
            pass

def check_trigger_words(text):
    """Check if text ends with a trigger word. Returns (cleaned_text, action) or (text, None)."""
    stripped = text.rstrip(' .!?,;:')
    lower = stripped.lower()
    words = lower.split()
    if not words:
        return text, None
    last_word = words[-1]
    for trigger, action in TRIGGER_WORDS.items():
        trigger_words = trigger.split()
        if len(trigger_words) == 1:
            if last_word == trigger:
                idx = stripped.lower().rfind(trigger)
                if idx >= 0:
                    cleaned = stripped[:idx].rstrip(' ,.')
                    print(f"[PAN Whisper] Trigger '{trigger}' -> action={action}, cleaned='{cleaned[:50]}'", flush=True)
                    return cleaned, action
        else:
            if words[-len(trigger_words):] == trigger_words:
                idx = stripped.lower().rfind(trigger)
                if idx >= 0:
                    cleaned = stripped[:idx].rstrip(' ,.')
                    print(f"[PAN Whisper] Trigger '{trigger}' -> action={action}", flush=True)
                    return cleaned, action
    return text, None

# --- HTTP Server (batch mode + health check) ---
from http.server import HTTPServer, BaseHTTPRequestHandler

class BatchHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({
            "status": "ok",
            "engine": "faster-whisper",
            "model": MODEL_SIZE,
            "mode": "batch",
        }).encode())

    def do_POST(self):
        import traceback
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        print(f"[PAN Whisper] POST from {self.client_address} len={length} body={json.dumps(body)[:120]}", flush=True)

        wav_path = body.get('wav_path', '')
        if not wav_path or not os.path.exists(wav_path):
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "wav_path required"}).encode())
            return

        text, elapsed = transcribe_file(wav_path)
        cleaned_text, action = check_trigger_words(text)
        print(f"[PAN Whisper] {elapsed}s: {text[:80]}{' [' + action + ']' if action else ''}", flush=True)

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({
            "text": cleaned_text,
            "raw_text": text,
            "seconds": elapsed,
            "action": action,
        }).encode())

# --- WebSocket Server (batch-on-stop mode) ---
async def ws_handler(websocket):
    """Collect audio until client sends stop, then transcribe entire clip at once.

    No streaming partials. No duplication. Just record -> transcribe -> done.
    """
    audio_buffer = bytearray()
    chunk_count = 0
    sample_rate = 16000

    import traceback
    print(f"[PAN Whisper] WS client connected from {websocket.remote_address}", flush=True)
    traceback.print_stack()

    try:
        async for message in websocket:
            if isinstance(message, bytes):
                audio_buffer.extend(message)
                chunk_count += 1

            elif isinstance(message, str):
                try:
                    cmd = json.loads(message)
                    if cmd.get('type') == 'stop':
                        if len(audio_buffer) < 3200:  # < 0.1s of audio
                            await websocket.send(json.dumps({
                                "type": "final",
                                "text": "",
                                "action": None,
                            }))
                            break

                        # Transcribe the entire recording at once
                        print(f"[PAN Whisper] Transcribing {len(audio_buffer)} bytes ({len(audio_buffer)/32000:.1f}s audio)...", flush=True)
                        text, elapsed = await asyncio.get_event_loop().run_in_executor(
                            None, transcribe_buffer, bytes(audio_buffer), sample_rate
                        )

                        if text:
                            cleaned, action = check_trigger_words(text)
                            print(f"[PAN Whisper] Result ({elapsed}s): '{cleaned[:80]}' action={action}", flush=True)
                            await websocket.send(json.dumps({
                                "type": "final",
                                "text": cleaned,
                                "action": action,
                                "elapsed": elapsed,
                            }))
                        else:
                            await websocket.send(json.dumps({
                                "type": "final",
                                "text": "",
                                "action": None,
                            }))
                        break

                    elif cmd.get('type') == 'config':
                        sample_rate = cmd.get('sample_rate', 16000)
                except json.JSONDecodeError:
                    pass
    except Exception as e:
        print(f"[PAN Whisper] WS error: {e}", flush=True)
    finally:
        print(f"[PAN Whisper] WS disconnected ({chunk_count} chunks, {len(audio_buffer)} bytes)", flush=True)

def run_http():
    server = HTTPServer(('127.0.0.1', PORT), BatchHandler)
    print(f"[PAN Whisper] HTTP listening on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()

def run_ws():
    try:
        import websockets
        import websockets.asyncio.server
    except ImportError:
        print("[PAN Whisper] websockets not installed — streaming disabled. Run: pip install websockets", flush=True)
        return

    WS_PORT = PORT + 1  # 7783

    async def serve():
        async with websockets.asyncio.server.serve(ws_handler, "127.0.0.1", WS_PORT):
            print(f"[PAN Whisper] WebSocket listening on ws://127.0.0.1:{WS_PORT}", flush=True)
            await asyncio.Future()

    asyncio.run(serve())

if __name__ == '__main__':
    ws_thread = threading.Thread(target=run_ws, daemon=True)
    ws_thread.start()
    run_http()

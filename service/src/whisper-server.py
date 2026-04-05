#!/usr/bin/env python3
"""PAN Whisper Server — Real-time streaming transcription with faster-whisper.

Two modes:
  1. HTTP POST /  — batch transcription (send wav_path, get full text back)
  2. WebSocket /ws — streaming transcription (send audio chunks, get text back live)

Model stays loaded in GPU memory. Subsequent requests are <500ms.
"""
import json
import time
import os
import sys
import asyncio
import tempfile
import wave
import struct
import threading

# --- Model Loading ---
print("[PAN Whisper] Loading model...", flush=True)
t0 = time.time()
from faster_whisper import WhisperModel

# Use 'small' for better accuracy while staying fast on GPU
# tiny=39M, base=74M, small=244M, medium=769M
MODEL_SIZE = os.environ.get('WHISPER_MODEL', 'small')
model = WhisperModel(MODEL_SIZE, device="cuda", compute_type="float16")
print(f"[PAN Whisper] Model loaded in {time.time()-t0:.1f}s (GPU: cuda, faster-whisper {MODEL_SIZE})", flush=True)

# --- Configuration ---
PORT = int(os.environ.get('WHISPER_PORT', 7782))
SILENCE_SECONDS = float(os.environ.get('WHISPER_SILENCE', 2.5))
TRIGGER_WORDS = {
    'over': 'send',      # "over" at end → auto-send message
    'cancel': 'cancel',  # "cancel" → clear input
    'scratch that': 'delete',  # "scratch that" → delete last sentence
}

def transcribe_file(path, language="en"):
    """Transcribe a file and return text + timing."""
    t0 = time.time()
    segments, _ = model.transcribe(path, language=language, vad_filter=True)
    text = " ".join(s.text.strip() for s in segments).strip()
    elapsed = round(time.time() - t0, 2)
    return text, elapsed

def transcribe_buffer(audio_bytes, sample_rate=16000):
    """Transcribe raw PCM16 audio bytes."""
    tmp = os.path.join(tempfile.gettempdir(), f"pan-ws-{time.time_ns()}.wav")
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
    lower = text.lower().rstrip(' .!?')
    for trigger, action in TRIGGER_WORDS.items():
        if lower.endswith(trigger):
            # Remove the trigger word from the end
            cleaned = text[:len(text) - len(text.rstrip()) + len(text.rstrip()) - len(trigger)].rstrip(' ,.')
            if not cleaned:
                cleaned = ""
            return cleaned, action
    return text, None

# --- HTTP Server (batch mode — backwards compatible) ---
from http.server import HTTPServer, BaseHTTPRequestHandler

class BatchHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}

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

# --- WebSocket Server (streaming mode) ---
async def ws_handler(websocket):
    """Handle a streaming transcription WebSocket connection.

    Client sends:
      - Binary frames: raw audio chunks (PCM16 16kHz mono, or WebM)
      - Text frames: JSON commands {"type": "config", "silence": 2.5} etc.

    Server sends:
      - JSON text frames: {"type": "partial", "text": "..."} or {"type": "final", "text": "...", "action": "send"}
    """
    import io
    audio_buffer = bytearray()
    chunk_count = 0
    last_text = ""
    sample_rate = 16000

    print(f"[PAN Whisper] WS client connected", flush=True)

    try:
        async for message in websocket:
            if isinstance(message, bytes):
                # Audio data — accumulate and transcribe periodically
                audio_buffer.extend(message)
                chunk_count += 1

                # Transcribe every ~1.5 seconds of audio (24000 samples * 2 bytes = 48000 bytes at 16kHz)
                if len(audio_buffer) >= 48000:
                    text, elapsed = transcribe_buffer(bytes(audio_buffer), sample_rate)
                    if text and text != last_text:
                        last_text = text
                        cleaned, action = check_trigger_words(text)
                        await websocket.send(json.dumps({
                            "type": "partial",
                            "text": cleaned,
                            "action": action,
                            "elapsed": elapsed,
                        }))
                        if action == 'send':
                            # Auto-send: send final and close
                            await websocket.send(json.dumps({
                                "type": "final",
                                "text": cleaned,
                                "action": "send",
                            }))
                            break
                    # Keep accumulating (don't clear buffer — retranscribe growing audio for context)

            elif isinstance(message, str):
                # JSON command
                try:
                    cmd = json.loads(message)
                    if cmd.get('type') == 'stop':
                        # Final transcription of full buffer
                        if audio_buffer:
                            text, elapsed = transcribe_buffer(bytes(audio_buffer), sample_rate)
                            cleaned, action = check_trigger_words(text)
                            await websocket.send(json.dumps({
                                "type": "final",
                                "text": cleaned,
                                "raw_text": text,
                                "action": action,
                                "elapsed": elapsed,
                            }))
                        break
                    elif cmd.get('type') == 'config':
                        sample_rate = cmd.get('sample_rate', 16000)
                except json.JSONDecodeError:
                    pass
    except Exception as e:
        print(f"[PAN Whisper] WS error: {e}", flush=True)
    finally:
        print(f"[PAN Whisper] WS client disconnected ({chunk_count} chunks, {len(audio_buffer)} bytes)", flush=True)

def run_http():
    """Run the HTTP batch server."""
    server = HTTPServer(('127.0.0.1', PORT), BatchHandler)
    print(f"[PAN Whisper] HTTP listening on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()

def run_ws():
    """Run the WebSocket streaming server."""
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
            await asyncio.Future()  # run forever

    asyncio.run(serve())

if __name__ == '__main__':
    # Run HTTP in main thread, WebSocket in a separate thread
    ws_thread = threading.Thread(target=run_ws, daemon=True)
    ws_thread.start()
    run_http()

#!/usr/bin/env python3
"""PAN Whisper + Speaker ID Server

Ports:
  :7782  HTTP  — transcribe (POST) + health (GET)
  :7783  WS    — stream audio, transcribe + identify on stop

Speaker ID endpoints (HTTP):
  POST /enroll   { label, wav_path }          → enroll/update a voice print
  POST /identify { wav_path }                 → identify speaker from file
  GET  /speakers                              → list enrolled speakers
  DELETE /speaker { label }                  → remove a voice print

Every transcription response includes:
  { text, speaker_id, speaker_confidence, seconds, action }
"""
import json
import time
import os
import sys
import asyncio
import tempfile
import wave
import threading
import struct

# --- Model Loading ---
print("[PAN Whisper] Loading Whisper model...", flush=True)
t0 = time.time()
from faster_whisper import WhisperModel
MODEL_SIZE = os.environ.get('WHISPER_MODEL', 'base')
model = WhisperModel(MODEL_SIZE, device="cuda", compute_type="float16")
print(f"[PAN Whisper] Whisper loaded in {time.time()-t0:.1f}s ({MODEL_SIZE})", flush=True)

print("[PAN Whisper] Loading speaker encoder...", flush=True)
t0 = time.time()
from resemblyzer import VoiceEncoder, preprocess_wav
from pathlib import Path
import numpy as np
encoder = VoiceEncoder()
print(f"[PAN Whisper] Speaker encoder loaded in {time.time()-t0:.1f}s", flush=True)

# --- Configuration ---
PORT = int(os.environ.get('WHISPER_PORT', 7782))
TRIGGER_WORDS = {
    'over': 'send',
    'cancel': 'cancel',
    'scratch that': 'delete',
}

# In-memory voice print store (loaded from disk/DB on start, written on enroll)
# Structure: { label: np.ndarray(256,) }
PRINTS_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'voice_prints.npz')
_voice_prints = {}  # label -> embedding (256-dim float32)
_prints_lock = threading.Lock()

def load_voice_prints():
    global _voice_prints
    if os.path.exists(PRINTS_FILE):
        try:
            data = np.load(PRINTS_FILE, allow_pickle=False)
            with _prints_lock:
                _voice_prints = {k: data[k] for k in data.files}
            print(f"[PAN Speaker] Loaded {len(_voice_prints)} voice prints: {list(_voice_prints.keys())}", flush=True)
        except Exception as e:
            print(f"[PAN Speaker] Failed to load voice prints: {e}", flush=True)
    else:
        print("[PAN Speaker] No voice prints file yet — enroll speakers to enable ID", flush=True)

def save_voice_prints():
    os.makedirs(os.path.dirname(PRINTS_FILE), exist_ok=True)
    with _prints_lock:
        if _voice_prints:
            np.savez(PRINTS_FILE, **_voice_prints)
        elif os.path.exists(PRINTS_FILE):
            os.remove(PRINTS_FILE)

load_voice_prints()

# --- Whisper helpers ---
def transcribe_file(path, language="en"):
    t0 = time.time()
    segments, _ = model.transcribe(path, language=language, vad_filter=True,
                                   vad_parameters=dict(min_silence_duration_ms=300),
                                   repetition_penalty=1.5, no_repeat_ngram_size=4)
    text = " ".join(s.text.strip() for s in segments).strip()
    return text, round(time.time() - t0, 2)

def transcribe_buffer(audio_bytes, sample_rate=16000):
    tmp = os.path.join(tempfile.gettempdir(), f"pan-whisper-{time.time_ns()}.wav")
    try:
        with wave.open(tmp, 'w') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(audio_bytes)
        return transcribe_file(tmp)
    finally:
        try: os.remove(tmp)
        except: pass

def check_trigger_words(text):
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
                    return stripped[:idx].rstrip(' ,.'), action
        else:
            if words[-len(trigger_words):] == trigger_words:
                idx = stripped.lower().rfind(trigger)
                if idx >= 0:
                    return stripped[:idx].rstrip(' ,.'), action
    return text, None

# --- Speaker ID helpers ---
def get_embedding_from_file(wav_path):
    """Extract 256-dim voice embedding from a wav file."""
    wav = preprocess_wav(Path(wav_path))
    return encoder.embed_utterance(wav)

def get_embedding_from_buffer(audio_bytes, sample_rate=16000):
    """Extract embedding from raw PCM16 bytes."""
    tmp = os.path.join(tempfile.gettempdir(), f"pan-spk-{time.time_ns()}.wav")
    try:
        with wave.open(tmp, 'w') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(audio_bytes)
        return get_embedding_from_file(tmp)
    finally:
        try: os.remove(tmp)
        except: pass

def identify_speaker(embedding, threshold=0.75):
    """
    Compare embedding against enrolled prints.
    Returns (label, confidence) or (None, 0.0) if no match above threshold.
    Cosine similarity: 1.0 = same speaker, 0.0 = different.
    """
    with _prints_lock:
        if not _voice_prints:
            return None, 0.0
        best_label = None
        best_sim = -1.0
        for label, stored in _voice_prints.items():
            # Cosine similarity
            sim = float(np.dot(embedding, stored) / (np.linalg.norm(embedding) * np.linalg.norm(stored) + 1e-9))
            if sim > best_sim:
                best_sim = sim
                best_label = label
    if best_sim >= threshold:
        return best_label, round(best_sim, 3)
    return None, round(best_sim, 3)

def enroll_speaker(label, wav_path_or_embedding, update=True):
    """
    Enroll or update a speaker. If update=True and label exists,
    averages the new embedding with the stored one (online learning).
    """
    if isinstance(wav_path_or_embedding, (str, Path)):
        new_emb = get_embedding_from_file(wav_path_or_embedding)
    else:
        new_emb = wav_path_or_embedding

    with _prints_lock:
        if update and label in _voice_prints:
            # Running average — blend new sample in
            stored = _voice_prints[label]
            blended = (stored + new_emb) / 2.0
            blended /= np.linalg.norm(blended)
            _voice_prints[label] = blended
        else:
            normalized = new_emb / (np.linalg.norm(new_emb) + 1e-9)
            _voice_prints[label] = normalized

    save_voice_prints()
    print(f"[PAN Speaker] Enrolled '{label}' ({len(_voice_prints)} total)", flush=True)

# --- HTTP Server ---
from http.server import HTTPServer, BaseHTTPRequestHandler

class RequestHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_GET(self):
        if self.path == '/speakers' or self.path.startswith('/speakers?'):
            with _prints_lock:
                speakers = list(_voice_prints.keys())
            self.send_json(200, {"speakers": speakers, "count": len(speakers)})
        else:
            # Health check
            self.send_json(200, {
                "status": "ok",
                "engine": "faster-whisper",
                "model": MODEL_SIZE,
                "speaker_id": "resemblyzer",
                "enrolled": len(_voice_prints),
            })

    def do_DELETE(self):
        body = self.read_body()
        label = body.get('label', '').strip()
        if not label:
            return self.send_json(400, {"error": "label required"})
        with _prints_lock:
            removed = label in _voice_prints
            if removed:
                del _voice_prints[label]
        save_voice_prints()
        self.send_json(200, {"removed": removed, "label": label})

    def do_POST(self):
        import traceback
        body = self.read_body()
        path = self.path.split('?')[0]

        # --- Enroll ---
        if path == '/enroll':
            label = body.get('label', '').strip()
            wav_path = body.get('wav_path', '')
            if not label:
                return self.send_json(400, {"error": "label required"})
            if not wav_path or not os.path.exists(wav_path):
                return self.send_json(400, {"error": "wav_path required and must exist"})
            try:
                enroll_speaker(label, wav_path)
                self.send_json(200, {"ok": True, "label": label, "enrolled": len(_voice_prints)})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        # --- Identify only ---
        if path == '/identify':
            wav_path = body.get('wav_path', '')
            if not wav_path or not os.path.exists(wav_path):
                return self.send_json(400, {"error": "wav_path required"})
            try:
                emb = get_embedding_from_file(wav_path)
                speaker_id, confidence = identify_speaker(emb)
                self.send_json(200, {"speaker_id": speaker_id, "confidence": confidence})
            except Exception as e:
                self.send_json(500, {"error": str(e)})
            return

        # --- Transcribe (default POST /) ---
        wav_path = body.get('wav_path', '')
        if not wav_path or not os.path.exists(wav_path):
            return self.send_json(400, {"error": "wav_path required"})

        try:
            # Run whisper + speaker ID in parallel
            text_result = [None, None]
            spk_result = [None, 0.0]

            def do_transcribe():
                text_result[0], text_result[1] = transcribe_file(wav_path)

            def do_identify():
                try:
                    emb = get_embedding_from_file(wav_path)
                    spk_result[0], spk_result[1] = identify_speaker(emb)
                except Exception as e:
                    print(f"[PAN Speaker] Identify error: {e}", flush=True)

            t_thread = threading.Thread(target=do_transcribe)
            s_thread = threading.Thread(target=do_identify)
            t_thread.start(); s_thread.start()
            t_thread.join(); s_thread.join()

            text, elapsed = text_result
            cleaned, action = check_trigger_words(text or '')
            speaker_id, confidence = spk_result

            print(f"[PAN Whisper] {elapsed}s speaker={speaker_id}({confidence}): {cleaned[:80]}", flush=True)
            self.send_json(200, {
                "text": cleaned,
                "raw_text": text,
                "seconds": elapsed,
                "action": action,
                "speaker_id": speaker_id,
                "speaker_confidence": confidence,
            })
        except Exception as e:
            traceback.print_exc()
            self.send_json(500, {"error": str(e)})

# --- WebSocket Server ---
async def ws_handler(websocket):
    audio_buffer = bytearray()
    chunk_count = 0
    sample_rate = 16000
    print(f"[PAN Whisper] WS client connected from {websocket.remote_address}", flush=True)

    try:
        async for message in websocket:
            if isinstance(message, bytes):
                audio_buffer.extend(message)
                chunk_count += 1
            elif isinstance(message, str):
                try:
                    cmd = json.loads(message)
                    if cmd.get('type') == 'stop':
                        if len(audio_buffer) < 3200:
                            await websocket.send(json.dumps({"type": "final", "text": "", "action": None,
                                                             "speaker_id": None, "speaker_confidence": 0.0}))
                            break

                        print(f"[PAN Whisper] Transcribing {len(audio_buffer)} bytes ({len(audio_buffer)/32000:.1f}s)...", flush=True)
                        audio_bytes = bytes(audio_buffer)

                        # Run transcription + speaker ID in parallel
                        loop = asyncio.get_event_loop()
                        text_task = loop.run_in_executor(None, transcribe_buffer, audio_bytes, sample_rate)
                        spk_task  = loop.run_in_executor(None, lambda: _identify_from_buffer(audio_bytes, sample_rate))
                        (text, elapsed), (speaker_id, confidence) = await asyncio.gather(text_task, spk_task)

                        if text:
                            cleaned, action = check_trigger_words(text)
                            print(f"[PAN Whisper] ({elapsed}s) speaker={speaker_id}({confidence}): '{cleaned[:80]}'", flush=True)
                            await websocket.send(json.dumps({
                                "type": "final",
                                "text": cleaned,
                                "action": action,
                                "elapsed": elapsed,
                                "speaker_id": speaker_id,
                                "speaker_confidence": confidence,
                            }))
                        else:
                            await websocket.send(json.dumps({"type": "final", "text": "", "action": None,
                                                             "speaker_id": None, "speaker_confidence": 0.0}))
                        break

                    elif cmd.get('type') == 'config':
                        sample_rate = cmd.get('sample_rate', 16000)
                except json.JSONDecodeError:
                    pass
    except Exception as e:
        print(f"[PAN Whisper] WS error: {e}", flush=True)
    finally:
        print(f"[PAN Whisper] WS disconnected ({chunk_count} chunks, {len(audio_buffer)} bytes)", flush=True)

def _identify_from_buffer(audio_bytes, sample_rate):
    """Thread-safe wrapper for speaker ID from raw PCM."""
    try:
        emb = get_embedding_from_buffer(audio_bytes, sample_rate)
        return identify_speaker(emb)
    except Exception as e:
        print(f"[PAN Speaker] Buffer identify error: {e}", flush=True)
        return None, 0.0

def run_http():
    server = HTTPServer(('127.0.0.1', PORT), RequestHandler)
    print(f"[PAN Whisper] HTTP listening on http://127.0.0.1:{PORT}", flush=True)
    server.serve_forever()

def run_ws():
    try:
        import websockets
        import websockets.asyncio.server
    except ImportError:
        print("[PAN Whisper] websockets not installed — WS disabled", flush=True)
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
